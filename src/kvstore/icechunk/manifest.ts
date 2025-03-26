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
  ChunkId,
  decodeMsgpack,
  Integer,
  LATEST_KNOWN_SPEC_VERSION,
  ManifestId,
  NodeId,
  parseDecodedMsgpack,
  tupleToObject,
} from "#src/kvstore/icechunk/decode_utils.js";
import { pipelineUrlJoin } from "#src/kvstore/url.js";

const MANIFEST_FILE_TYPE = 2;

const InlineChunkPayload = v.strictObject({
  Inline: v.instance(Uint8Array),
});

const Chunksum = v.any();

const VirtualChunkLocation = v.string();

const VirtualChunkRef = tupleToObject({
  location: VirtualChunkLocation,
  offset: Integer,
  length: Integer,
  chunksum: Chunksum,
});

const VirtualChunkRefPayload = v.strictObject({
  Virtual: VirtualChunkRef,
});

const ChunkRef = tupleToObject({
  id: ChunkId,
  offset: Integer,
  length: Integer,
});

const ChunkRefPayload = v.strictObject({
  Ref: ChunkRef,
});

const ChunkPayload = v.pipe(
  v.map(v.string(), v.any()),
  v.transform<Map<string, any>, Record<string, any>>(Object.fromEntries),
  v.union([InlineChunkPayload, VirtualChunkRefPayload, ChunkRefPayload]),
);

export type ChunkPayload = v.InferOutput<typeof ChunkPayload>;

const Manifest = tupleToObject({
  id: ManifestId,
  chunks: v.map(
    NodeId,
    v.map(
      v.pipe(
        v.array(Integer),
        v.transform((chunk) => chunk.join()),
      ),
      ChunkPayload,
    ),
  ),
});

export type Manifest = v.InferOutput<typeof Manifest> & {
  estimatedSize: number;
};

export async function decodeManifest(
  buffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<Manifest> {
  const decoded = await decodeMsgpack(
    buffer,
    LATEST_KNOWN_SPEC_VERSION,
    MANIFEST_FILE_TYPE,
    signal,
  );
  return parseDecodedMsgpack(Manifest, "chunk manifest", decoded);
}

export function getManifestUrl(baseUrl: string, id: ManifestId): string {
  return pipelineUrlJoin(baseUrl, `manifests/${id}`);
}
