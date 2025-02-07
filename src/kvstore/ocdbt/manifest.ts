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
  CompressionMethod,
  decodeEnvelope,
  readBytes,
  readInt32le,
  readLeb128,
  ensureEof,
} from "#src/kvstore/ocdbt/decode_utils.js";
import type { DataFileTable } from "#src/kvstore/ocdbt/indirect_data_reference.js";
import { readDataFileTable } from "#src/kvstore/ocdbt/indirect_data_reference.js";
import type {
  BtreeGenerationReference,
  GenerationIndex,
  GenerationNumber,
  VersionNodeReference,
  VersionTreeArityLog2,
} from "#src/kvstore/ocdbt/version_tree.js";
import {
  getMaxVersionTreeHeight,
  readVersionTreeArityLog2,
  readVersionTreeInteriorNodeEntries,
  readVersionTreeLeafNode,
} from "#src/kvstore/ocdbt/version_tree.js";

export interface ManifestVersionTree {
  inlineVersions: BtreeGenerationReference[];
  versionTreeNodes: VersionNodeReference[];
  numGenerations: GenerationIndex;
}

export enum ManifestKind {
  single = 0,
  numbered = 1,
}

export interface Config {
  uuid: Uint8Array<ArrayBuffer>;
  manifestKind: ManifestKind;
  maxInlineValueBytes: number;
  maxDecodedNodeBytes: number;
  versionTreeArityLog2: VersionTreeArityLog2;
  compressionMethod: CompressionMethod;
  zstdLevel?: number;
}

export interface Manifest {
  config: Config;
  versionTree?: ManifestVersionTree;
  estimatedSize: number;
}

export interface ManifestWithVersionTree extends Manifest {
  versionTree: ManifestVersionTree;
}

function decodeConfig(reader: Reader): Config {
  const uuid = readBytes(reader, 16).slice();
  const manifestKind = readLeb128(reader);
  if (manifestKind > 1) {
    throw new Error(`Unknown manifest kind: ${manifestKind}`);
  }
  const maxInlineValueBytes = readLeb128(reader);
  const maxDecodedNodeBytes = readLeb128(reader);
  const versionTreeArityLog2 = readVersionTreeArityLog2(reader);
  const compressionMethod = readLeb128(reader);
  let zstdLevel: number | undefined;
  switch (compressionMethod) {
    case CompressionMethod.UNCOMPRESSED:
      break;
    case CompressionMethod.ZSTD:
      zstdLevel = readInt32le(reader);
      break;
    default:
      throw new Error(`Invalid compression method: ${compressionMethod}`);
  }
  return {
    uuid,
    manifestKind,
    maxInlineValueBytes,
    maxDecodedNodeBytes,
    versionTreeArityLog2,
    compressionMethod,
    zstdLevel,
  };
}

function decodeManifestVersionTree(
  reader: Reader,
  config: Config,
  baseUrl: string,
): ManifestVersionTree {
  const dataFileTable = readDataFileTable(reader, baseUrl);

  const inlineVersions = readVersionTreeLeafNode(
    reader,
    config.versionTreeArityLog2,
    dataFileTable,
  );

  const versionTreeNodes = readManifestVersionTreeNodes(
    reader,
    config.versionTreeArityLog2,
    dataFileTable,
    inlineVersions.at(-1)!.generationNumber,
  );
  return {
    inlineVersions,
    versionTreeNodes,
    numGenerations:
      BigInt(inlineVersions.length) +
      (versionTreeNodes.at(-1)?.cumulativeNumGenerations ?? 0n),
  };
}

function readManifestVersionTreeNodes(
  reader: Reader,
  versionTreeArityLog2: number,
  dataFileTable: DataFileTable,
  lastGenerationNumber: GenerationNumber,
): VersionNodeReference[] {
  const maxNumEntries = getMaxVersionTreeHeight(versionTreeArityLog2);
  const entries = readVersionTreeInteriorNodeEntries(
    reader,
    dataFileTable,
    maxNumEntries,
    /* height=*/ undefined,
  );
  validateManifestVersionTreeNodes(
    versionTreeArityLog2,
    lastGenerationNumber,
    entries,
  );
  return entries;
}

function validateManifestVersionTreeNodes(
  versionTreeArityLog2: number,
  lastGenerationNumber: GenerationNumber,
  entries: VersionNodeReference[],
): void {
  const maxHeight = getMaxVersionTreeHeight(versionTreeArityLog2);
  for (const [i, entry] of entries.entries()) {
    if (entry.height === 0 || entry.height > maxHeight) {
      throw new Error(
        `entry_height[${i}]=${entry.height} outside valid range [1, ${maxHeight}]`,
      );
    }
    if (entry.generationNumber === 0n) {
      throw new Error(`generation_number[${i}] must be non-zero`);
    }
    if (i > 0) {
      const prev = entries[i - 1];
      if (entry.generationNumber <= prev.generationNumber) {
        throw new Error(
          `generation_number[${i}]=${entry.generationNumber} <= generation_number[${i - 1}]=${prev.generationNumber}`,
        );
      }
      if (entry.height >= prev.height) {
        throw new Error(
          `entry_height[${i}]=${entry.height} >= entry_height[${i - 1}]=${prev.height}`,
        );
      }
    }
  }
  let i = entries.length;
  for (const {
    minGenerationNumber,
    maxGenerationNumber,
    height,
  } of getPossibleManifestVersionTreeNodeReferences(
    lastGenerationNumber,
    versionTreeArityLog2,
  )) {
    if (i === 0) {
      // Height not present.
      break;
    }
    const entry = entries[i - 1];
    if (entry.height !== height) {
      // Height not present
      continue;
    }
    --i;
    const { generationNumber } = entry;
    if (
      generationNumber < minGenerationNumber ||
      generationNumber > maxGenerationNumber
    ) {
      throw new Error(
        `generation_number[${i}]=${generationNumber} is outside expected range [${minGenerationNumber}, ${maxGenerationNumber}] for height ${height}`,
      );
    }
  }

  if (i !== 0) {
    throw new Error(
      `Unexpected child with generation_number[${i - 1}]=${entries[i - 1].generationNumber} and entry_height=${entries[i - 1].height} given last generation_number=${lastGenerationNumber}`,
    );
  }
}

interface PossibleManifestVersionTreeNodeReferences {
  minGenerationNumber: GenerationNumber;
  maxGenerationNumber: GenerationNumber;
  height: number;
}

function getPossibleManifestVersionTreeNodeReferences(
  generationNumber: GenerationNumber,
  versionTreeArityLog2: number,
): PossibleManifestVersionTreeNodeReferences[] {
  generationNumber =
    ((generationNumber - 1n) >> BigInt(versionTreeArityLog2)) <<
    BigInt(versionTreeArityLog2);
  let height = 1;
  const results: PossibleManifestVersionTreeNodeReferences[] = [];
  while (generationNumber !== 0n) {
    const shift = BigInt((height + 1) * versionTreeArityLog2);
    const nextGenerationNumber = ((generationNumber - 1n) >> shift) << shift;
    const minGenerationNumber = nextGenerationNumber + 1n;
    results.push({
      minGenerationNumber,
      maxGenerationNumber: generationNumber,
      height,
    });
    ++height;
    generationNumber = nextGenerationNumber;
  }
  return results;
}

const MANIFEST_MAGIC_VALUE = 0x0cdb3a2a;
const MANIFEST_FORMAT_VERSION = 0;

export async function decodeManifest(
  buffer: ArrayBuffer,
  baseUrl: string,
  signal: AbortSignal,
): Promise<Manifest> {
  try {
    const { reader } = await decodeEnvelope(
      buffer,
      MANIFEST_MAGIC_VALUE,
      MANIFEST_FORMAT_VERSION,
      signal,
    );

    const config = decodeConfig(reader);
    const versionTree =
      config.manifestKind === ManifestKind.single
        ? decodeManifestVersionTree(reader, config, baseUrl)
        : undefined;
    ensureEof(reader);
    return { config, versionTree, estimatedSize: reader.data.byteLength * 3 };
  } catch (e) {
    throw new Error(`Error decoding OCDBT manifest`, { cause: e });
  }
}
