/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { NIFTI2 } from "nifti-reader-js";
import { isCompressed, NIFTI1, readHeader, readImage } from "nifti-reader-js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import { getCachedDecodedUrl } from "#src/chunk_manager/generic_file_source.js";
import type { NiftiVolumeInfo } from "#src/datasource/nifti/base.js";
import {
  GET_NIFTI_VOLUME_INFO_RPC_ID,
  VolumeSourceParameters,
} from "#src/datasource/nifti/base.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { ReadResponse } from "#src/kvstore/index.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { DataType } from "#src/sliceview/volume/base.js";
import { Endianness } from "#src/util/endian.js";
import {
  kOneVec,
  mat4,
  quat,
  translationRotationScaleZReflectionToMat4,
  vec3,
} from "#src/util/geom.js";
import { decodeGzip } from "#src/util/gzip.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import type { RPCPromise } from "#src/worker_rpc.js";
import { registerPromiseRPC, registerSharedObject } from "#src/worker_rpc.js";

export class NiftiFileData {
  uncompressedData: ArrayBuffer;
  header: NIFTI1 | NIFTI2;
}

async function decodeNiftiFile(
  readResponse: ReadResponse | undefined,
  options: ProgressOptions,
) {
  if (readResponse === undefined) {
    throw new Error("Not found");
  }
  let buffer = await readResponse.response.arrayBuffer();
  if (isCompressed(buffer)) {
    buffer = await decodeGzip(buffer, "gzip", options.signal);
  }
  const data = new NiftiFileData();
  data.uncompressedData = buffer;
  const header = readHeader(buffer);
  if (header === null) {
    throw new Error("Failed to parse NIFTI header.");
  }
  data.header = header;
  return { data, size: buffer.byteLength };
}

function getNiftiFileData(
  sharedKvStoreContextCounterpart: SharedKvStoreContextCounterpart,
  url: string,
  options: Partial<ProgressOptions>,
) {
  return getCachedDecodedUrl(
    sharedKvStoreContextCounterpart,
    url,
    decodeNiftiFile,
    options,
  );
}

async function getNiftiHeaderInfo(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  url: string,
  options: Partial<ProgressOptions>,
) {
  const data = await getNiftiFileData(sharedKvStoreContext, url, options);
  return data.header;
}

function convertAffine(affine: number[][]) {
  return mat4.fromValues(
    affine[0][0],
    affine[1][0],
    affine[2][0],
    affine[3][0],
    affine[0][1],
    affine[1][1],
    affine[2][1],
    affine[3][1],
    affine[0][2],
    affine[1][2],
    affine[2][2],
    affine[3][2],
    affine[0][3],
    affine[1][3],
    affine[2][3],
    affine[3][3],
  );
}

enum NiftiDataType {
  NONE = 0,
  BINARY = 1,
  UINT8 = 2,
  INT16 = 4,
  INT32 = 8,
  FLOAT32 = 16,
  COMPLEX64 = 32,
  FLOAT64 = 64,
  RGB24 = 128,
  INT8 = 256,
  UINT16 = 512,
  UINT32 = 768,
  INT64 = 1024,
  UINT64 = 1280,
  FLOAT128 = 1536,
  COMPLEX128 = 1792,
  COMPLEX256 = 2048,
}

const DATA_TYPE_CONVERSIONS = new Map([
  [NiftiDataType.INT8, { dataType: DataType.INT8 }],
  [NiftiDataType.UINT8, { dataType: DataType.UINT8 }],
  [NiftiDataType.INT16, { dataType: DataType.INT16 }],
  [NiftiDataType.UINT16, { dataType: DataType.UINT16 }],
  [NiftiDataType.INT32, { dataType: DataType.INT32 }],
  [NiftiDataType.UINT32, { dataType: DataType.UINT32 }],
  [NiftiDataType.INT64, { dataType: DataType.UINT64 }],
  [NiftiDataType.UINT64, { dataType: DataType.UINT64 }],
  [NiftiDataType.FLOAT32, { dataType: DataType.FLOAT32 }],
]);

registerPromiseRPC(
  GET_NIFTI_VOLUME_INFO_RPC_ID,
  async function (x, progressOptions): RPCPromise<NiftiVolumeInfo> {
    const sharedKvStoreContext = this.get(
      x.sharedKvStoreContext,
    ) as SharedKvStoreContextCounterpart;
    const header = await getNiftiHeaderInfo(
      sharedKvStoreContext,
      x.url,
      progressOptions,
    );
    const dataTypeInfo = DATA_TYPE_CONVERSIONS.get(header.datatypeCode);
    if (dataTypeInfo === undefined) {
      throw new Error(
        "Unsupported data type: " +
          `${NiftiDataType[header.datatypeCode] || header.datatypeCode}.`,
      );
    }
    let spatialInvScale = 1;
    let spatialUnit = "";
    switch (header.xyzt_units & NIFTI1.SPATIAL_UNITS_MASK) {
      case NIFTI1.UNITS_METER:
        spatialInvScale = 1;
        spatialUnit = "m";
        break;
      case NIFTI1.UNITS_MM:
        spatialInvScale = 1e3;
        spatialUnit = "m";
        break;
      case NIFTI1.UNITS_MICRON:
        spatialInvScale = 1e6;
        spatialUnit = "m";
        break;
    }

    let timeUnit = "";
    let timeInvScale = 1;
    switch (header.xyzt_units & NIFTI1.TEMPORAL_UNITS_MASK) {
      case NIFTI1.UNITS_SEC:
        timeUnit = "s";
        timeInvScale = 1;
        break;
      case NIFTI1.UNITS_MSEC:
        timeUnit = "s";
        timeInvScale = 1e3;
        break;
      case NIFTI1.UNITS_USEC:
        timeUnit = "s";
        timeInvScale = 1e6;
        break;
      case NIFTI1.UNITS_HZ:
        timeUnit = "Hz";
        timeInvScale = 1;
        break;
      case NIFTI1.UNITS_RADS:
        timeUnit = "rad/s";
        timeInvScale = 1;
        break;
    }
    let units: string[] = [
      spatialUnit,
      spatialUnit,
      spatialUnit,
      timeUnit,
      "",
      "",
      "",
    ];
    let sourceScales = Float64Array.of(
      header.pixDims[1] / spatialInvScale,
      header.pixDims[2] / spatialInvScale,
      header.pixDims[3] / spatialInvScale,
      header.pixDims[4] / timeInvScale,
      header.pixDims[5],
      header.pixDims[6],
      header.pixDims[7],
    );
    let viewScales = Float64Array.of(
      1 / spatialInvScale,
      1 / spatialInvScale,
      1 / spatialInvScale,
      1 / timeInvScale,
      1,
      1,
      1,
    );
    let sourceNames = ["i", "j", "k", "m", "c^", "c1^", "c2^"];
    let viewNames = ["x", "y", "z", "t", "c^", "c1^", "c2^"];
    const rank = header.dims[0];
    sourceNames = sourceNames.slice(0, rank);
    viewNames = viewNames.slice(0, rank);
    units = units.slice(0, rank);
    sourceScales = sourceScales.slice(0, rank);
    viewScales = viewScales.slice(0, rank);
    const { quatern_b, quatern_c, quatern_d } = header;
    const quatern_a = Math.sqrt(
      1.0 -
        quatern_b * quatern_b -
        quatern_c * quatern_c -
        quatern_d * quatern_d,
    );
    const qfac = header.pixDims[0] === -1 ? -1 : 1;
    const qoffset = vec3.fromValues(
      header.qoffset_x,
      header.qoffset_y,
      header.qoffset_z,
    );
    // https://nifti.nimh.nih.gov/nifti-1/documentation/nifti1fields/nifti1fields_pages/qsform.html
    const method3Transform = convertAffine(header.affine);
    method3Transform;
    const method2Transform = translationRotationScaleZReflectionToMat4(
      mat4.create(),
      qoffset,
      quat.fromValues(quatern_b, quatern_c, quatern_d, quatern_a),
      kOneVec,
      qfac,
    );
    const transform = matrix.createIdentity(Float64Array, rank + 1);
    const copyRank = Math.min(3, rank);
    for (let row = 0; row < copyRank; ++row) {
      for (let col = 0; col < copyRank; ++col) {
        transform[col * (rank + 1) + row] = method2Transform[col * 4 + row];
      }
      transform[rank * (rank + 1) + row] = method2Transform[12 + row];
    }
    const info: NiftiVolumeInfo = {
      rank,
      sourceNames,
      viewNames,
      units,
      sourceScales,
      viewScales,
      description: header.description,
      transform,
      dataType: dataTypeInfo.dataType,
      volumeSize: Uint32Array.from(header.dims.slice(1, 1 + rank)),
    };
    return { value: info };
  },
);

@registerSharedObject()
export class NiftiVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  VolumeSourceParameters,
) {
  async download(chunk: VolumeChunk, signal: AbortSignal) {
    chunk.chunkDataSize = this.spec.chunkDataSize;
    const data = await getNiftiFileData(
      this.sharedKvStoreContext,
      this.parameters.url,
      { signal },
    );
    const imageBuffer = readImage(data.header, data.uncompressedData);
    await decodeRawChunk(
      chunk,
      signal,
      imageBuffer,
      data.header.littleEndian ? Endianness.LITTLE : Endianness.BIG,
    );
  }
}
