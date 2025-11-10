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
import type { BaseKvStoreProvider, BaseKvStoreCompleteUrlOptions, CompletionResult } from "#src/kvstore/context.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { frontendOnlyKvStoreProviderRegistry } from "#src/kvstore/frontend.js";
import { SsaS3KvStore } from "#src/kvstore/ssa_s3/ssa_s3_kvstore.js";
import { verifyObject, verifyObjectProperty, verifyString, verifyStringArray } from "#src/util/json.js";

const SSA_SCHEME_PREFIX = "ssa+";

function ensureSsaHttpsUrl(url: string): URL {
  if (!url.startsWith("ssa+https://")) {
    throw new Error(`Invalid URL ${JSON.stringify(url)}: expected ssa+https scheme`);
  }
  const httpUrl = url.substring(SSA_SCHEME_PREFIX.length);
  const parsed = new URL(httpUrl);
  if (parsed.hash) throw new Error("Fragment not supported in ssa+https URLs");
  if (parsed.username || parsed.password) throw new Error("Basic auth credentials are not supported in ssa+https URLs");
  return parsed;
}

function getWorkerOriginAndDatasetPrefix(parsed: URL): { workerOrigin: string; datasetBasePrefix: string } {
  const workerOrigin = parsed.origin;
  const datasetBasePrefix = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return { workerOrigin, datasetBasePrefix };
}

function getDisplayBase(url: string): string {
  // Keep exactly the ssa+https://host/ base with any search parameters preserved on base.
  const parsed = ensureSsaHttpsUrl(url);
  // Construct base without the path, but keep scheme and origin.
  return `${SSA_SCHEME_PREFIX}${parsed.origin}/`;
}

interface SsaAuthenticateResponseLite {
  permissions: { read: string[]; write: string[] };
  endpoints: { signRequests: string; listFiles: string };
}

function parseAuthenticateResponseLite(json: unknown): SsaAuthenticateResponseLite {
  const obj = verifyObject(json);
  const endpointsObj = verifyObjectProperty(obj, "endpoints", verifyObject);
  const permissionsObj = verifyObjectProperty(obj, "permissions", verifyObject);
  return {
    permissions: {
      read: verifyObjectProperty(permissionsObj, "read", verifyStringArray),
      write: verifyObjectProperty(permissionsObj, "write", verifyStringArray),
    },
    endpoints: {
      signRequests: verifyObjectProperty(endpointsObj, "signRequests", verifyString),
      listFiles: verifyObjectProperty(endpointsObj, "listFiles", verifyString),
    },
  };
}

function dirnameAndBasename(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", base: path };
  return { dir: path.substring(0, idx + 1), base: path.substring(idx + 1) };
}

function joinPath(base: string, suffix: string) {
  if (base === "") return suffix;
  if (base.endsWith("/")) return base + suffix;
  return base + "/" + suffix;
}

async function completeSsaUrl(
  sharedContext: SharedKvStoreContext,
  options: BaseKvStoreCompleteUrlOptions,
): Promise<CompletionResult> {
  const { url } = options;
  const parsed = ensureSsaHttpsUrl(url.url);
  const { workerOrigin, datasetBasePrefix } = getWorkerOriginAndDatasetPrefix(parsed);

  const credentialsProvider = sharedContext.credentialsManager.getCredentialsProvider<OAuth2Credentials>(
    "ssa",
    workerOrigin,
  );
  const fetchOkToWorker = fetchOkWithOAuth2CredentialsAdapter(credentialsProvider);

  const authenticateResponse = parseAuthenticateResponseLite(
    await (await fetchOkToWorker(`${workerOrigin}/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: options.signal,
    })).json(),
  );

  // Determine context for completion.
  const { dir, base } = dirnameAndBasename(datasetBasePrefix);

  // Root-level completion: suggest directories from read permissions.
  if (dir === "") {
    const candidates = authenticateResponse.permissions.read.map((p) => (p.endsWith("/") ? p : p + "/"));
    const matches = candidates
      .filter((p) => p.startsWith(base))
      .map((p) => ({ value: p }));
    const offset = url.url.length - base.length;
    return { offset, completions: matches };
  }

  // Within a directory: use list-files for current dir prefix.
  const listResponse = verifyObject(
    await (await fetchOkToWorker(`${workerOrigin}${authenticateResponse.endpoints.listFiles}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix: dir }),
      signal: options.signal,
    })).json(),
  );
  const objects = verifyObjectProperty(listResponse, "objects", (x) => x as unknown as any[]);
  const childDirs = new Set<string>();
  const childFiles = new Set<string>();
  for (const entry of objects) {
    const obj = verifyObject(entry);
    const key = verifyObjectProperty(obj, "key", verifyString);
    if (!key.startsWith(dir)) continue;
    const remainder = key.substring(dir.length);
    const slash = remainder.indexOf("/");
    if (slash === -1) {
      if (remainder !== "") childFiles.add(remainder);
    } else {
      const first = remainder.substring(0, slash + 1);
      childDirs.add(first);
    }
  }
  const candidates = [
    ...Array.from(childDirs).map((d) => (d.endsWith("/") ? d : d + "/")),
    ...Array.from(childFiles),
  ];
  const matches = candidates
    .filter((p) => p.startsWith(base))
    .map((p) => ({ value: joinPath(dir, p) }));
  const offset = url.url.length - base.length;
  return { offset, completions: matches };
}

function ssaFrontendProvider(sharedContext: SharedKvStoreContext): BaseKvStoreProvider {
  return {
    scheme: "ssa+https",
    description: "Stateless S3 Authenticator (SSA) over HTTPS",
    getKvStore(parsedUrl) {
      // parsedUrl.url is full string like ssa+https://host/path
      const parsed = ensureSsaHttpsUrl(parsedUrl.url);
      const { workerOrigin, datasetBasePrefix } = getWorkerOriginAndDatasetPrefix(parsed);
      const displayBase = getDisplayBase(parsedUrl.url);
      return {
        store: new SsaS3KvStore(sharedContext, workerOrigin, "", displayBase),
        path: datasetBasePrefix,
      };
    },
    async completeUrl(options) {
      return await completeSsaUrl(sharedContext, options);
    },
  };
}

frontendOnlyKvStoreProviderRegistry.registerBaseKvStoreProvider(ssaFrontendProvider);
