/**
 * @license
 * Copyright 2025 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { fetchOkWithOAuth2CredentialsAdapter } from "#src/credentials_provider/oauth2.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import type {
  DriverReadOptions,
  KvStore,
  ListResponse,
  StatOptions,
  StatResponse,
  ReadResponse,
} from "#src/kvstore/index.js";
import type { SsaCredentialsProvider } from "#src/kvstore/ssa_s3/credentials_provider.js";
import { pipelineUrlJoin } from "#src/kvstore/url.js";
import type { FetchOk } from "#src/util/http_request.js";
import { fetchOk, HttpError } from "#src/util/http_request.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import { MultiConsumerProgressListener, ProgressSpan } from "#src/util/progress_listener.js";

function joinPath(base: string, suffix: string) {
  if (base === "") return suffix;
  if (base.endsWith("/")) return base + suffix;
  return base + "/" + suffix;
}

interface SsaAuthenticateResponse {
  readablePrefixes: string[];
  endpoints: {
    signRequests: string; // path relative to worker origin, e.g. "/sign-requests"
    listFiles: string; // path relative to worker origin, e.g. "/list-files"
  };
}

function parseAuthenticateResponse(json: unknown): SsaAuthenticateResponse {
  const obj = verifyObject(json);
  const endpointsObj = verifyObjectProperty(obj, "endpoints", verifyObject);
  return {
    readablePrefixes: verifyObjectProperty(obj, "readable_prefixes", verifyStringArray),
    endpoints: {
      signRequests: verifyObjectProperty(endpointsObj, "sign_requests", verifyString),
      listFiles: verifyObjectProperty(endpointsObj, "list_files", verifyString),
    },
  };
}

interface SsaSignRequestBody {
  requests: Array<{
    method: "GET" | "HEAD";
    path: string; // key within the SSA-managed bucket
  }>;
}

interface SsaSignRequestsResponse {
  urls: string[]; // Presigned URLs matching the requests order
}

function parseSignRequestsResponse(json: unknown): SsaSignRequestsResponse {
  const obj = verifyObject(json);
  const urls = verifyObjectProperty(obj, "urls", verifyStringArray);
  return { urls };
}

interface SsaListFilesResponse {
  directories: string[];
  entries: string[]; // file paths relative to the requested prefix
}

function parseListFilesResponse(json: unknown): SsaListFilesResponse {
  const obj = verifyObject(json);
  return {
    directories: verifyObjectProperty(obj, "directories", verifyStringArray),
    entries: verifyObjectProperty(obj, "entries", verifyStringArray),
  };
}

export class SsaS3KvStore implements KvStore {
  private readonly fetchOkToWorker: FetchOk;
  private readonly credentialsProvider: SsaCredentialsProvider;
  private readonly workerOrigin: string;
  private readonly datasetBasePrefix: string;
  private readonly displayBaseUrl: string;

  private authenticatePromise: Promise<SsaAuthenticateResponse> | undefined;

  constructor(
    public readonly sharedKvStoreContext: SharedKvStoreContext,
    workerOrigin: string,
    datasetBasePrefix: string,
    displayBaseUrl: string,
  ) {
    this.workerOrigin = workerOrigin;
    this.datasetBasePrefix = datasetBasePrefix;
    this.displayBaseUrl = displayBaseUrl;
    this.credentialsProvider = sharedKvStoreContext.credentialsManager.getCredentialsProvider<OAuth2Credentials>(
      "ssa",
      workerOrigin,
    ) as unknown as SsaCredentialsProvider;
    this.fetchOkToWorker = fetchOkWithOAuth2CredentialsAdapter(
      this.credentialsProvider,
    );
  }

  getUrl(path: string): string {
    return pipelineUrlJoin(this.displayBaseUrl, path);
  }

  get supportsOffsetReads() {
    return true;
  }

  get supportsSuffixReads() {
    return true;
  }

  private async ensureAuthenticated(signal?: AbortSignal): Promise<SsaAuthenticateResponse> {
    if (this.authenticatePromise === undefined) {
      this.authenticatePromise = this.performAuthenticate(signal).catch((e) => {
        // Clear cached promise on failure to allow retry.
        this.authenticatePromise = undefined;
        throw e;
      });
    }
    return this.authenticatePromise;
  }

  private async performAuthenticate(signal?: AbortSignal): Promise<SsaAuthenticateResponse> {
    using _span = new ProgressSpan(new MultiConsumerProgressListener(), {
      message: `Connecting to SSA worker at ${this.workerOrigin}`,
    });
    try {
      const response = await this.fetchOkToWorker(`${this.workerOrigin}/authenticate`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = parseAuthenticateResponse(await response.json());
      return result;
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 401 || e.status === 403) {
          throw new Error(
            `Failed to authenticate with SSA service at ${this.workerOrigin}: access denied (${e.status}).`,
          );
        }
      }
      throw new Error(
        `Failed to connect to SSA service at ${this.workerOrigin}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  private async signSingleUrl(
    method: "GET" | "HEAD",
    fullKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { endpoints } = await this.ensureAuthenticated(signal);
    try {
      const response = await this.fetchOkToWorker(
        `${this.workerOrigin}${endpoints.signRequests}`,
        {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requests: [{ method, path: fullKey }],
          } satisfies SsaSignRequestBody),
        },
      );
      const { urls } = parseSignRequestsResponse(await response.json());
      if (urls.length !== 1) {
        throw new Error(
          `SSA /sign-requests returned ${urls.length} urls, expected 1 for key ${JSON.stringify(fullKey)}`,
        );
      }
      return urls[0];
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw new Error(
          `Permission denied by SSA while signing ${JSON.stringify(fullKey)} (HTTP ${e.status}).`,
          { cause: e },
        );
      }
      throw new Error(
        `Failed to sign request for ${JSON.stringify(fullKey)} via SSA: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  async stat(key: string, options: StatOptions): Promise<StatResponse | undefined> {
    const fullKey = joinPath(this.datasetBasePrefix, key);
    const url = await this.signSingleUrl("HEAD", fullKey, options.signal);
    try {
      const response = await fetchOk(url, { method: "HEAD", signal: options.signal, progressListener: options.progressListener });
      const contentLength = response.headers.get("content-length");
      let totalSize: number | undefined;
      if (contentLength !== null) {
        const n = Number(contentLength);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`Invalid content-length returned by S3 for ${JSON.stringify(fullKey)}: ${JSON.stringify(contentLength)}`);
        }
        totalSize = n;
      }
      return { totalSize };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        if (options.throwIfMissing === true) {
          throw new Error(`${this.getUrl(key)} not found`, { cause: e });
        }
        return undefined;
      }
      throw new Error(
        `Failed to stat ${this.getUrl(key)} via SSA-signed URL: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  async read(key: string, options: DriverReadOptions): Promise<ReadResponse | undefined> {
    const fullKey = joinPath(this.datasetBasePrefix, key);
    const url = await this.signSingleUrl("GET", fullKey, options.signal);

    // Construct Range header based on options.byteRange for efficient reads.
    let rangeHeader: string | undefined;
    const { byteRange } = options;
    if (byteRange !== undefined) {
      if ("suffixLength" in byteRange) {
        // For suffix reads we must know total size; issue HEAD first then compute exact range.
        const statResponse = await this.stat(key, { signal: options.signal });
        if (statResponse === undefined || statResponse.totalSize === undefined) {
          throw new Error(
            `Failed to determine total size of ${this.getUrl(key)} in order to fetch suffix bytes`,
          );
        }
        const total = statResponse.totalSize;
        const len = Math.min(byteRange.suffixLength, total);
        const start = total - len;
        rangeHeader = `bytes=${start}-${total - 1}`;
      } else {
        if (byteRange.length === 0) {
          // Request 1 byte and discard per HTTP semantics for 0-length workaround.
          const start = Math.max(byteRange.offset - 1, 0);
          rangeHeader = `bytes=${start}-${start}`;
        } else {
          rangeHeader = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
        }
      }
    }

    try {
      const response = await fetchOk(url, {
        method: "GET",
        signal: options.signal,
        progressListener: options.progressListener,
        headers: rangeHeader ? { range: rangeHeader } : undefined,
        cache: rangeHeader ? (navigator.userAgent.indexOf("Chrome") !== -1 ? "no-store" : "default") : undefined,
      });

      // Interpret response similar to http/read.ts logic.
      let offset: number | undefined;
      let length: number | undefined;
      let totalSize: number | undefined;
      if (response.status === 206) {
        const contentRange = response.headers.get("content-range");
        if (contentRange !== null) {
          const m = contentRange.match(/bytes ([0-9]+)-([0-9]+)\/(\*|[0-9]+)/);
          if (m === null) {
            throw new Error(
              `Invalid content-range header from S3 for ${this.getUrl(key)}: ${JSON.stringify(contentRange)}`,
            );
          }
          offset = Number(m[1]);
          const endPos = Number(m[2]);
          length = endPos - offset + 1;
          if (m[3] !== "*") totalSize = Number(m[3]);
        } else if (byteRange !== undefined) {
          // Some servers omit content-range; use requested range info where possible.
          if ("suffixLength" in byteRange) {
            // Already computed via HEAD.
            const statResponse = await this.stat(key, { signal: options.signal });
            totalSize = statResponse?.totalSize;
            if (totalSize === undefined) {
              throw new Error("Missing total size for suffix read");
            }
            const len = Math.min(byteRange.suffixLength, totalSize);
            offset = totalSize - len;
            length = len;
          } else {
            if (byteRange.length === 0) {
              offset = byteRange.offset;
              length = 0;
              // Return empty body for zero-length reads.
              return { response: new Response(new Uint8Array(0)), offset, length, totalSize };
            } else {
              offset = byteRange.offset;
              length = byteRange.length;
            }
          }
        }
      } else {
        const cl = response.headers.get("content-length");
        if (cl !== null) {
          const n = Number(cl);
          if (!Number.isFinite(n) || n < 0) {
            throw new Error(`Invalid content-length header for ${this.getUrl(key)}: ${JSON.stringify(cl)}`);
          }
          length = n;
          totalSize = n;
          offset = 0;
        }
      }
      if (offset === undefined) offset = 0;
      return { response, offset, length, totalSize };
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 404) {
          if (options.throwIfMissing === true) {
            throw new Error(`${this.getUrl(key)} not found`, { cause: e });
          }
          return undefined;
        }
        if (e.status === 401 || e.status === 403) {
          throw new Error(
            `Permission denied while reading ${this.getUrl(key)} (HTTP ${e.status}).`,
            { cause: e },
          );
        }
      }
      throw new Error(
        `Failed to read ${this.getUrl(key)} via SSA-signed URL: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  async list(prefix: string, options: { signal?: AbortSignal } = {}): Promise<ListResponse> {
    const fullPrefix = joinPath(this.datasetBasePrefix, prefix);
    const { endpoints } = await this.ensureAuthenticated(options.signal);
    try {
      const response = await this.fetchOkToWorker(
        `${this.workerOrigin}${endpoints.listFiles}`,
        {
          method: "POST",
          signal: options.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prefix: fullPrefix }),
        },
      );
      const parsed = parseListFilesResponse(await response.json());
      // Convert SSA list response into KvStore ListResponse shape.
      return {
        directories: parsed.directories,
        entries: parsed.entries.map((key) => ({ key })),
      };
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw new Error(
          `Permission denied by SSA while listing ${this.getUrl(prefix)} (HTTP ${e.status}).`,
          { cause: e },
        );
      }
      throw new Error(
        `Failed to list files for ${this.getUrl(prefix)} via SSA: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }
}
