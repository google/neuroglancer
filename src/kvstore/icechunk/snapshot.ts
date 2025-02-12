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

import * as v from "valibot";
import {
  DataId12,
  decodeMsgpack,
  Integer,
  LATEST_KNOWN_SPEC_VERSION,
  ManifestId,
  NodeId,
  parseDecodedMsgpack,
  tupleToObject,
} from "#src/kvstore/icechunk/decode_utils.js";

import { pipelineUrlJoin } from "#src/kvstore/url.js";
import { binarySearch } from "#src/util/array.js";
import { defaultStringCompare } from "#src/util/string.js";

const SNAPSHOT_FILE_TYPE = 1;
// const ATTRIBUTES_FILE_TYPE = 3;

const SnapshotId = DataId12;
export type SnapshotId = v.InferOutput<typeof SnapshotId>;
const AttributesId = DataId12;

const ManifestFileInfo = tupleToObject({
  id: ManifestId,
  sizeBytes: Integer,
  numRows: Integer,
});

const AttributeFileInfo = tupleToObject({
  id: AttributesId,
});

// const UserAttributesRef = tupleToObject({
//   objectId: AttributesId,
//   location: Integer,
// });

const UserAttributesSnapshot = v.pipe(
  v.map(v.string(), v.any()),
  v.transform<Map<string, any>, Record<string, any>>(Object.fromEntries),
  v.union([
    v.strictObject({
      Inline: v.any(),
    }),
  ]),
  // v.map(v.picklist(["Ref"]), UserAttributesRef),
);

const ChunkKeyEncoding = v.picklist(["Slash", "Dot"]);

const Configuration = v.map(v.string(), v.any());

const Codec = tupleToObject({
  name: v.string(),
  configuration: Configuration,
});

const FillValue = v.pipe(
  v.map(v.string(), v.any()),
  v.transform((obj) => {
    const values = Array.from(obj.values());
    if (values.length !== 1) {
      throw new Error(
        `Expected a single key, but received: ${JSON.stringify(Array.from(obj.keys()))}`,
      );
    }
    return values[0];
  }),
);

const StorageTransformer = tupleToObject({
  name: v.string(),
  configuration: Configuration,
});

const DimensionNames = v.array(v.nullable(v.string()));

const ZarrArrayMetadata = tupleToObject({
  shape: v.array(Integer),
  dataType: v.string(),
  chunkShape: v.array(Integer),
  chunkKeyEncoding: ChunkKeyEncoding,
  fillValue: FillValue,
  codecs: v.array(Codec),
  storageTransformers: v.array(StorageTransformer),
  dimensionNames: v.nullable(DimensionNames),
});

export type ZarrArrayMetadata = v.InferOutput<typeof ZarrArrayMetadata>;

const ChunkIndices = v.array(Integer);

const ManifestExtents = v.strictTuple([ChunkIndices, ChunkIndices]);
export type ManifestExtents = v.InferOutput<typeof ManifestExtents>;
const ManifestRef = tupleToObject({
  objectId: ManifestId,
  extents: ManifestExtents,
});
export type ManifestRef = v.InferOutput<typeof ManifestRef>;

const NodeDataGroup = v.picklist(["Group"]);
const NodeDataArray = v.strictObject({
  Array: tupleToObject({
    metadata: ZarrArrayMetadata,
    manifests: v.array(ManifestRef),
  }),
});
export type NodeDataArray = v.InferOutput<typeof NodeDataArray>;

const NodeData = v.union([
  NodeDataGroup,
  v.pipe(
    v.map(v.string(), v.any()),
    v.transform<Map<string, any>, Record<string, any>>(Object.fromEntries),
    NodeDataArray,
  ),
]);

const NodeSnapshot = tupleToObject({
  id: NodeId,
  path: v.pipe(
    v.string(),
    v.transform((s) => (s === "/" ? "" : s.slice(1) + "/")),
  ),
  userAttributes: UserAttributesSnapshot,
  nodeData: NodeData,
});

export type NodeSnapshot = v.InferOutput<typeof NodeSnapshot>;

const Nodes = v.pipe(
  v.map(v.string(), NodeSnapshot),
  v.transform((obj) =>
    Array.from(obj.values()).sort((a, b) =>
      defaultStringCompare(a.path, b.path),
    ),
  ),
);

const Snapshot = tupleToObject({
  id: SnapshotId,
  parentId: v.nullable(SnapshotId),
  flushedAt: v.string(),
  message: v.string(),
  metadata: v.record(v.string(), v.any()),
  manifestFiles: v.pipe(
    v.array(ManifestFileInfo),
    v.transform((obj) => {
      const map = new Map();
      for (const entry of obj) {
        map.set(entry.id, entry);
      }
      return map;
    }),
  ),
  attributeFiles: v.array(AttributeFileInfo),
  nodes: Nodes,
});

export type Snapshot = v.InferOutput<typeof Snapshot> & {
  estimatedSize: number;
};

export async function decodeSnapshot(
  buffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<Snapshot> {
  const decoded = await decodeMsgpack(
    buffer,
    LATEST_KNOWN_SPEC_VERSION,
    SNAPSHOT_FILE_TYPE,
    signal,
  );
  return parseDecodedMsgpack(Snapshot, "snapshot", decoded);
}

export function encodeZarrJson(node: NodeSnapshot) {
  const { userAttributes, nodeData } = node;
  let attributes: Map<string, any>;
  if (userAttributes === null) {
    attributes = new Map();
  } else {
    attributes = userAttributes.Inline;
  }

  const obj =
    nodeData !== "Group"
      ? encodeArrayZarrJson(nodeData.Array.metadata, attributes)
      : { zarr_format: 3, node_type: "group", attributes };

  return JSON.stringify(obj, (_key, value) => {
    if (value instanceof Map) {
      return Object.fromEntries(value);
    }
    return value;
  });
}

function encodeArrayZarrJson(
  metadata: ZarrArrayMetadata,
  attributes: Record<string, any>,
) {
  const {
    shape,
    chunkShape,
    chunkKeyEncoding,
    dataType,
    fillValue,
    codecs,
    storageTransformers,
    dimensionNames,
  } = metadata;
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: chunkShape } },
    chunk_key_encoding: {
      name: "default",
      configuration: { separator: chunkKeyEncoding === "Dot" ? "." : "/" },
    },
    fill_value: fillValue,
    codecs,
    storage_transformers: storageTransformers,
    dimension_names: dimensionNames ?? undefined,
    attributes,
  };
}

export function findNode(snapshot: Snapshot, path: string) {
  const { nodes } = snapshot;
  const index = binarySearch(nodes, path, (a, b) =>
    defaultStringCompare(a, b.path),
  );
  if (index < 0) {
    throw new Error(`Node not found: ${JSON.stringify(path)}`);
  }
  return nodes[index];
}

export function getSnapshotUrl(baseUrl: string, id: SnapshotId): string {
  return pipelineUrlJoin(baseUrl, `snapshots/${id}`);
}
