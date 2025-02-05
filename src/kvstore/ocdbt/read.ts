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
  FileByteRangeHandle,
  handleByteRangeRequestFromUint8Array,
} from "#src/kvstore/byte_range/file_handle.js";
import type { DriverReadOptions, ReadResponse } from "#src/kvstore/index.js";
import { KvStoreFileHandle } from "#src/kvstore/index.js";
import type {
  BtreeInteriorNodeEntry,
  BtreeLeafNodeEntry,
  BtreeNodeHeight,
  BtreeNodeReference,
} from "#src/kvstore/ocdbt/btree.js";
import {
  findBtreeInteriorEntry,
  findBtreeLeafEntry,
  validateBtreeNodeReference,
} from "#src/kvstore/ocdbt/btree.js";
import { locationIsMissing } from "#src/kvstore/ocdbt/indirect_data_reference.js";
import type { Key } from "#src/kvstore/ocdbt/key.js";
import { EMPTY_KEY, keyStartsWith } from "#src/kvstore/ocdbt/key.js";
import { getBtreeNode } from "#src/kvstore/ocdbt/metadata_cache.js";
import type { BtreeGenerationReference } from "#src/kvstore/ocdbt/version_tree.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

const DEBUG = false;

export async function findEntryInRoot(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  root: BtreeGenerationReference,
  key: Key,
  options: Partial<ProgressOptions>,
): Promise<BtreeLeafNodeEntry | undefined> {
  if (locationIsMissing(root.root.location)) {
    return undefined;
  }
  return await findEntryInSubtree(
    sharedKvStoreContext,
    root.root,
    root.rootHeight,
    EMPTY_KEY,
    key,
    options,
  );
}

export async function readFromRoot(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  root: BtreeGenerationReference,
  key: Key,
  options: DriverReadOptions,
): Promise<ReadResponse | undefined> {
  if (locationIsMissing(root.root.location)) {
    return undefined;
  }
  const entry = await findEntryInSubtree(
    sharedKvStoreContext,
    root.root,
    root.rootHeight,
    EMPTY_KEY,
    key,
    options,
  );
  if (entry === undefined) return undefined;
  return await readFromLeafNodeEntry(sharedKvStoreContext, entry, options);
}

export async function findEntryInSubtree(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  nodeReference: BtreeNodeReference,
  nodeHeight: BtreeNodeHeight,
  inclusiveMinKey: Key,
  queryKey: Key,
  options: Partial<ProgressOptions>,
): Promise<BtreeLeafNodeEntry | undefined> {
  while (true) {
    const node = await getBtreeNode(
      sharedKvStoreContext,
      nodeReference.location,
      options,
    );
    if (DEBUG) {
      console.log(nodeReference, nodeHeight, node, inclusiveMinKey, queryKey);
    }
    validateBtreeNodeReference(node, nodeHeight, inclusiveMinKey);
    if (!keyStartsWith(queryKey, node.keyPrefix)) {
      if (DEBUG) {
        console.log(
          "not found due to key prefix mismatch",
          queryKey,
          node.keyPrefix,
        );
      }
      return undefined;
    }
    if (node.height === 0) {
      const entry = findBtreeLeafEntry(
        node.entries as BtreeLeafNodeEntry[],
        queryKey,
      );
      return entry;
    }
    const entry = findBtreeInteriorEntry(
      node.entries as BtreeInteriorNodeEntry[],
      queryKey,
    );
    if (entry === undefined) {
      return undefined;
    }
    const { subtreeCommonPrefixLength } = entry;
    queryKey = queryKey.subarray(subtreeCommonPrefixLength);
    nodeReference = entry.node;
    inclusiveMinKey = entry.key.subarray(subtreeCommonPrefixLength);
    --nodeHeight;
  }
}

export async function readFromLeafNodeEntry(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  entry: BtreeLeafNodeEntry,
  options: DriverReadOptions,
): Promise<ReadResponse | undefined> {
  const { value } = entry;
  if (value instanceof Uint8Array) {
    return handleByteRangeRequestFromUint8Array(value, options.byteRange);
  }
  const {
    offset,
    length,
    dataFile: { baseUrl, relativePath },
  } = value;
  const { store, path } =
    sharedKvStoreContext.kvStoreContext.getKvStore(baseUrl);
  return await new FileByteRangeHandle(
    new KvStoreFileHandle(store, path + relativePath),
    { offset: Number(offset), length: Number(length) },
  ).read(options);
}
