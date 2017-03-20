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

import {ChunkManager, registerChunkSource} from 'neuroglancer/chunk_manager/backend';
import {ChunkPriorityTier} from 'neuroglancer/chunk_manager/base';
import {GenericFileSource, PriorityGetter} from 'neuroglancer/chunk_manager/generic_file_source';
import {GET_NIFTI_VOLUME_INFO_RPC_ID, NiftiDataType, NiftiVolumeInfo, VolumeSourceParameters} from 'neuroglancer/datasource/nifti/base';
import {ParameterizedVolumeChunkSource, VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {DataType, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {mat4, quat, vec3} from 'neuroglancer/util/geom';
import {registerPromiseRPC, RPCPromise} from 'neuroglancer/worker_rpc';
import {decompress, isCompressed, NIFTI1, NIFTI2, readHeader, readImage} from 'nifti-reader-js';

export class NiftiFileData {
  uncompressedData: ArrayBuffer;
  header: NIFTI1|NIFTI2;
}

function decodeNiftiFile(buffer: ArrayBuffer) {
  if (isCompressed(buffer)) {
    buffer = decompress(buffer);
  }
  let data = new NiftiFileData();
  data.uncompressedData = buffer;
  let header = readHeader(buffer);
  if (header === null) {
    throw new Error('Failed to parse NIFTI header.');
  }
  data.header = header;
  return data;
}

function getNiftiFileData(
    chunkManager: ChunkManager, url: string, getPriority: PriorityGetter,
    cancellationToken: CancellationToken) {
  return GenericFileSource.getData(
      chunkManager, decodeNiftiFile, url, getPriority, cancellationToken);
}

const NIFTI_HEADER_INFO_PRIORITY = 1000;

/**
 * Caller must increment ref count of chunkManager.
 */
function getNiftiHeaderInfo(
    chunkManager: ChunkManager, url: string, cancellationToken: CancellationToken) {
  return getNiftiFileData(
             chunkManager, url,
             () =>
                 ({priorityTier: ChunkPriorityTier.VISIBLE, priority: NIFTI_HEADER_INFO_PRIORITY}),
             cancellationToken)
      .then(data => data.header);
}

function convertAffine(affine: number[][]) {
  return mat4.fromValues(
      affine[0][0], affine[1][0], affine[2][0], affine[3][0], affine[0][1], affine[1][1],
      affine[2][1], affine[3][1], affine[0][2], affine[1][2], affine[2][2], affine[3][2],
      affine[0][3], affine[1][3], affine[2][3], affine[3][3]);
}

const DATA_TYPE_CONVERSIONS = new Map([
  [NiftiDataType.INT8, {dataType: DataType.UINT8, volumeType: VolumeType.IMAGE}],
  [NiftiDataType.UINT8, {dataType: DataType.UINT8, volumeType: VolumeType.IMAGE}],
  [NiftiDataType.INT16, {dataType: DataType.UINT16, volumeType: VolumeType.IMAGE}],
  [NiftiDataType.UINT16, {dataType: DataType.UINT16, volumeType: VolumeType.IMAGE}],
  [NiftiDataType.INT32, {dataType: DataType.UINT32, volumeType: VolumeType.SEGMENTATION}],
  [NiftiDataType.UINT32, {dataType: DataType.UINT32, volumeType: VolumeType.SEGMENTATION}],
  [NiftiDataType.INT64, {dataType: DataType.UINT64, volumeType: VolumeType.SEGMENTATION}],
  [NiftiDataType.UINT64, {dataType: DataType.UINT64, volumeType: VolumeType.SEGMENTATION}],
  [NiftiDataType.FLOAT32, {dataType: DataType.FLOAT32, volumeType: VolumeType.IMAGE}],
]);

registerPromiseRPC(
    GET_NIFTI_VOLUME_INFO_RPC_ID, function(x, cancellationToken): RPCPromise<NiftiVolumeInfo> {
      return getNiftiHeaderInfo(
                 this.getRef<ChunkManager>(x['chunkManager']), x['url'], cancellationToken)
          .then(header => {
            let dataTypeInfo = DATA_TYPE_CONVERSIONS.get(header.datatypeCode);
            if (dataTypeInfo === undefined) {
              throw new Error(
                  `Unsupported data type: ${NiftiDataType[header.datatypeCode] ||
                  header.datatypeCode}.`);
            }
            if (header.dims[4] !== 1) {
              throw new Error(`Time series data not supported.`);
            }
            const spatialUnits = header.xyzt_units & NIFTI1.SPATIAL_UNITS_MASK;
            let unitsPerNm = 1;
            switch (spatialUnits) {
              case NIFTI1.UNITS_METER:
                unitsPerNm = 1e9;
                break;
              case NIFTI1.UNITS_MM:
                unitsPerNm = 1e6;
                break;
              case NIFTI1.UNITS_MICRON:
                unitsPerNm = 1e3;
                break;
            }
            const {quatern_b, quatern_c, quatern_d} = header;
            const quatern_a = Math.sqrt(
                1.0 - quatern_b * quatern_b - quatern_c * quatern_c - quatern_d * quatern_d);
            const qfac = header.pixDims[0] === -1 ? -1 : 1;
            let info: NiftiVolumeInfo = {
              description: header.description,
              affine: convertAffine(header.affine),
              dataType: dataTypeInfo.dataType,
              numChannels: header.dims[5],
              volumeType: dataTypeInfo.volumeType,
              voxelSize: vec3.fromValues(
                  unitsPerNm * header.pixDims[1], unitsPerNm * header.pixDims[2],
                  unitsPerNm * header.pixDims[3]),
              volumeSize: vec3.fromValues(header.dims[1], header.dims[2], header.dims[3]),
              qoffset: vec3.fromValues(
                  unitsPerNm * header.qoffset_x, unitsPerNm * header.qoffset_y,
                  unitsPerNm * header.qoffset_z),
              qform_code: header.qform_code,
              sform_code: header.sform_code,
              qfac: qfac,
              quatern: quat.fromValues(quatern_b, quatern_c, quatern_d, quatern_a),
            };
            return {value: info};
          });
    });

@registerChunkSource(VolumeSourceParameters)
class VolumeChunkSource extends ParameterizedVolumeChunkSource<VolumeSourceParameters> {
  download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    chunk.chunkDataSize = this.spec.chunkDataSize;
    return getNiftiFileData(
               this.chunkManager.addRef(), this.parameters.url,
               () => ({priorityTier: chunk.priorityTier, priority: chunk.priority}),
               cancellationToken)
        .then(data => {
          let imageBuffer = readImage(data.header, data.uncompressedData);
          decodeRawChunk(
              chunk, imageBuffer, data.header.littleEndian ? Endianness.LITTLE : Endianness.BIG);
        });
  }
}
