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

import 'neuroglancer/datasource/brainmaps/api_backend';

import {handleChunkDownloadPromise} from 'neuroglancer/chunk_manager/backend';
import {VolumeChunkEncoding} from 'neuroglancer/datasource/brainmaps/base';
import {makeRequest, BrainmapsInstance, INSTANCE_IDENTIFIERS} from 'neuroglancer/datasource/brainmaps/api';
import {VolumeChunk, VolumeChunkSource as GenericVolumeChunkSource} from 'neuroglancer/sliceview/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeCompressedSegmentationChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/compressed_segmentation';
import {vec3Key} from 'neuroglancer/util/geom';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {RPC, registerSharedObject} from 'neuroglancer/worker_rpc';

const CHUNK_DECODERS = new Map<VolumeChunkEncoding, ChunkDecoder>();
CHUNK_DECODERS.set(VolumeChunkEncoding.RAW, decodeRawChunk);
CHUNK_DECODERS.set(VolumeChunkEncoding.JPEG, decodeJpegChunk);
CHUNK_DECODERS.set(VolumeChunkEncoding.COMPRESSED_SEGMENTATION, decodeCompressedSegmentationChunk);

const ENCOODING_NAMES = new Map<VolumeChunkEncoding, string>();
ENCOODING_NAMES.set(VolumeChunkEncoding.RAW, 'subvolumeFormat=raw');
ENCOODING_NAMES.set(VolumeChunkEncoding.JPEG, 'subvolumeFormat=single_image/imageFormat=jpeg');

class VolumeChunkSource extends GenericVolumeChunkSource {
  instance: BrainmapsInstance;
  key: string;
  scaleIndex: number;
  encoding: VolumeChunkEncoding;
  encodingParams: string;
  chunkDecoder: ChunkDecoder;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.instance = options['instance'];
    this.key = options['key'];
    this.scaleIndex = options['scaleIndex'];
    this.encoding = options['encoding'];
    this.chunkDecoder = CHUNK_DECODERS.get(this.encoding);
    this.encodingParams = ENCOODING_NAMES.get(this.encoding);
  }

  download(chunk: VolumeChunk) {
    let path: string;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let {chunkDataSize} = chunk;
      path = `/v1beta2/volumes/${this.key}/binary/subvolume/corner=${vec3Key(chunkPosition)}/size=${vec3Key(chunkDataSize)}/scale=${this.scaleIndex}/changeStackId=/${this.encodingParams}?alt=media`;
    }
    handleChunkDownloadPromise(
        chunk, makeRequest(this.instance, 'GET', path, 'arraybuffer'), this.chunkDecoder);
  }
  toString() { return `brainmaps-${INSTANCE_IDENTIFIERS[this.instance]}:volume:${this.key}`; }
};
registerSharedObject('brainmaps/VolumeChunkSource', VolumeChunkSource);

