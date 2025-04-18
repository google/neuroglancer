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

import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type {
  CompletionResult,
  KvStoreAdapterCompleteUrlOptions,
} from "#src/kvstore/context.js";
import { isSnapshotId } from "#src/kvstore/icechunk/ref.js";
import { parseRefSpec } from "#src/kvstore/icechunk/url.js";
import { listKvStore } from "#src/kvstore/index.js";
import { encodePathForUrl, joinPath } from "#src/kvstore/url.js";
import type { CompletionWithDescription } from "#src/util/completion.js";

export async function completeIcechunkUrl(
  _sharedKvStoreContext: SharedKvStoreContextCounterpart,
  options: KvStoreAdapterCompleteUrlOptions,
): Promise<CompletionResult | undefined> {
  const { url } = options;
  const suffix = url.suffix ?? "";
  if (suffix === "") {
    return {
      offset: 0,
      completions: [{ value: "@", description: "Ref specifier" }],
    };
  }
  const m = suffix.match(/^@([^/]*)((?:\/|$).*)/);
  if (m === null) return undefined;
  const [, version, rest] = m;
  if (rest !== "") {
    parseRefSpec(version);
    return undefined;
  }

  let refCompletionsPromise: Promise<CompletionWithDescription[]> | undefined;
  if (
    version.match(
      /^(?:(?:(?:t|$)(?:a|$)(?:g|$)(?:\.|$))|(?:(?:b|$)(?:r|$)(?:a|$)(?:n|$)(?:c|$)(?:h|$)(?:\.|$)))/,
    )
  ) {
    const refsPath = joinPath(options.base.path, `refs/`);
    refCompletionsPromise = listKvStore(
      options.base.store,
      refsPath + decodeURIComponent(version),
      { signal: options.signal, progressListener: options.progressListener },
    ).then(({ directories }) =>
      directories.map((path) => {
        const ref = path.slice(refsPath.length);
        return {
          value: encodePathForUrl(ref) + "/",
          description: ref.startsWith("tag.") ? "Tag" : "Branch",
        };
      }),
    );
  }

  let snapshotCompletionsPromise:
    | Promise<CompletionWithDescription[]>
    | undefined;
  if (version.match(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{0,20}$/)) {
    const snapshotsPath = joinPath(options.base.path, `snapshots/`);
    snapshotCompletionsPromise = listKvStore(
      options.base.store,
      snapshotsPath + version,
      { signal: options.signal, progressListener: options.progressListener },
    ).then(({ entries }) => {
      const results: CompletionWithDescription[] = [];
      for (const { key } of entries) {
        const snapshotId = key.slice(snapshotsPath.length);
        if (!isSnapshotId(snapshotId)) continue;
        results.push({
          value: snapshotId + "/",
          description: "Snapshot",
        });
      }
      return results;
    });
  }

  return {
    offset: 1,
    completions: [
      ...((await refCompletionsPromise) ?? []),
      ...((await snapshotCompletionsPromise) ?? []),
    ],
  };
}
