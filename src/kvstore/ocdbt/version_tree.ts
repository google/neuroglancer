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

import type { BtreeNodeReference } from "#src/kvstore/ocdbt/btree.js";
import { readBtreeNodeReferences } from "#src/kvstore/ocdbt/btree.js";
import type { Reader } from "#src/kvstore/ocdbt/decode_utils.js";
import {
  decodeEnvelope,
  readArrayOf,
  readLeb128Bigint,
  readLeb128Bounded,
  readStructOfArrays,
  readUint64le,
  readUint8,
} from "#src/kvstore/ocdbt/decode_utils.js";
import type {
  DataFileTable,
  IndirectDataReference,
  ReadIndirectDataReferenceOptions,
} from "#src/kvstore/ocdbt/indirect_data_reference.js";
import {
  locationIsMissing,
  readDataFileTable,
  readIndirectDataReferences,
} from "#src/kvstore/ocdbt/indirect_data_reference.js";
import type { Config } from "#src/kvstore/ocdbt/manifest.js";
import type { VersionSpecifier } from "#src/kvstore/ocdbt/version_specifier.js";
import { binarySearch, binarySearchLowerBound } from "#src/util/array.js";
import { bigintCompare } from "#src/util/bigint.js";

export type GenerationNumber = bigint;
export type GenerationIndex = bigint;
export type VersionTreeHeight = number;
export type CommitTime = bigint;

export interface BtreeGenerationReference {
  root: BtreeNodeReference;
  generationNumber: GenerationNumber;
  rootHeight: VersionTreeHeight;
  commitTime: CommitTime;
}

export interface VersionNodeReference {
  location: IndirectDataReference;
  generationNumber: GenerationNumber;
  height: VersionTreeHeight;
  numGenerations: GenerationIndex;
  commitTime: CommitTime;

  // Cumulative sum of `numGenerations`, including this one, starting from the
  // first `VersionNodeReference` entry.
  cumulativeNumGenerations: GenerationIndex;
}

export type VersionTreeArityLog2 = number;

export interface VersionTreeNode {
  height: VersionTreeHeight;
  versionTreeArityLog2: VersionTreeArityLog2;
  entries: VersionNodeReference[] | BtreeGenerationReference[];
  estimatedSize: number;
}

const MAX_VERSION_TREE_ARITY_LOG2 = 16;

export function readVersionTreeLeafNode(
  reader: Reader,
  versionTreeArityLog2: number,
  dataFileTable: DataFileTable,
): BtreeGenerationReference[] {
  const maxNumEntries = 2 ** versionTreeArityLog2;
  const numEntries = readLeb128Bounded(reader, maxNumEntries);
  const entries = readVersionTreeLeafNodeEntries(reader, numEntries, {
    allowMissing: true,
    dataFileTable,
  });
  validateVersionTreeLeafNodeEntries(entries, versionTreeArityLog2);
  return entries;
}

function readVersionTreeInteriorNode(
  reader: Reader,
  versionTreeArityLog2: number,
  dataFileTable: DataFileTable,
  height: number,
): VersionNodeReference[] {
  const maxHeight = getMaxVersionTreeHeight(versionTreeArityLog2);

  if (height > maxHeight) {
    throw new Error(
      `height=${height} exceeds maximum of ${maxHeight} for version_tree_arity_log2=${versionTreeArityLog2}`,
    );
  }
  const maxArity = 2 ** versionTreeArityLog2;
  const entries = readVersionTreeInteriorNodeEntries(
    reader,
    dataFileTable,
    maxArity,
    height - 1,
  );
  validateVersionTreeInteriorNodeEntries(entries, versionTreeArityLog2, height);
  return entries;
}

function validateVersionTreeLeafNodeEntries(
  entries: BtreeGenerationReference[],
  versionTreeArityLog2: number,
): void {
  const maxNumEntries = 2 ** versionTreeArityLog2;
  if (entries.length === 0 || entries.length > maxNumEntries) {
    throw new Error(
      `num_children=${entries.length} outside valid range [1, ${maxNumEntries}]`,
    );
  }
  for (const [i, entry] of entries.entries()) {
    if (locationIsMissing(entry.root.location)) {
      if (entry.rootHeight !== 0) {
        throw new Error(
          `non-zero root_height=${entry.rootHeight} for empty generation ${entry.generationNumber}`,
        );
      }
      const { statistics } = entry.root;
      if (
        statistics.numKeys !== 0n ||
        statistics.numTreeBytes !== 0n ||
        statistics.numIndirectValueBytes !== 0n
      ) {
        throw new Error(
          `non-zero statistics for empty generation_number[${i}]=${entry.generationNumber}`,
        );
      }
    }
    if (entry.generationNumber === 0n) {
      throw new Error(`generation_number[${i}] must be non-zero`);
    }
    if (i !== 0) {
      if (entry.generationNumber <= entries[i - 1].generationNumber) {
        throw new Error(
          `generation_number[${i}]=${entry.generationNumber} <= generation_number[${i - 1}]=${entries[i - 1].generationNumber}`,
        );
      }
    }
  }
  const lastGenerationNumber = entries.at(-1)!.generationNumber;
  const firstGenerationNumber = entries[0].generationNumber;
  const minGenerationNumber = getMinVersionTreeNodeGenerationNumber(
    versionTreeArityLog2,
    0,
    lastGenerationNumber,
  );
  if (firstGenerationNumber < minGenerationNumber) {
    throw new Error(
      `Generation range [${firstGenerationNumber}, ${lastGenerationNumber}] exceeds maximum of [${minGenerationNumber}, ${lastGenerationNumber}]`,
    );
  }
}

function validateVersionTreeInteriorNodeEntries(
  entries: VersionNodeReference[],
  versionTreeArityLog2: number,
  height: number,
): void {
  const maxNumEntries = 2 ** versionTreeArityLog2;
  if (entries.length === 0 || entries.length > maxNumEntries) {
    throw new Error(
      `num_children=${entries.length} outside valid range [1, ${maxNumEntries}]`,
    );
  }
  const childGenerationNumberStride =
    1n << BigInt(versionTreeArityLog2 * height);
  for (const [i, entry] of entries.entries()) {
    if (entry.generationNumber === 0n) {
      throw new Error(`generation_number[${i}] must be non-zero`);
    }
    if (i !== 0) {
      const prev = entries[i - 1];
      if (entry.generationNumber <= prev.generationNumber) {
        throw new Error(
          `generation_number[${i}]=${entry.generationNumber} >= generation_number[${i - 1}]=${prev.generationNumber}`,
        );
      }
      if (
        (entry.generationNumber - 1n) / childGenerationNumberStride ===
        (prev.generationNumber - 1n) / childGenerationNumberStride
      ) {
        throw new Error(
          `generation_number[${i}]=${entry.generationNumber} should be in the same child node as generation_number[${i - 1}]=${prev.generationNumber}`,
        );
      }
    }
    if (entry.generationNumber % childGenerationNumberStride !== 0n) {
      throw new Error(
        `generation_number[${i}]=${entry.generationNumber} is not a multiple of ${childGenerationNumberStride}`,
      );
    }
    if (entry.numGenerations > childGenerationNumberStride) {
      throw new Error(
        `num_generations[${i}]=${entry.numGenerations} for generation_number=${entry.generationNumber} is greater than ${childGenerationNumberStride}`,
      );
    }
  }

  const maxArity = 1n << BigInt(versionTreeArityLog2);
  const lastEntry = entries.at(-1)!;
  if (
    (lastEntry.generationNumber - 1n) /
      childGenerationNumberStride /
      maxArity !==
    (entries[0].generationNumber - 1n) / childGenerationNumberStride / maxArity
  ) {
    throw new Error(
      `generation_number[0]=${entries[0].generationNumber} cannot be in the same node as generation_number[${entries.length - 1}]=${lastEntry.generationNumber}`,
    );
  }
}

function getMinVersionTreeNodeGenerationNumber(
  versionTreeArityLog2: number,
  height: number,
  lastGenerationNumber: GenerationNumber,
): GenerationNumber {
  return (
    lastGenerationNumber -
    ((lastGenerationNumber - 1n) %
      (1n << BigInt(versionTreeArityLog2 * (height + 1))))
  );
}

export function readVersionTreeArityLog2(reader: Reader) {
  const value = readUint8(reader);
  if (value === 0 || value > MAX_VERSION_TREE_ARITY_LOG2) {
    throw new Error(
      `Expected version_tree_arity_log2 in range [1, ${MAX_VERSION_TREE_ARITY_LOG2}] but received: ${value}`,
    );
  }
  return value;
}

const VERSION_TREE_NODE_MAGIC_VALUE = 0x0cdb1234;
const VERSION_TREE_NODE_FORMAT_VERSION = 0;

export async function decodeVersionTreeNode(
  buffer: ArrayBuffer,
  baseUrl: string,
  signal: AbortSignal,
): Promise<VersionTreeNode> {
  try {
    const { reader } = await decodeEnvelope(
      buffer,
      VERSION_TREE_NODE_MAGIC_VALUE,
      VERSION_TREE_NODE_FORMAT_VERSION,
      signal,
    );
    const versionTreeArityLog2 = readVersionTreeArityLog2(reader);
    const height = readUint8(reader);
    const dataFileTable = readDataFileTable(reader, baseUrl);
    return {
      versionTreeArityLog2,
      height,
      entries:
        height === 0
          ? readVersionTreeLeafNode(reader, versionTreeArityLog2, dataFileTable)
          : readVersionTreeInteriorNode(
              reader,
              versionTreeArityLog2,
              dataFileTable,
              height,
            ),
      estimatedSize: reader.data.byteLength * 3,
    };
  } catch (e) {
    throw new Error(`Error decoding OCDBT version tree node`, { cause: e });
  }
}

const readVersionTreeNodeInteriorNodeEntriesWithKnownCount = readStructOfArrays<
  VersionNodeReference,
  { dataFileTable: DataFileTable; height: number | undefined }
>({
  generationNumber: readArrayOf(readLeb128Bigint),
  location: readIndirectDataReferences,
  numGenerations: readArrayOf(readLeb128Bigint),
  commitTime: readArrayOf(readUint64le),
  height: readArrayOf((reader, { height }) =>
    height === undefined ? readUint8(reader) : height,
  ),
  cumulativeNumGenerations: readArrayOf(() => 0n),
});

function computeCumulativeNumGenerations(versionNodes: VersionNodeReference[]) {
  let sum = 0n;
  for (const ref of versionNodes) {
    sum += ref.numGenerations;
    ref.cumulativeNumGenerations = sum;
  }
}

export function readVersionTreeInteriorNodeEntries(
  reader: Reader,
  dataFileTable: DataFileTable,
  maxNumEntries: number,
  height: number | undefined,
) {
  const numEntries = readLeb128Bounded(reader, maxNumEntries);
  const entries = readVersionTreeNodeInteriorNodeEntriesWithKnownCount(
    reader,
    numEntries,
    { dataFileTable, height },
  );
  computeCumulativeNumGenerations(entries);
  return entries;
}

export function getMaxVersionTreeHeight(versionTreeArityLog2: number): number {
  return Math.floor(63 / versionTreeArityLog2) - 1;
}

export const readVersionTreeLeafNodeEntries = readStructOfArrays<
  BtreeGenerationReference,
  ReadIndirectDataReferenceOptions
>({
  generationNumber: readArrayOf(readLeb128Bigint),
  rootHeight: readArrayOf(readUint8),
  root: readBtreeNodeReferences,
  commitTime: readArrayOf(readUint64le),
});

export type VersionQuery =
  | VersionSpecifier
  | { generationIndex: GenerationIndex };

export function compareVersionSpecToVersion(
  versionSpec: VersionSpecifier,
  ref: BtreeGenerationReference,
) {
  return "generationNumber" in versionSpec
    ? bigintCompare(versionSpec.generationNumber, ref.generationNumber)
    : bigintCompare(versionSpec.commitTime, ref.commitTime);
}

export function findLeafVersion(
  generationIndex: GenerationIndex,
  versions: BtreeGenerationReference[],
  version: VersionQuery,
): number {
  if ("generationNumber" in version) {
    return findLeafVersionByGenerationNumber(
      versions,
      version.generationNumber,
    );
  } else if ("generationIndex" in version) {
    let { generationIndex: i } = version;
    i -= generationIndex;
    if (i < 0n) return -1;
    if (i >= BigInt(versions.length)) return versions.length;
    return Number(i);
  } else {
    return findLeafVersionByCommitTime(versions, version.commitTime);
  }
}

function findLeafVersionByGenerationNumber(
  versions: BtreeGenerationReference[],
  generationNumber: GenerationNumber,
): number {
  const index = binarySearch(versions, generationNumber, (a, b) =>
    bigintCompare(a, b.generationNumber),
  );
  if (index < 0) return versions.length;
  return index;
}

function findLeafVersionByCommitTime(
  versions: BtreeGenerationReference[],
  commitTime: CommitTime,
): number {
  const index = binarySearchLowerBound(
    0,
    versions.length,
    (i) => versions[i].commitTime > commitTime,
  );
  if (index === 0) return versions.length;
  return index - 1;
}

// Finds the index of the first version >= version
export function findLeafVersionIndexByLowerBound(
  generationIndex: GenerationIndex,
  versions: BtreeGenerationReference[],
  version: VersionQuery,
): number {
  if ("generationIndex" in version) {
    const index = version.generationIndex - generationIndex;
    if (index < 0n) return 0;
    if (index > BigInt(versions.length)) return versions.length;
    return Number(index);
  }
  return binarySearchLowerBound(
    0,
    versions.length,
    (i) => compareVersionSpecToVersion(version, versions[i]) <= 0,
  );
}

export function findVersionNode(
  versionTreeArityLog2: VersionTreeArityLog2,
  generationIndex: GenerationIndex,
  versionNodes: VersionNodeReference[],
  version: VersionQuery,
): VersionNodeReference | undefined {
  if ("generationIndex" in version) {
    return versionNodes[
      findVersionNodeIndexByGenerationIndex(
        versionNodes,
        version.generationIndex - generationIndex,
      )
    ];
  }
  return "generationNumber" in version
    ? findVersionNodeByGenerationNumber(
        versionTreeArityLog2,
        versionNodes,
        version.generationNumber,
      )
    : findVersionNodeByCommitTime(versionNodes, version.commitTime);
}

function findVersionNodeIndexByGenerationIndex(
  versionNodes: VersionNodeReference[],
  generationIndex: GenerationIndex,
): number {
  return binarySearchLowerBound(
    0,
    versionNodes.length,
    (i) => versionNodes[i].cumulativeNumGenerations > generationIndex,
  );
}

function findVersionNodeByGenerationNumber(
  versionTreeArityLog2: VersionTreeArityLog2,
  versionNodes: VersionNodeReference[],
  generationNumber: GenerationNumber,
): VersionNodeReference | undefined {
  const index = binarySearchLowerBound(
    0,
    versionNodes.length,
    (i) => versionNodes[i].generationNumber >= generationNumber,
  );
  if (index === versionNodes.length) return undefined;
  const ref = versionNodes[index];
  if (
    getMinVersionTreeNodeGenerationNumber(
      versionTreeArityLog2,
      ref.height,
      ref.generationNumber,
    ) > generationNumber
  ) {
    return undefined;
  }
  return ref;
}

function findVersionNodeByCommitTime(
  versionNodes: VersionNodeReference[],
  commitTime: CommitTime,
): VersionNodeReference | undefined {
  const index = binarySearchLowerBound(
    0,
    versionNodes.length,
    (i) => versionNodes[i].commitTime > commitTime,
  );
  if (index === 0) return undefined;
  return versionNodes[index - 1];
}

export function findVersionNodeIndexByLowerBound(
  versionTreeArityLog2: VersionTreeArityLog2,
  generationIndex: GenerationIndex,
  versionNodes: VersionNodeReference[],
  version: VersionQuery,
): number {
  if ("generationIndex" in version) {
    return findVersionNodeIndexByGenerationIndex(
      versionNodes,
      version.generationIndex - generationIndex,
    );
  }
  if ("generationNumber" in version) {
    return findVersionNodeIndexByGenerationNumberLowerBound(
      versionTreeArityLog2,
      versionNodes,
      version.generationNumber,
    );
  }
  return findVersionNodeIndexByCommitTimeLowerBound(
    versionNodes,
    version.commitTime,
  );
}

function findVersionNodeIndexByGenerationNumberLowerBound(
  versionTreeArityLog2: VersionTreeArityLog2,
  versionNodes: VersionNodeReference[],
  generationNumber: GenerationNumber,
): number {
  return binarySearchLowerBound(0, versionNodes.length, (i) => {
    const ref = versionNodes[i];
    return (
      getMinVersionTreeNodeGenerationNumber(
        versionTreeArityLog2,
        ref.height,
        ref.generationNumber,
      ) >= generationNumber
    );
  });
}

function findVersionNodeIndexByCommitTimeLowerBound(
  versionNodes: VersionNodeReference[],
  commitTime: CommitTime,
): number {
  const index = binarySearchLowerBound(
    0,
    versionNodes.length,
    (i) => versionNodes[i].commitTime > commitTime,
  );
  return Math.max(0, index - 1);
}

export function findVersionNodeIndexByUpperBound(
  generationIndex: GenerationIndex,
  versionNodes: VersionNodeReference[],
  version: VersionQuery,
): number {
  if ("generationIndex" in version) {
    return findVersionNodeIndexByGenerationIndexUpperBound(
      versionNodes,
      version.generationIndex - generationIndex,
    );
  }
  if ("generationNumber" in version) {
    return findVersionNodeIndexByGenerationNumberUpperBound(
      versionNodes,
      version.generationNumber,
    );
  }
  return findVersionNodeIndexByCommitTimeLowerBound(
    versionNodes,
    version.commitTime,
  );
}

function findVersionNodeIndexByGenerationIndexUpperBound(
  versionNodes: VersionNodeReference[],
  generationIndex: GenerationIndex,
): number {
  return binarySearchLowerBound(0, versionNodes.length, (i) => {
    const node = versionNodes[i];
    return (
      node.cumulativeNumGenerations - node.numGenerations >= generationIndex
    );
  });
}

function findVersionNodeIndexByGenerationNumberUpperBound(
  versionNodes: VersionNodeReference[],
  generationNumber: GenerationNumber,
): number {
  return binarySearchLowerBound(
    0,
    versionNodes.length,
    (i) => versionNodes[i].generationNumber >= generationNumber,
  );
}

export function validateVersionTreeNodeReference(
  node: VersionTreeNode,
  config: Config,
  lastGenerationNumber: GenerationNumber,
  height: VersionTreeHeight,
  numGenerations: GenerationNumber,
): void {
  if (node.height !== height) {
    throw new Error(
      `Expected height of ${height} but received: ${node.height}`,
    );
  }
  if (node.versionTreeArityLog2 !== config.versionTreeArityLog2) {
    throw new Error(
      `Expected version_tree_arity_log2=${config.versionTreeArityLog2} but received: ${node.versionTreeArityLog2}`,
    );
  }
  const { generationNumber } = node.entries.at(-1)!;
  if (generationNumber !== lastGenerationNumber) {
    throw new Error(
      `Expected generation number ${lastGenerationNumber} but received: ${generationNumber}`,
    );
  }
  const actualNumGenerations =
    node.height === 0
      ? BigInt(node.entries.length)
      : (node.entries.at(-1) as VersionNodeReference).cumulativeNumGenerations;
  if (actualNumGenerations !== numGenerations) {
    throw new Error(
      `Expected ${numGenerations}, but received: ${actualNumGenerations}`,
    );
  }
}
