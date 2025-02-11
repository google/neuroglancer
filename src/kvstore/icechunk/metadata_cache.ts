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

import { SimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { ManifestId } from "#src/kvstore/icechunk/decode_utils.js";
import {
  decodeManifest,
  getManifestUrl,
} from "#src/kvstore/icechunk/manifest.js";
import { decodeRef, isBranchRef } from "#src/kvstore/icechunk/ref.js";
import type { SnapshotId } from "#src/kvstore/icechunk/snapshot.js";
import {
  decodeSnapshot,
  getSnapshotUrl,
} from "#src/kvstore/icechunk/snapshot.js";
import type { RefSpec } from "#src/kvstore/icechunk/url.js";
import { pipelineUrlJoin } from "#src/kvstore/url.js";
import {
  ProgressSpan,
  type ProgressOptions,
} from "#src/util/progress_listener.js";

function makeMetadataCache<T>(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  description: string,
  decode: (
    response: Response,
    signal: AbortSignal,
  ) => Promise<{ data: T; size: number }>,
) {
  const cache = new SimpleAsyncCache<string, T>(
    sharedKvStoreContext.chunkManager.addRef(),
    {
      get: async (url: string, progressOptions: ProgressOptions) => {
        const readResponse = await sharedKvStoreContext.kvStoreContext.read(
          url,
          {
            ...progressOptions,
            throwIfMissing: true,
          },
        );
        try {
          return await decode(readResponse.response, progressOptions.signal);
        } catch (e) {
          throw new Error(`Error reading icechunk ${description} from ${url}`, {
            cause: e,
          });
        }
      },
    },
  );
  cache.registerDisposer(sharedKvStoreContext.addRef());
  return cache;
}

export function getSnapshot(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  baseUrl: string,
  id: SnapshotId,
  options: Partial<ProgressOptions>,
) {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "icechunk:snapshot",
    () =>
      makeMetadataCache(
        sharedKvStoreContext,
        "snapshot",
        async (response, signal) => {
          const value = await decodeSnapshot(
            await response.arrayBuffer(),
            signal,
          );
          return { data: value, size: value.estimatedSize };
        },
      ),
  );
  return cache.get(getSnapshotUrl(baseUrl, id), options);
}

export function getManifest(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  baseUrl: string,
  id: ManifestId,
  options: Partial<ProgressOptions>,
) {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "icechunk:manifest",
    () =>
      makeMetadataCache(
        sharedKvStoreContext,
        "manifest",
        async (response, signal) => {
          const value = await decodeManifest(
            await response.arrayBuffer(),
            signal,
          );
          return { data: value, size: value.estimatedSize };
        },
      ),
  );
  return cache.get(getManifestUrl(baseUrl, id), options);
}

export function getRef(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  options: Partial<ProgressOptions>,
) {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "icechunk:ref",
    () =>
      makeMetadataCache(sharedKvStoreContext, "ref", async (response) => ({
        data: decodeRef(await response.json()),
        size: 0,
      })),
  );
  return cache.get(url, options);
}

export function getBranch(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  options: Partial<ProgressOptions>,
) {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "icechunk:branch",
    () => {
      const cache = new SimpleAsyncCache<string, string>(
        sharedKvStoreContext.chunkManager.addRef(),
        {
          get: async (url: string, progressOptions: ProgressOptions) => {
            using _span = new ProgressSpan(progressOptions.progressListener, {
              message: `Resolving icechunk branch at ${url}`,
            });
            try {
              const listResponse =
                await sharedKvStoreContext.kvStoreContext.list(url, {
                  ...progressOptions,
                  responseKeys: "suffix",
                });
              const headKey = listResponse.entries.find((entry) =>
                isBranchRef(entry.key),
              );
              if (headKey === undefined) {
                throw new Error(`Failed to find any refs`);
              }
              const snapshotId = await getRef(
                sharedKvStoreContext,
                pipelineUrlJoin(url, headKey.key),
                progressOptions,
              );
              return { data: snapshotId, size: 0 };
            } catch (e) {
              throw new Error(`Error resolving icechunk branch at ${url}`, {
                cause: e,
              });
            }
          },
        },
      );
      cache.registerDisposer(sharedKvStoreContext.addRef());
      return cache;
    },
  );
  return cache.get(url, options);
}

export function getTag(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  options: Partial<ProgressOptions>,
) {
  const cache = sharedKvStoreContext.chunkManager.memoize.get(
    "icechunk:tag",
    () => {
      const cache = new SimpleAsyncCache<string, string>(
        sharedKvStoreContext.chunkManager.addRef(),
        {
          get: async (url: string, progressOptions: ProgressOptions) => {
            using _span = new ProgressSpan(progressOptions.progressListener, {
              message: `Resolving icechunk tag at ${url}`,
            });
            try {
              const [tagResponse, deletedResponse] = await Promise.all([
                getRef(
                  sharedKvStoreContext,
                  pipelineUrlJoin(url, "ref.json"),
                  progressOptions,
                ),
                sharedKvStoreContext.kvStoreContext.stat(
                  pipelineUrlJoin(url, "ref.json.deleted"),
                  progressOptions,
                ),
              ]);
              if (deletedResponse !== undefined) {
                throw new Error(`Tag is marked as deleted`);
              }
              return { data: tagResponse, size: 0 };
            } catch (e) {
              throw new Error(`Error resolving icechunk tag at ${url}`, {
                cause: e,
              });
            }
          },
        },
      );
      cache.registerDisposer(sharedKvStoreContext.addRef());
      return cache;
    },
  );
  return cache.get(url, options);
}

export function resolveRefSpec(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  refSpec: RefSpec,
  options: Partial<ProgressOptions>,
): Promise<string> {
  if ("snapshot" in refSpec) {
    return Promise.resolve(refSpec.snapshot);
  }
  if ("branch" in refSpec) {
    return getBranch(
      sharedKvStoreContext,
      pipelineUrlJoin(url, `refs/branch.${refSpec.branch}/`),
      options,
    );
  }
  return getTag(
    sharedKvStoreContext,
    pipelineUrlJoin(url, `refs/tag.${refSpec.tag}/`),
    options,
  );
}
