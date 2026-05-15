/**
 * @license
 * Copyright 2026 Google Inc.
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

import type { AnnotationGeometryChunk } from "#src/annotation/backend.js";
import {
  AnnotationGeometryChunkSourceBackend,
  AnnotationGeometryData,
  AnnotationSource,
} from "#src/annotation/backend.js";
import {
  AnnotationPropertySerializer,
  AnnotationType,
  annotationTypeHandlers,
  annotationTypes,
} from "#src/annotation/index.js";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import type { ZarrVectorsAttributeDtype } from "#src/datasource/zarr-vectors/base.js";
import {
  ZarrVectorsAnnotationSourceParameters,
  ZarrVectorsAnnotationSpatialIndexSourceParameters,
} from "#src/datasource/zarr-vectors/base.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { joinBaseUrlAndPath } from "#src/kvstore/url.js";
import { registerSharedObject } from "#src/worker_rpc.js";

const IS_LITTLE_ENDIAN = true;

// Zstd frame magic ("0xFD2FB528" little-endian).  Coarser pyramid
// levels written by zarr-vectors are zstd-compressed even though
// level 0 is raw; we sniff the magic byte to decide whether to
// decompress.  Robust to whatever per-chunk codec config the writer
// emits — we don't need to read each chunk's individual zarr.json.
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

function looksLikeZstd(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return (
    bytes[0] === ZSTD_MAGIC[0] &&
    bytes[1] === ZSTD_MAGIC[1] &&
    bytes[2] === ZSTD_MAGIC[2] &&
    bytes[3] === ZSTD_MAGIC[3]
  );
}

async function maybeDecompress(
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!looksLikeZstd(bytes)) return bytes;
  return await requestAsyncComputation(
    decodeZstd,
    signal,
    [bytes.buffer],
    bytes,
  );
}

// Per-chunk arrays in zarr-vectors are stored as single-chunk 1D zarr
// v3 uint8 arrays with separator="/" and chunk-key encoding "default",
// which makes the only data file always live at "<array>/c/0".
const CHUNK_DATA_FILE = "c/0";

const TYPED_ARRAY_CTORS: Record<
  ZarrVectorsAttributeDtype,
  | Float32ArrayConstructor
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Int8ArrayConstructor
  | Int16ArrayConstructor
  | Int32ArrayConstructor
> = {
  float32: Float32Array,
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  int8: Int8Array,
  int16: Int16Array,
  int32: Int32Array,
};

const BYTES_PER_ELEMENT: Record<ZarrVectorsAttributeDtype, number> = {
  float32: 4,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  int8: 1,
  int16: 2,
  int32: 4,
};

function reinterpretBytes(
  bytes: Uint8Array,
  dtype: ZarrVectorsAttributeDtype,
  expectedLength: number,
):
  | Float32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array {
  const elementSize = BYTES_PER_ELEMENT[dtype];
  if (bytes.byteLength !== expectedLength * elementSize) {
    throw new Error(
      `zarr-vectors attribute byte length ${bytes.byteLength} does not match ` +
        `expected ${expectedLength * elementSize} (${expectedLength} ${dtype} values)`,
    );
  }
  const Ctor = TYPED_ARRAY_CTORS[dtype];
  // The fetched buffer may not be aligned for non-uint8 typed arrays;
  // copy when necessary.
  const offsetAligned = bytes.byteOffset % elementSize === 0;
  if (offsetAligned) {
    return new (Ctor as any)(bytes.buffer, bytes.byteOffset, expectedLength);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new (Ctor as any)(copy.buffer, 0, expectedLength);
}

function emptyGeometryData(): AnnotationGeometryData {
  const data = new AnnotationGeometryData();
  data.data = new Uint8Array(new ArrayBuffer(0));
  data.typeToOffset = annotationTypes.map(() => 0);
  data.typeToIds = annotationTypes.map(() => [] as string[]);
  data.typeToIdMaps = annotationTypes.map(() => new Map<string, number>());
  data.typeToInstanceCounts = annotationTypes.map(() => [] as number[]);
  data.typeToSize = annotationTypes.map(() => 0);
  return data;
}

function buildPointAnnotationGeometryData(
  rank: number,
  numPoints: number,
  positions: Float32Array,
  propertyValuesPerPoint: (
    | Float32Array
    | Uint8Array
    | Uint16Array
    | Uint32Array
    | Int8Array
    | Int16Array
    | Int32Array
  )[],
  ids: string[],
  serializer: AnnotationPropertySerializer,
): AnnotationGeometryData {
  const totalBytes = serializer.serializedBytes * numPoints;
  const buffer = new ArrayBuffer(totalBytes);
  const data = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const pointHandler = annotationTypeHandlers[AnnotationType.POINT];
  const perAnnotationStride = serializer.propertyGroupBytes[0];

  const numProps = propertyValuesPerPoint.length;
  const propValues = new Array<number>(numProps);

  for (let i = 0; i < numPoints; ++i) {
    // Geometry — reuse a Float32Array view onto the source positions
    // for this point.
    const point = positions.subarray(i * rank, (i + 1) * rank);
    pointHandler.serialize(dv, perAnnotationStride * i, IS_LITTLE_ENDIAN, rank, {
      type: AnnotationType.POINT,
      point,
      id: ids[i],
      properties: [],
    } as any);
    // Properties
    for (let p = 0; p < numProps; ++p) {
      propValues[p] = propertyValuesPerPoint[p][i] as number;
    }
    serializer.serialize(dv, 0, i, numPoints, IS_LITTLE_ENDIAN, propValues);
  }

  const result = new AnnotationGeometryData();
  result.data = data;
  result.typeToOffset = annotationTypes.map(() => 0);
  result.typeToIds = annotationTypes.map(() => [] as string[]);
  result.typeToIdMaps = annotationTypes.map(() => new Map<string, number>());
  result.typeToInstanceCounts = annotationTypes.map(() => [] as number[]);
  result.typeToSize = annotationTypes.map(() => 0);
  result.typeToIds[AnnotationType.POINT] = ids;
  result.typeToIdMaps[AnnotationType.POINT] = new Map(ids.map((id, i) => [id, i]));
  result.typeToInstanceCounts[AnnotationType.POINT] = Array.from(
    { length: numPoints },
    (_, i) => i,
  );
  result.typeToSize[AnnotationType.POINT] = numPoints;
  return result;
}

function chunkLinearIndex(
  chunkGridPosition: ArrayLike<number>,
  upperChunkBound: ArrayLike<number> | undefined,
): number {
  let idx = 0;
  let stride = 1;
  const rank = chunkGridPosition.length;
  for (let i = 0; i < rank; ++i) {
    idx += chunkGridPosition[i] * stride;
    const dim = upperChunkBound?.[i] ?? 1;
    stride *= Math.max(1, dim);
  }
  return idx;
}

@registerSharedObject()
export class ZarrVectorsAnnotationSpatialIndexSourceBackend extends WithParameters(
  WithSharedKvStoreContextCounterpart(AnnotationGeometryChunkSourceBackend),
  ZarrVectorsAnnotationSpatialIndexSourceParameters,
) {
  declare parent: ZarrVectorsAnnotationSourceBackend;

  async download(chunk: AnnotationGeometryChunk, signal: AbortSignal) {
    const { parent } = this;
    const { baseUrl, rank, attributeNames, attributeDtypes } = this.parameters;
    const { chunkGridPosition } = chunk;
    const chunkKey = Array.from(chunkGridPosition, (v) => String(v)).join(".");
    const vertexUrl = joinBaseUrlAndPath(
      baseUrl,
      `vertices/${chunkKey}/${CHUNK_DATA_FILE}`,
    );
    const vertexResponse = await this.sharedKvStoreContext.kvStoreContext.read(
      vertexUrl,
      { signal },
    );
    if (vertexResponse === undefined) {
      chunk.data = emptyGeometryData();
      return;
    }
    const vertexBytes = await maybeDecompress(
      new Uint8Array(await vertexResponse.response.arrayBuffer()),
      signal,
    );
    if (vertexBytes.byteLength === 0) {
      chunk.data = emptyGeometryData();
      return;
    }
    const bytesPerPoint = rank * 4; // float32
    if (vertexBytes.byteLength % bytesPerPoint !== 0) {
      throw new Error(
        `zarr-vectors vertex blob has ${vertexBytes.byteLength} bytes — not a multiple of ${bytesPerPoint} (rank=${rank} * float32)`,
      );
    }
    const numPoints = vertexBytes.byteLength / bytesPerPoint;
    const positions = reinterpretBytes(
      vertexBytes,
      "float32",
      numPoints * rank,
    ) as Float32Array;

    const propertyValuesPerPoint = await Promise.all(
      attributeNames.map(async (name, i) => {
        const url = joinBaseUrlAndPath(
          baseUrl,
          `attributes/${name}/${chunkKey}/${CHUNK_DATA_FILE}`,
        );
        const response = await this.sharedKvStoreContext.kvStoreContext.read(
          url,
          { signal },
        );
        if (response === undefined) {
          throw new Error(
            `zarr-vectors: chunk ${chunkKey} has vertices but property ${JSON.stringify(name)} is missing`,
          );
        }
        const bytes = await maybeDecompress(
          new Uint8Array(await response.response.arrayBuffer()),
          signal,
        );
        return reinterpretBytes(bytes, attributeDtypes[i], numPoints);
      }),
    );

    const baseId =
      BigInt(
        chunkLinearIndex(
          chunkGridPosition,
          (this.spec as any).upperChunkBound as ArrayLike<number> | undefined,
        ),
      ) << 32n;
    const ids = new Array<string>(numPoints);
    for (let i = 0; i < numPoints; ++i) {
      ids[i] = (baseId | BigInt(i)).toString();
    }

    chunk.data = buildPointAnnotationGeometryData(
      rank,
      numPoints,
      positions,
      propertyValuesPerPoint,
      ids,
      parent.annotationPropertySerializer,
    );
  }
}

@registerSharedObject()
export class ZarrVectorsAnnotationSourceBackend extends WithParameters(
  WithSharedKvStoreContextCounterpart(AnnotationSource),
  ZarrVectorsAnnotationSourceParameters,
) {
  annotationPropertySerializer = new AnnotationPropertySerializer(
    this.parameters.rank,
    annotationTypeHandlers[this.parameters.type].serializedBytes(
      this.parameters.rank,
    ),
    this.parameters.properties,
  );

  // No relationships / by-id lookup in v1 — these methods are required
  // by the AnnotationSource interface but never invoked for a
  // point-only datasource without relationships.
  async downloadSegmentFilteredGeometry(): Promise<void> {
    throw new Error(
      "zarr-vectors datasource: segment-filtered annotation queries are not supported",
    );
  }

  async downloadMetadata(): Promise<void> {
    throw new Error(
      "zarr-vectors datasource: per-id annotation metadata lookup is not supported",
    );
  }
}
