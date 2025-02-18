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

import type { Reader } from "#src/kvstore/ocdbt/decode_utils.js";
import {
  readStructOfArrays,
  decodeEnvelope,
  readUint8,
  readLeb128,
  readLeb128Bounded,
  readArrayOf,
  readLeb128Bigint,
  toArrayOfStructs,
  readBytes,
} from "#src/kvstore/ocdbt/decode_utils.js";
import type {
  DataFileTable,
  IndirectDataReference,
  ReadIndirectDataReferenceOptions,
} from "#src/kvstore/ocdbt/indirect_data_reference.js";
import {
  readDataFileId,
  readDataFileTable,
  readIndirectDataReferences,
} from "#src/kvstore/ocdbt/indirect_data_reference.js";
import type { Key } from "#src/kvstore/ocdbt/key.js";
import {
  compareArraysLexicographically,
  findFirstMismatch,
  keyStartsWith,
} from "#src/kvstore/ocdbt/key.js";
import { binarySearch, binarySearchLowerBound } from "#src/util/array.js";

export type BtreeLeafNodeValueReference =
  | Uint8Array<ArrayBuffer>
  | IndirectDataReference;

export interface BtreeLeafNodeEntry {
  key: Uint8Array<ArrayBuffer>;
  value: BtreeLeafNodeValueReference;
}

export interface BtreeInteriorNodeEntry {
  key: Uint8Array<ArrayBuffer>;
  subtreeCommonPrefixLength: number;
  node: BtreeNodeReference;
}

export interface BtreeNode {
  height: BtreeNodeHeight;
  keyPrefix: Uint8Array<ArrayBuffer>;
  entries: BtreeLeafNodeEntry[] | BtreeInteriorNodeEntry[];
  estimatedSize: number;
}

export type BtreeNodeHeight = number;

export interface BtreeNodeReference {
  location: IndirectDataReference;
  statistics: BtreeNodeStatistics;
}

export interface BtreeNodeStatistics {
  numIndirectValueBytes: bigint;
  numTreeBytes: bigint;
  numKeys: bigint;
}

const BTREE_NODE_MAGIC_VALUE = 0x0cdb20de;
const BTREE_NODE_FORMAT_VERSION = 0;
const MAX_BTREE_NODE_ARITY = 1024 * 1024;

export async function decodeBtreeNode(
  buffer: ArrayBuffer,
  baseUrl: string,
  signal: AbortSignal,
): Promise<BtreeNode> {
  try {
    const { reader } = await decodeEnvelope(
      buffer,
      BTREE_NODE_MAGIC_VALUE,
      BTREE_NODE_FORMAT_VERSION,
      signal,
    );
    const height = readUint8(reader);
    const dataFileTable = readDataFileTable(reader, baseUrl);
    const numEntries = readLeb128(reader);
    if (numEntries === 0) {
      throw new Error(`Empty b+tree node`);
    }
    if (numEntries > MAX_BTREE_NODE_ARITY) {
      throw new Error(
        `B+tree node has arity ${numEntries}, which exceeds limit of ${MAX_BTREE_NODE_ARITY}`,
      );
    }

    return {
      height,
      ...(height === 0
        ? readBtreeLeafNodeEntries(reader, dataFileTable, numEntries)
        : readBtreeInteriorNodeEntries(reader, dataFileTable, numEntries)),
      estimatedSize: reader.data.byteLength * 3,
    };
  } catch (e) {
    throw new Error(`Error decoding OCDBT b+tree node`, { cause: e });
  }
}

const MAX_KEY_LENGTH = 0xffff;

function readKeyLength(reader: Reader): number {
  return readLeb128Bounded(reader, MAX_KEY_LENGTH);
}

function readKeys<IsInteriorNode extends boolean>(
  reader: Reader,
  count: number,
  interiorNode: IsInteriorNode,
): {
  commonPrefix: Key;
  keys: Key[];
  subtreeCommonPrefixLengths: IsInteriorNode extends true
    ? Uint16Array<ArrayBuffer>
    : undefined;
} {
  const keyLengthBuffer = new Uint16Array(count * 2);
  for (let i = 1, n = keyLengthBuffer.length; i < n; ++i) {
    keyLengthBuffer[i] = readKeyLength(reader);
  }
  // common prefix limited to length of first key
  let commonPrefixLength = keyLengthBuffer[count];
  for (let i = 1; i < count; ++i) {
    commonPrefixLength = Math.min(commonPrefixLength, keyLengthBuffer[i]);
  }
  let subtreeCommonPrefixLengths: Uint16Array<ArrayBuffer> | undefined;
  if (interiorNode) {
    subtreeCommonPrefixLengths = new Uint16Array(count);
    for (let i = 0; i < count; ++i) {
      const x = (subtreeCommonPrefixLengths[i] = readKeyLength(reader));
      commonPrefixLength = Math.min(commonPrefixLength, x);
    }
  }
  commonPrefixLength = Math.min(keyLengthBuffer[count], commonPrefixLength);

  for (let i = 0, prevLength = 0; i < count; ++i) {
    const prefixLength = keyLengthBuffer[i];
    if (prefixLength > prevLength) {
      throw new Error(
        `Child ${i}: Prefix length of ${prefixLength} exceeds previous key length ${prevLength}`,
      );
    }
    const suffixLength = keyLengthBuffer[i + count];
    const keyLength = prefixLength + suffixLength;
    if (keyLength > MAX_KEY_LENGTH) {
      throw new Error(
        `Child ${i}: Key length ${keyLength} exceeds limit of ${MAX_KEY_LENGTH}`,
      );
    }
    if (interiorNode) {
      const subtreeCommonPrefixLength = subtreeCommonPrefixLengths![i];
      if (subtreeCommonPrefixLength > keyLength) {
        throw new Error(
          `Child ${i}: subtree common prefix length of ${subtreeCommonPrefixLength} exceeds key length of ${keyLength}`,
        );
      }
      subtreeCommonPrefixLengths![i] -= commonPrefixLength;
    }
    prevLength = keyLength;
  }

  const keys = new Array<Key>(count);

  let commonPrefix: Key;

  // Read first `key_suffix` and extract common prefix.
  {
    const keyLength = keyLengthBuffer[count];
    const key = readBytes(reader, keyLength);
    commonPrefix = key.slice(0, commonPrefixLength);
    keys[0] = key.slice(commonPrefixLength);
  }

  for (let i = 1; i < count; ++i) {
    const prefixLength = keyLengthBuffer[i] - commonPrefixLength;
    const suffixLength = keyLengthBuffer[i + count];
    const suffix = readBytes(reader, suffixLength);
    const prevKey = keys[i - 1];
    if (
      compareArraysLexicographically(prevKey.subarray(prefixLength), suffix) >=
      0
    ) {
      throw new Error(`Invalid key order`);
    }
    const key = new Uint8Array(prefixLength + suffixLength);
    key.set(prevKey.subarray(0, prefixLength));
    key.set(suffix, prefixLength);
    keys[i] = key;
  }

  return {
    keys,
    subtreeCommonPrefixLengths:
      subtreeCommonPrefixLengths as IsInteriorNode extends true
        ? Uint16Array<ArrayBuffer>
        : undefined,
    commonPrefix,
  };
}

enum LeafNodeValueKind {
  INLINE_VALUE = 0,
  OUT_OF_LINE_VALUE = 1,
}

const MAX_INLINE_VALUE_LENGTH = 1024 * 1024;

function readLeafNodeValueReferences(
  reader: Reader,
  dataFileTable: DataFileTable,
  numEntries: number,
): BtreeLeafNodeValueReference[] {
  const lengths = readArrayOf(readLeb128Bigint)(reader, numEntries, {});
  const valueKinds = readBytes(reader, numEntries);
  for (let i = 0; i < numEntries; ++i) {
    const valueKind = valueKinds[i];
    if (valueKind > LeafNodeValueKind.OUT_OF_LINE_VALUE) {
      throw new Error(
        `value_kind[${i}]=${valueKind} is outside valid range [0, ${LeafNodeValueKind.OUT_OF_LINE_VALUE}]`,
      );
    }
    if (valueKind === LeafNodeValueKind.INLINE_VALUE) {
      const length = lengths[i];
      if (length > BigInt(MAX_INLINE_VALUE_LENGTH)) {
        throw new Error(
          `value_length[${i}]=${length} exceeds maximum of ${MAX_INLINE_VALUE_LENGTH} for an inline value`,
        );
      }
    }
  }

  const values = new Array<BtreeLeafNodeValueReference>(numEntries);

  // Read data file ids for indirect values.
  for (let i = 0; i < numEntries; ++i) {
    if (valueKinds[i] !== LeafNodeValueKind.OUT_OF_LINE_VALUE) continue;
    const dataFile = readDataFileId(reader, { dataFileTable });
    values[i] = {
      dataFile,
      offset: 0n,
      length: lengths[i],
    };
  }

  // Read offsets for indirect values.
  for (let i = 0; i < numEntries; ++i) {
    if (valueKinds[i] !== LeafNodeValueKind.OUT_OF_LINE_VALUE) continue;
    const offset = readLeb128Bigint(reader);
    (values[i] as IndirectDataReference).offset = offset;
  }

  // Read inline values.
  for (let i = 0; i < numEntries; ++i) {
    if (valueKinds[i] !== LeafNodeValueKind.INLINE_VALUE) continue;
    values[i] = readBytes(reader, Number(lengths[i]));
  }

  return values;
}

function readBtreeLeafNodeEntries(
  reader: Reader,
  dataFileTable: DataFileTable,
  numEntries: number,
): { keyPrefix: Key; entries: BtreeLeafNodeEntry[] } {
  const { keys, commonPrefix } = readKeys(
    reader,
    numEntries,
    /*interiorNode=*/ false,
  );

  const values = readLeafNodeValueReferences(reader, dataFileTable, numEntries);

  return {
    keyPrefix: commonPrefix,
    entries: toArrayOfStructs<BtreeLeafNodeEntry>(numEntries, {
      key: keys,
      value: values,
    }),
  };
}

function readBtreeInteriorNodeEntries(
  reader: Reader,
  dataFileTable: DataFileTable,
  numEntries: number,
): { keyPrefix: Key; entries: BtreeInteriorNodeEntry[] } {
  const { keys, commonPrefix, subtreeCommonPrefixLengths } = readKeys(
    reader,
    numEntries,
    /*interiorNode=*/ true,
  );

  const nodes = readBtreeNodeReferences(reader, numEntries, { dataFileTable });
  return {
    keyPrefix: commonPrefix,
    entries: toArrayOfStructs<BtreeInteriorNodeEntry>(numEntries, {
      key: keys,
      subtreeCommonPrefixLength: subtreeCommonPrefixLengths,
      node: nodes,
    }),
  };
}

const readBtreeNodeStatistics = readStructOfArrays<BtreeNodeStatistics>({
  numKeys: readArrayOf(readLeb128Bigint),
  numTreeBytes: readArrayOf(readLeb128Bigint),
  numIndirectValueBytes: readArrayOf(readLeb128Bigint),
});

export const readBtreeNodeReferences = readStructOfArrays<
  BtreeNodeReference,
  ReadIndirectDataReferenceOptions
>({
  location: readIndirectDataReferences,
  statistics: readBtreeNodeStatistics,
});

export function validateBtreeNodeReference(
  node: BtreeNode,
  height: BtreeNodeHeight,
  inclusiveMinKey: Key,
) {
  if (node.height !== height) {
    throw new Error(`Expected height of ${height} but received ${node.height}`);
  }
  const { keyPrefix } = node;
  if (inclusiveMinKey.length < keyPrefix.length) {
    if (compareArraysLexicographically(keyPrefix, inclusiveMinKey) >= 0) {
      return;
    }
  } else {
    const c = compareArraysLexicographically(
      keyPrefix,
      inclusiveMinKey.subarray(0, keyPrefix.length),
    );
    if (c >= 0) {
      if (
        compareArraysLexicographically(
          node.entries[0].key,
          inclusiveMinKey.subarray(keyPrefix.length),
        ) >= 0
      ) {
        return;
      }
    }
  }
  throw new Error(
    `First key [${keyPrefix}]+[${node.entries[0].key}] < inclusive_min [${inclusiveMinKey}] specified by parent node`,
  );
}

export function findBtreeInteriorEntryLowerBound(
  entries: BtreeInteriorNodeEntry[],
  inclusiveMin: Key,
) {
  // Find first entry with key *after* inclusiveMin.
  const index = binarySearchLowerBound(
    0,
    entries.length,
    (i) => compareArraysLexicographically(entries[i].key, inclusiveMin) > 0,
  );
  return Math.max(0, index - 1);
}

export function findBtreeLeafEntryLowerBound(
  entries: BtreeNode["entries"],
  inclusiveMin: Key,
) {
  return binarySearchLowerBound(
    0,
    entries.length,
    (i) => compareArraysLexicographically(entries[i].key, inclusiveMin) >= 0,
  );
}

export function findBtreeInteriorEntryPrefixRange(
  entries: BtreeInteriorNodeEntry[],
  prefix: Key,
): [number, number] {
  const lower = findBtreeInteriorEntryLowerBound(entries, prefix);
  const upper = findBtreeEntryPrefixUpperBound(
    entries,
    lower,
    entries.length,
    prefix,
  );
  return [lower, upper];
}

export function findBtreeEntryPrefixUpperBound(
  entries: BtreeNode["entries"],
  lower: number,
  upper: number,
  prefix: Key,
) {
  if (lower === upper || prefix.length === 0) return upper;
  return binarySearchLowerBound(lower, upper, (i) => {
    const { offset, difference } = findFirstMismatch(prefix, entries[i].key);
    return difference < 0 && offset < prefix.length;
  });
}

export function findBtreeLeafEntryPrefixRange(
  entries: BtreeLeafNodeEntry[],
  prefix: Key,
): [number, number] {
  const lower = findBtreeLeafEntryLowerBound(entries, prefix);
  const upper = findBtreeEntryPrefixUpperBound(
    entries,
    lower,
    entries.length,
    prefix,
  );
  return [lower, upper];
}

export function findBtreeLeafEntry(
  entries: BtreeLeafNodeEntry[],
  key: Key,
): BtreeLeafNodeEntry | undefined {
  const index = binarySearch(entries, key, (a, b) =>
    compareArraysLexicographically(a, b.key),
  );
  if (index < 0) return undefined;
  return entries[index];
}

export function findBtreeInteriorEntry(
  entries: BtreeInteriorNodeEntry[],
  key: Key,
): BtreeInteriorNodeEntry | undefined {
  // Find first entry that is *after* key.
  const index = binarySearchLowerBound(
    0,
    entries.length,
    (i) => compareArraysLexicographically(entries[i].key, key) > 0,
  );
  if (index === 0) {
    // First entry is already *after* key, which means key is not present.
    return undefined;
  }
  const entry = entries[index - 1];
  const { subtreeCommonPrefixLength } = entry;
  if (
    subtreeCommonPrefixLength !== 0 &&
    !keyStartsWith(key, entry.key.subarray(0, subtreeCommonPrefixLength))
  ) {
    return undefined;
  }
  return entry;
}
