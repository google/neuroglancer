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

import {ChunkSourceParametersConstructor, ChunkState} from 'neuroglancer/chunk_manager/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {LayerManager} from 'neuroglancer/layer';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {NavigationState} from 'neuroglancer/navigation_state';
import {DataType, SliceViewBase} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {MultiscaleSliceViewChunkSource, SliceView, SliceViewChunk, SliceViewChunkSource, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {RenderLayer as GenericRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {VolumeChunkSource as VolumeChunkSourceInterface, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Disposable} from 'neuroglancer/util/disposable';
import {mat4, rectifyTransformMatrixIfAxisAligned, vec3, vec3Key, vec4} from 'neuroglancer/util/geom';
import {stableStringify} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, makeTextureBuffers, StencilBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {registerSharedObjectOwner, RPC} from 'neuroglancer/worker_rpc';

export type VolumeChunkKey = string;

const tempMat = mat4.create();

const tempChunkGridPosition = vec3.create();
const tempLocalPosition = vec3.create();


export interface ChunkFormat {
  shaderKey: string;

  /**
   * Called on the ChunkFormat of the first source of a RenderLayer.
   *
   * This should define a fragment shader function:
   *
   *   value_type getDataValue(int channelIndex);
   *
   * where value_type is the shader data type corresponding to the chunk data type.  This function
   * should retrieve the value for channel `channelIndex` at position `getPositionWithinChunk()`
   * within the chunk.
   */
  defineShader: (builder: ShaderBuilder) => void;

  /**
   * Called once per RenderLayer when starting to draw chunks, on the ChunkFormat of the first
   * source.  This is not called before each source is drawn.
   */
  beginDrawing: (gl: GL, shader: ShaderProgram) => void;

  /**
   * Called once after all chunks have been drawn, on the ChunkFormat of the first source.
   */
  endDrawing: (gl: GL, shader: ShaderProgram) => void;

  /**
   * Called just before drawing each chunk, on the ChunkFormat .
   */
  bindChunk: (gl: GL, shader: ShaderProgram, chunk: SliceViewChunk) => void;

  /**
   * Called just before drawing chunks for the source.
   */
  beginSource: (gl: GL, shader: ShaderProgram) => void;
}

export interface ChunkFormatHandler extends Disposable {
  chunkFormat: ChunkFormat;
  getChunk(source: SliceViewChunkSource, x: any): SliceViewChunk;
}

export type ChunkFormatHandlerFactory = (gl: GL, spec: VolumeChunkSpecification) =>
    ChunkFormatHandler | null;

var chunkFormatHandlers = new Array<ChunkFormatHandlerFactory>();

export function registerChunkFormatHandler(factory: ChunkFormatHandlerFactory) {
  chunkFormatHandlers.push(factory);
}

export function getChunkFormatHandler(gl: GL, spec: VolumeChunkSpecification) {
  for (let handler of chunkFormatHandlers) {
    let result = handler(gl, spec);
    if (result != null) {
      return result;
    }
  }
  throw new Error('No chunk format handler found.');
}


export abstract class VolumeChunkSource extends SliceViewChunkSource implements
    VolumeChunkSourceInterface {
  chunkFormatHandler: ChunkFormatHandler;

  chunks: Map<string, VolumeChunk>;

  constructor(chunkManager: ChunkManager, public spec: VolumeChunkSpecification) {
    super(chunkManager, spec);
    this.chunkFormatHandler =
        this.registerDisposer(getChunkFormatHandler(chunkManager.chunkQueueManager.gl, spec));
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['spec'] = this.spec.toObject();
    super.initializeCounterpart(rpc, options);
  }

  get chunkFormat() {
    return this.chunkFormatHandler.chunkFormat;
  }

  getValueAt(position: vec3) {
    const chunkGridPosition = tempChunkGridPosition;
    const localPosition = tempLocalPosition;
    let spec = this.spec;
    let chunkLayout = spec.chunkLayout;
    let chunkSize = chunkLayout.size;
    chunkLayout.globalToLocalSpatial(localPosition, position);
    for (let i = 0; i < 3; ++i) {
      const chunkSizeValue = chunkSize[i];
      const localPositionValue = localPosition[i];
      chunkGridPosition[i] = Math.floor(localPositionValue / chunkSizeValue);
    }
    let key = vec3Key(chunkGridPosition);
    let chunk = <VolumeChunk>this.chunks.get(key);
    if (!chunk) {
      return null;
    }
    // Reuse temporary variable.
    const dataPosition = chunkGridPosition;
    const voxelSize = spec.voxelSize;
    for (let i = 0; i < 3; ++i) {
      dataPosition[i] =
          Math.floor((localPosition[i] - chunkGridPosition[i] * chunkSize[i]) / voxelSize[i]);
    }
    let chunkDataSize = chunk.chunkDataSize;
    for (let i = 0; i < 3; ++i) {
      if (dataPosition[i] >= chunkDataSize[i]) {
        return undefined;
      }
    }
    let {numChannels} = spec;
    if (numChannels === 1) {
      return chunk.getChannelValueAt(dataPosition, 0);
    } else {
      let result = new Array<number|Uint64>(numChannels);
      for (let i = 0; i < numChannels; ++i) {
        result[i] = chunk.getChannelValueAt(dataPosition, i);
      }
      return result;
    }
  }

  getChunk(x: any): VolumeChunk {
    return <VolumeChunk>this.chunkFormatHandler.getChunk(this, x);
  }
};

/**
 * Defines a VolumeChunkSource for which all state, other than the VolumeChunkSpecification, is
 * encapsulated in an object of type Parameters.
 */
export function defineParameterizedVolumeChunkSource<Parameters>(
    parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  const newConstructor = class ParameterizedVolumeChunkSource extends VolumeChunkSource {
    constructor(
        chunkManager: ChunkManager, spec: VolumeChunkSpecification, public parameters: Parameters) {
      super(chunkManager, spec);
    }
    initializeCounterpart(rpc: RPC, options: any) {
      options['parameters'] = this.parameters;
      super.initializeCounterpart(rpc, options);
    }
    static get(chunkManager: ChunkManager, spec: VolumeChunkSpecification, parameters: Parameters) {
      return chunkManager.getChunkSource(
          this, stableStringify({parameters, spec: spec.toObject()}),
          () => new this(chunkManager, spec, parameters));
    }
    toString() {
      return parametersConstructor.stringify(this.parameters);
    }
  };
  newConstructor.prototype.RPC_TYPE_ID = parametersConstructor.RPC_ID;
  return newConstructor;
}

export abstract class VolumeChunk extends SliceViewChunk {
  source: VolumeChunkSource;

  get chunkFormat() {
    return this.source.chunkFormat;
  }

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
  }
  abstract getChannelValueAt(dataPosition: vec3, channel: number): any;
};


export interface MultiscaleVolumeChunkSource extends MultiscaleSliceViewChunkSource {
  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  For each scale,
   * there may be alternative sources with different chunk layouts.
   */
  getSources: (options: VolumeSourceOptions) => VolumeChunkSource[][];

  numChannels: number;
  dataType: DataType;
  volumeType: VolumeType;

  /**
   * Returns the associated mesh source, if there is one.
   *
   * This only makes sense if volumeType === VolumeType.SEGMENTATION.
   */
  getMeshSource: () => MeshSource | null;
}
