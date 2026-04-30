/**
 * @license
 * Copyright 2026 Google Inc.
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

import type {
  BaseKvStoreProvider,
  KvStoreContext,
} from "#src/kvstore/context.js";
import type {
  DriverReadOptions,
  KvStore,
  KvStoreWithPath,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import type { KvStackLayer, KvStackSpec } from "#src/kvstore/kvstack/url.js";
import { formatKvStackUrl, parseKvStackUrl } from "#src/kvstore/kvstack/url.js";
import type {
  KvStoreProviderRegistry,
  SharedKvStoreContextBase,
} from "#src/kvstore/register.js";
import { HttpError, pickDelay } from "#src/util/http_request.js";

interface ResolvedLayer {
  matcher: KvStackLayer;
  resolved: KvStoreWithPath;
}

// fetchOk already retries 429/503/504; only retry the transient error
// classes it surfaces unwrapped (network errors → status 0, plus 502).
const RETRY_STATUSES = new Set([0, 502]);
const RETRY_MAX_ATTEMPTS = 4;

function isRetryable(e: unknown): boolean {
  return e instanceof HttpError && RETRY_STATUSES.has(e.status);
}

function describeMatcher(matcher: KvStackLayer): string {
  if (matcher.exact !== undefined)
    return `exact ${JSON.stringify(matcher.exact)}`;
  if (matcher.prefix !== undefined)
    return `prefix ${JSON.stringify(matcher.prefix)}`;
  return "base";
}

async function delayWithAbort(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// Key range-routed kvstore stack. Composes multiple backing kvstores into one
// logical store, matching the semantics of tensorstore's kvstack driver.
//
// Each layer in the spec has a matcher and a backing kvstore URL:
//   * `{base: URL}`                 - catch-all; matches any key
//   * `{exact: KEY, base: URL}`     - matches only when the input key == KEY
//   * `{prefix: KEY, base: URL}`    - matches when the input key starts with KEY
//
// Resolution:
//   1. Each layer's backing URL is resolved lazily (on first read) via
//      `kvStoreContext.getKvStore(...)`. Layers may nest any registered
//      driver (http/gcs/s3/ocdbt/...); resolution is a plain recursive call
//      into the same context that dispatched to kvstack.
//   2. For a given input key, layers are scanned in REVERSE order so later
//      entries override earlier ones (last-match-wins, per tensorstore).
//   3. When a layer matches, the matched portion of the key is stripped
//      before delegating to the layer's backing store:
//        - `base`:   delegate read(inputKey)        - pass key through
//        - `exact`:  delegate read("")              - base URL is the target
//        - `prefix`: delegate read(inputKey[plen:]) - strip the prefix
//      This makes the layer's backing URL concatenate naturally with the
//      remainder to yield the correct full URL.
//   4. No fallthrough: if no layer matches, `undefined` is returned (same as
//      any kvstore returning "not found" for an unknown key).
//
// The driver is registered on the isomorphic registry; the same code runs on
// frontend and backend since kvstack only composes other kvstores and does no
// I/O itself.
export class KvStackKvStore implements KvStore {
  private resolvedLayers: ResolvedLayer[] | undefined;

  constructor(
    public kvStoreContext: KvStoreContext,
    public spec: KvStackSpec,
  ) {}

  private layers(): ResolvedLayer[] {
    if (this.resolvedLayers === undefined) {
      this.resolvedLayers = this.spec.layers.map((matcher) => ({
        matcher,
        resolved: this.kvStoreContext.getKvStore(matcher.base),
      }));
    }
    return this.resolvedLayers;
  }

  private findLayer(
    key: string,
  ): { layer: ResolvedLayer; subKey: string } | undefined {
    const layers = this.layers();
    for (let i = layers.length - 1; i >= 0; --i) {
      const layer = layers[i];
      const { matcher } = layer;
      if (matcher.exact !== undefined) {
        if (key === matcher.exact) return { layer, subKey: "" };
      } else if (matcher.prefix !== undefined) {
        if (key.startsWith(matcher.prefix)) {
          return { layer, subKey: key.substring(matcher.prefix.length) };
        }
      } else {
        return { layer, subKey: key };
      }
    }
    return undefined;
  }

  stat(key: string, options: StatOptions): Promise<StatResponse | undefined> {
    const match = this.findLayer(key);
    if (match === undefined) return Promise.resolve(undefined);
    const { layer, subKey } = match;
    const fullPath = layer.resolved.path + subKey;
    return this.runWithRetry(layer, key, options.signal, () =>
      layer.resolved.store.stat(fullPath, options),
    );
  }

  read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const match = this.findLayer(key);
    if (match === undefined) return Promise.resolve(undefined);
    const { layer, subKey } = match;
    const fullPath = layer.resolved.path + subKey;
    return this.runWithRetry(layer, key, options.signal, () =>
      layer.resolved.store.read(fullPath, options),
    );
  }

  private async runWithRetry<T>(
    layer: ResolvedLayer,
    key: string,
    signal: AbortSignal | undefined,
    op: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; ++attempt) {
      signal?.throwIfAborted();
      try {
        return await op();
      } catch (e) {
        lastError = e;
        if (!isRetryable(e) || attempt + 1 === RETRY_MAX_ATTEMPTS) break;
        await delayWithAbort(pickDelay(attempt), signal);
      }
    }
    throw new Error(
      `kvstack read failed for key ${JSON.stringify(key)} ` +
        `(layer ${describeMatcher(layer.matcher)}, backing ${layer.matcher.base})`,
      { cause: lastError },
    );
  }

  getUrl(key: string): string {
    return formatKvStackUrl(this.spec, key);
  }

  get supportsOffsetReads(): boolean {
    return true;
  }
  get supportsSuffixReads(): boolean {
    return true;
  }
}

function kvstackProvider(
  sharedKvStoreContext: SharedKvStoreContextBase,
): BaseKvStoreProvider {
  return {
    scheme: "kvstack",
    description: "Key range-routed kvstore stack",
    getKvStore(parsedUrl) {
      const { spec, path } = parseKvStackUrl(parsedUrl);
      return {
        store: new KvStackKvStore(sharedKvStoreContext.kvStoreContext, spec),
        path,
      };
    },
  };
}

export function registerProviders<
  SharedKvStoreContext extends SharedKvStoreContextBase,
>(registry: KvStoreProviderRegistry<SharedKvStoreContext>) {
  registry.registerBaseKvStoreProvider((context) => kvstackProvider(context));
}
