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
import type { ChunkId } from "#src/kvstore/icechunk/decode_utils.js";
import type { ChunkPayload } from "#src/kvstore/icechunk/manifest.js";
import { getManifest } from "#src/kvstore/icechunk/metadata_cache.js";
import type {
  ManifestExtents,
  NodeDataArray,
  NodeSnapshot,
  Snapshot,
} from "#src/kvstore/icechunk/snapshot.js";
import { encodeZarrJson, findNode } from "#src/kvstore/icechunk/snapshot.js";
import type {
  DriverReadOptions,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { pipelineUrlJoin } from "#src/kvstore/url.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

export interface ResolvedIcechunkPath {
  node: NodeSnapshot;
  chunk?: number[];
}

export function resolveIcechunkPath(
  snapshot: Snapshot,
  path: string,
): ResolvedIcechunkPath | undefined {
  let nodePath: string;
  let chunk: number[] | undefined;
  const zarrJsonMatch = path.match(/(?:^|\/)(zarr\.json)$/);
  if (zarrJsonMatch !== null) {
    nodePath = path.slice(0, -zarrJsonMatch[1].length);
  } else {
    const chunkMatch = path.match(/c(?:[./][0-9]+)*$/);
    if (chunkMatch === null) {
      return undefined;
    }
    nodePath = path.slice(0, -chunkMatch[0].length);
    const parts = chunkMatch[0].split(/[./]/);
    const n = parts.length - 1;
    chunk = new Array<number>(n);
    for (let i = 0; i < n; ++i) {
      chunk[i] = Number(parts[i + 1]);
    }
  }
  const node = findNode(snapshot, nodePath);
  if (chunk === undefined) {
    return { node };
  }
  if (node.nodeData === "Group") {
    // chunk path not valid for groups
    return undefined;
  }
  const { shape, chunkShape } = node.nodeData.Array.metadata;
  const rank = shape.length;
  if (rank !== chunk.length) {
    return undefined;
  }
  for (let i = 0; i < rank; ++i) {
    if (chunk[i] * chunkShape[i] >= shape[i]) {
      return undefined;
    }
  }
  return { node, chunk };
}

function manifestExtentsContain(
  [lower, upper]: ManifestExtents,
  chunk: number[],
) {
  for (let i = 0, n = chunk.length; i < n; ++i) {
    const c = chunk[i];
    if (c < lower[i] || c >= upper[i]) return false;
  }
  return true;
}

export async function resolveChunkPayload(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  baseUrl: string,
  node: NodeSnapshot,
  chunk: number[],
  options: Partial<ProgressOptions>,
): Promise<ChunkPayload | undefined> {
  const { manifests } = (node.nodeData as NodeDataArray).Array;
  const chunkKey = chunk.join();
  const nodeId = node.id;
  for (const manifestRef of manifests) {
    if (!manifestExtentsContain(manifestRef.extents, chunk)) continue;
    const manifest = await getManifest(
      sharedKvStoreContext,
      baseUrl,
      manifestRef.objectId,
      options,
    );
    const chunks = manifest.chunks.get(nodeId);
    if (chunks === undefined) continue;
    const chunkPayload = chunks.get(chunkKey);
    if (chunkPayload !== undefined) return chunkPayload;
  }
  return undefined;
}

export async function stat(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  baseUrl: string,
  snapshot: Snapshot,
  path: string,
  options: StatOptions,
): Promise<StatResponse | undefined> {
  const resolvedPath = resolveIcechunkPath(snapshot, path);
  if (resolvedPath === undefined) return undefined;
  const { node, chunk } = resolvedPath;
  if (chunk === undefined) {
    // zarr.json file.
    return { totalSize: undefined };
  }
  const payload = await resolveChunkPayload(
    sharedKvStoreContext,
    baseUrl,
    node,
    chunk,
    options,
  );
  if (payload === undefined) return undefined;
  let totalSize: number;
  if ("Inline" in payload) {
    totalSize = payload.Inline.length;
  } else if ("Virtual" in payload) {
    totalSize = payload.Virtual.length;
  } else {
    totalSize = payload.Ref.length;
  }
  return { totalSize };
}

async function readFromChunkPayload(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  baseUrl: string,
  payload: ChunkPayload,
  options: DriverReadOptions,
): Promise<ReadResponse> {
  if ("Inline" in payload) {
    return handleByteRangeRequestFromUint8Array(
      payload.Inline,
      options.byteRange,
    );
  }
  let offset: number;
  let length: number;
  let url: string;
  if ("Virtual" in payload) {
    ({ location: url, offset, length } = payload.Virtual);
  } else {
    const { Ref: ref } = payload;
    ({ offset, length } = ref);
    url = getChunkUrl(baseUrl, ref.id);
  }
  return new FileByteRangeHandle(
    sharedKvStoreContext.kvStoreContext.getFileHandle(url),
    { offset, length },
  ).read(options);
}

function getChunkUrl(baseUrl: string, id: ChunkId) {
  return pipelineUrlJoin(baseUrl, `chunks/${id}`);
}

export async function read(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  baseUrl: string,
  snapshot: Snapshot,
  path: string,
  options: DriverReadOptions,
): Promise<ReadResponse | undefined> {
  const resolvedPath = resolveIcechunkPath(snapshot, path);
  if (resolvedPath === undefined) return undefined;
  const { node, chunk } = resolvedPath;
  if (chunk === undefined) {
    // zarr.json file.
    const data = encodeZarrJson(node);
    const encoded = new TextEncoder().encode(data);
    return handleByteRangeRequestFromUint8Array(encoded, options.byteRange);
  }
  const payload = await resolveChunkPayload(
    sharedKvStoreContext,
    baseUrl,
    node,
    chunk,
    options,
  );
  if (payload === undefined) return undefined;
  return readFromChunkPayload(sharedKvStoreContext, baseUrl, payload, options);
}
