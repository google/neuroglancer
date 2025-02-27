/**
 * @license
 * Copyright 2024 Google Inc.
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

import type { CompletionResult } from "#src/datasource/index.js";
import type { AutoDetectDirectorySpec } from "#src/kvstore/auto_detect.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import type { KvStoreWithPath } from "#src/kvstore/index.js";
import { listKvStore } from "#src/kvstore/index.js";
import {
  encodePathForUrl,
  finalPipelineUrlComponent,
  parsePipelineUrlComponent,
} from "#src/kvstore/url.js";
import type { CompletionWithDescription } from "#src/util/completion.js";
import {
  concatCompletions,
  applyCompletionOffset,
} from "#src/util/completion.js";
import type { ProgressListener } from "#src/util/progress_listener.js";

export async function getKvStoreCompletions(
  sharedKvStoreContext: SharedKvStoreContext,
  options: {
    url: string;
    signal?: AbortSignal;
    progressListener?: ProgressListener;
    directoryOnly?: boolean;
    autoDetectDirectory?: () => AutoDetectDirectorySpec;
    singlePipelineComponent?: boolean;
  },
): Promise<CompletionResult> {
  const { url, autoDetectDirectory } = options;

  const { kvStoreContext } = sharedKvStoreContext;

  const finalComponent = finalPipelineUrlComponent(url);

  let kvStore: KvStoreWithPath | undefined;

  let providerCompletionsPromise:
    | Promise<CompletionResult | undefined>
    | undefined;

  if (finalComponent !== url) {
    const adapterUrl = parsePipelineUrlComponent(finalComponent);
    const provider = kvStoreContext.getKvStoreAdapterProvider(adapterUrl);
    const baseUrl = url.slice(0, url.length - finalComponent.length - 1);
    const base = kvStoreContext.getKvStore(baseUrl);
    if (provider.completeUrl !== undefined) {
      providerCompletionsPromise = (async () => {
        const result = await provider.completeUrl!({
          url: adapterUrl,
          base,
          signal: options.signal,
          progressListener: options.progressListener,
        });
        return applyCompletionOffset(
          url.length - finalComponent.length + adapterUrl.scheme.length + 1,
          result,
        );
      })();
    }
    try {
      kvStore = provider.getKvStore(adapterUrl, base);
    } catch (e) {
      if (providerCompletionsPromise === undefined) {
        throw e;
      }
    }
  } else {
    const parsedUrl = parsePipelineUrlComponent(finalComponent);
    const provider = kvStoreContext.getBaseKvStoreProvider(parsedUrl);
    if (provider.completeUrl !== undefined) {
      providerCompletionsPromise = (async () => {
        const result = await provider.completeUrl!({
          url: parsedUrl,
          signal: options.signal,
          progressListener: options.progressListener,
        });
        return applyCompletionOffset(parsedUrl.scheme.length + 1, result);
      })();
    }
    try {
      kvStore = provider.getKvStore(parsedUrl);
    } catch (e) {
      if (providerCompletionsPromise === undefined) {
        throw e;
      }
    }
  }

  let genericCompletionsPromise: Promise<CompletionResult> | undefined;

  if (kvStore === undefined) {
    // Invalid URL, generic completions unavailable.
  } else if (kvStore.store.getUrl(kvStore.path) !== url) {
    // URL is valid but lacks final "/" terminator, skip completion.
    //
    // This avoids attempting to access e.g. `gs://bucke` as the user is typing
    // `gs://bucket/`.
  } else {
    genericCompletionsPromise = (async () => {
      const results = await listKvStore(kvStore.store, kvStore.path, {
        signal: options.signal,
        progressListener: options.progressListener,
        responseKeys: "url",
      });

      // Infallible pattern
      const [, directoryPath, namePrefix] = finalComponent.match(
        /^((?:[a-zA-Z][a-zA-Z0-9-+.]*:)(?:.*\/)?)([^/]*)$/,
      )!;
      const offset = url.length - namePrefix.length;
      const matches: CompletionWithDescription[] = [];
      const directoryOffset =
        url.length - finalComponent.length + directoryPath.length;
      for (const entry of results.directories) {
        matches.push({ value: entry.substring(directoryOffset) + "/" });
      }
      if (!options.directoryOnly) {
        const matchSuffix = options.singlePipelineComponent === true ? "" : "|";
        for (const entry of results.entries) {
          matches.push({
            value: entry.key.substring(directoryOffset) + matchSuffix,
          });
        }
      }

      let defaultCompletion: string | undefined;

      if (autoDetectDirectory !== undefined && namePrefix === "") {
        const names = new Set<string>();
        const subDirectories = new Set<string>();
        for (const entry of results.entries) {
          names.add(entry.key.substring(directoryOffset));
        }
        for (const subDirectory of results.directories) {
          subDirectories.add(subDirectory.substring(directoryOffset));
        }
        const pipelineMatches = await autoDetectDirectory().match({
          url,
          fileNames: names,
          subDirectories,
          signal: options.signal,
        });
        for (const match of pipelineMatches) {
          matches.push({
            value: `|${match.suffix}`,
            description: match.description,
          });
        }
        if (pipelineMatches.length === 1) {
          defaultCompletion = `|${pipelineMatches[0].suffix}`;
        }
      }
      return { offset, completions: matches, defaultCompletion };
    })();
  }
  return await concatCompletions(
    url,
    await Promise.all([providerCompletionsPromise, genericCompletionsPromise]),
  );
}

export async function getKvStorePathCompletions(
  sharedKvStoreContext: SharedKvStoreContext,
  options: {
    baseUrl: string;
    path: string;
    signal?: AbortSignal;
    progressListener?: ProgressListener;
    directoryOnly?: boolean;
  },
): Promise<CompletionResult> {
  const { baseUrl, path } = options;
  const { store, path: basePath } =
    sharedKvStoreContext.kvStoreContext.getKvStore(baseUrl);
  if (!store.list) {
    throw new Error("Listing not supported");
  }

  const fullPath = basePath + path;

  const fullOffset = Math.max(basePath.length, fullPath.lastIndexOf("/") + 1);

  const results = await store.list(fullPath, {
    signal: options.signal,
    progressListener: options.progressListener,
  });

  const matches: CompletionWithDescription[] = [];
  for (const entry of results.directories) {
    matches.push({
      value: encodePathForUrl(entry.substring(fullOffset) + "/"),
    });
  }
  if (!options.directoryOnly) {
    for (const entry of results.entries) {
      matches.push({
        value: encodePathForUrl(entry.key.substring(fullOffset)),
      });
    }
  }
  return { offset: fullOffset - basePath.length, completions: matches };
}
