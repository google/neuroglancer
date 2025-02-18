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
import {
  normalizeListResponse,
  type ListEntry,
  type ListResponse,
} from "#src/kvstore/index.js";
import type {
  BtreeInteriorNodeEntry,
  BtreeLeafNodeEntry,
  BtreeNodeReference,
} from "#src/kvstore/ocdbt/btree.js";
import {
  findBtreeInteriorEntryPrefixRange,
  findBtreeEntryPrefixUpperBound,
  validateBtreeNodeReference,
  findBtreeLeafEntryPrefixRange,
} from "#src/kvstore/ocdbt/btree.js";
import { locationIsMissing } from "#src/kvstore/ocdbt/indirect_data_reference.js";
import type { Key } from "#src/kvstore/ocdbt/key.js";
import {
  concatKeys,
  EMPTY_KEY,
  findFirstMismatch,
} from "#src/kvstore/ocdbt/key.js";
import { getBtreeNode } from "#src/kvstore/ocdbt/metadata_cache.js";
import type { BtreeGenerationReference } from "#src/kvstore/ocdbt/version_tree.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

const DEBUG = false;

export async function listRoot(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  root: BtreeGenerationReference,
  prefix: Key,
  options: Partial<ProgressOptions>,
): Promise<ListResponse> {
  const entries: ListEntry[] = [];
  const directories = new Set<string>();
  if (!locationIsMissing(root.root.location)) {
    await listSubtree(root.root, root.rootHeight, EMPTY_KEY, 0, {
      sharedKvStoreContext,
      prefix,
      entries: entries,
      directories,
      signal: options.signal,
      progressListener: options.progressListener,
    });
  }
  const response = normalizeListResponse({
    entries,
    directories: Array.from(directories),
  });
  if (DEBUG) {
    console.log(JSON.stringify(response));
  }
  return response;
}

interface ListSubtreeOptions extends Partial<ProgressOptions> {
  sharedKvStoreContext: SharedKvStoreContextCounterpart;
  prefix: Key;
  directories: Set<string>;
  entries: ListEntry[];
}

async function listSubtree(
  nodeReference: BtreeNodeReference,
  height: number,
  inclusiveMinKey: Uint8Array<ArrayBuffer>,
  subtreeCommonPrefixLength: number,
  options: ListSubtreeOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  const node = await getBtreeNode(
    options.sharedKvStoreContext,
    nodeReference.location,
    options,
  );
  validateBtreeNodeReference(
    node,
    height,
    inclusiveMinKey.subarray(subtreeCommonPrefixLength),
  );
  const subtreeKeyPrefix = concatKeys(
    inclusiveMinKey.subarray(0, subtreeCommonPrefixLength),
    node.keyPrefix,
  );
  if (DEBUG) {
    console.log("listSubtree", {
      nodeReference,
      height,
      inclusiveMinKey,
      subtreeCommonPrefixLength,
    });
  }
  const addDirectoryIfValid = (key: Key) => {
    try {
      options.directories.add(
        new TextDecoder("utf-8", { fatal: true }).decode(key),
      );
    } catch {
      // Skip invalid utf-8 keys.
    }
  };
  const { prefix } = options;
  {
    const { offset, difference } = findFirstMismatch(prefix, subtreeKeyPrefix);
    if (
      difference !== 0 &&
      offset < Math.min(prefix.length, subtreeKeyPrefix.length)
    ) {
      // No keys in node match prefix.
      return;
    }
  }

  if (prefix.length < subtreeKeyPrefix.length) {
    // Check if there is a directory separator in `subtreeKeyPrefix` after `prefix`.
    const separatorIndex = subtreeKeyPrefix.indexOf(0x2f, prefix.length);
    if (separatorIndex !== -1) {
      // All keys in the node are part of a common directory.
      addDirectoryIfValid(subtreeKeyPrefix.subarray(0, separatorIndex));
      return;
    }
  }

  const prefixForCurrentNode = prefix.subarray(subtreeKeyPrefix.length);
  if (node.height > 0) {
    const entries = node.entries as BtreeInteriorNodeEntry[];
    const [lower, upper] = findBtreeInteriorEntryPrefixRange(
      entries,
      prefixForCurrentNode,
    );
    if (DEBUG) {
      console.log(
        "Got entry range",
        lower,
        upper,
        entries.length,
        prefixForCurrentNode,
      );
    }
    const promises: Promise<void>[] = [];
    for (let entryIndex = lower; entryIndex < upper; ) {
      const entry = entries[entryIndex];
      ++entryIndex;
      const { key } = entry;
      const { subtreeCommonPrefixLength } = entry;
      if (subtreeCommonPrefixLength > prefixForCurrentNode.length) {
        const separatorIndex = key.indexOf(
          0x2f /* "/".charCodeAt(0) */,
          prefixForCurrentNode.length,
        );
        if (separatorIndex !== -1) {
          // Since there is an additional directory separator after `prefix`
          // within the common key prefix for the subtree, it is not necessary
          // to traverse down into the child.
          const directoryPrefix = key.subarray(0, separatorIndex);
          addDirectoryIfValid(concatKeys(subtreeKeyPrefix, directoryPrefix));
          entryIndex = findBtreeEntryPrefixUpperBound(
            entries,
            entryIndex,
            upper,
            directoryPrefix,
          );
          continue;
        }
      }
      promises.push(
        listSubtree(
          entry.node,
          height - 1,
          concatKeys(subtreeKeyPrefix, entry.key),
          subtreeKeyPrefix.length + entry.subtreeCommonPrefixLength,
          options,
        ),
      );
    }
    await Promise.all(promises);
  } else {
    const entries = node.entries as BtreeLeafNodeEntry[];
    const [lower, upper] = findBtreeLeafEntryPrefixRange(
      entries,
      prefixForCurrentNode,
    );
    for (let entryIndex = lower; entryIndex < upper; ) {
      const entry = entries[entryIndex];
      ++entryIndex;
      const { key } = entry;
      const separatorIndex = key.indexOf(
        0x2f /* "/".charCodeAt(0) */,
        prefixForCurrentNode.length,
      );
      if (separatorIndex !== -1) {
        const directoryPrefix = key.subarray(0, separatorIndex);
        addDirectoryIfValid(concatKeys(subtreeKeyPrefix, directoryPrefix));
        entryIndex = findBtreeEntryPrefixUpperBound(
          entries,
          entryIndex,
          upper,
          key.subarray(0, separatorIndex + 1),
        );
        continue;
      }
      try {
        options.entries.push({
          key: new TextDecoder("utf-8", { fatal: true }).decode(
            concatKeys(subtreeKeyPrefix, key),
          ),
        });
      } catch {
        // Ignore invalid utf-8 keys.
      }
    }
  }
}
