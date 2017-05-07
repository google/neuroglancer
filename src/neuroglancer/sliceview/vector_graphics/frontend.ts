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
import {NavigationState} from 'neuroglancer/navigation_state';
import {VECTOR_GRAPHICS_RENDERLAYER_RPC_ID, VectorGraphicsChunkSource as VectorGraphicsChunkSourceInterface, VectorGraphicsChunkSpecification, VectorGraphicsSourceOptions} from 'neuroglancer/sliceview/vector_graphics/base';
import {SharedObjectWithVisibilityCount} from 'neuroglancer/shared_visibility_count/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {MultiscaleSliceViewChunkSource, SliceViewChunk, SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/panel';
import {RenderLayer as GenericSliceViewRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3, vec3Key} from 'neuroglancer/util/geom';
import {stableStringify} from 'neuroglancer/util/json';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {GL_ARRAY_BUFFER, GL_FLOAT} from 'neuroglancer/webgl/constants';
import {makeWatchableShaderError, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {FramebufferConfiguration, makeTextureBuffers, StencilBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {setVec4FromUint32} from 'neuroglancer/webgl/shader_lib';
import {registerSharedObjectOwner, RPC, RpcId, SharedObject} from 'neuroglancer/worker_rpc';

const tempMat4 = mat4.create();

export abstract class RenderLayer extends GenericSliceViewRenderLayer {
  sources: VectorGraphicsChunkSource[][];
  shader: ShaderProgram|undefined = undefined;
  shaderUpdated = true;
  rpcId: RpcId|null = null;
  shaderError: WatchableShaderError;
  private sharedObject: SharedObject;

  constructor(
      multiscaleSource: MultiscaleVectorGraphicsChunkSource,
      {shaderError = makeWatchableShaderError(), sourceOptions = <VectorGraphicsSourceOptions> {}} = {}) {
    super(multiscaleSource.chunkManager, multiscaleSource.getSources(sourceOptions), {
      shaderError = makeWatchableShaderError(),
    } = {});

    let gl = this.gl;

    let sharedObject = this.registerDisposer(new SharedObject());
    sharedObject.RPC_TYPE_ID = VECTOR_GRAPHICS_RENDERLAYER_RPC_ID;
    sharedObject.initializeCounterpart(this.chunkManager.rpc!, {'sources': this.sourceIds});
    this.rpcId = sharedObject.rpcId;
  }

  defineShader(builder: ShaderBuilder) {
    builder.addFragmentCode(`
void emit(vec4 color) {
  gl_FragColor = color;
}
void emitRGBA(vec4 rgba) {
  emit(vec4(rgba.rgb, rgba.a * uOpacity));
}
void emitRGB(vec3 rgb) {
  emit(vec4(rgb, uOpacity));
}
void emitGrayscale(float value) {
  emit(vec4(value, value, value, uOpacity));
}
void emitTransparent() {
  emit(vec4(0.0, 0.0, 0.0, 0.0));
}
`);
  }

  beginSlice(_sliceView: SliceView) {
    let gl = this.gl;

    let shader = this.shader!;
    shader.bind();
    return shader;
  }

  abstract endSlice(shader: ShaderProgram): void

  abstract draw(sliceView: SliceView): void 
}

export class VectorGraphicsChunk extends SliceViewChunk {
  source: VectorGraphicsChunkSource;
  vertexPositions: Float32Array;
  vertexBuffer: Buffer;
  numPoints: number;

  constructor(source: VectorGraphicsChunkSource, x: any) {
    super(source, x);
    this.vertexPositions = x['vertexPositions'];
    this.numPoints = Math.floor(this.vertexPositions.length / 3);
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    this.vertexBuffer = Buffer.fromData(gl, this.vertexPositions, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.vertexBuffer.dispose();
  }
}

export abstract class VectorGraphicsChunkSource extends SliceViewChunkSource implements
    VectorGraphicsChunkSourceInterface {
  chunks: Map<string, VectorGraphicsChunk>;

  constructor(chunkManager: ChunkManager, public spec: VectorGraphicsChunkSpecification) {
    super(chunkManager, spec);
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['spec'] = this.spec.toObject();
    super.initializeCounterpart(rpc, options);
  }

  getChunk(x: any): VectorGraphicsChunk {
    return new VectorGraphicsChunk(this, x);
  }

  /**
   * Specifies whether the point vertex coordinates are specified in units of voxels rather than
   * nanometers.
   */
  get pointVertexCoordinatesInVoxels() {
    return true;
  }
}

export class ParameterizedVectorGraphicsSource<Parameters> extends VectorGraphicsChunkSource {
  constructor(
      chunkManager: ChunkManager, spec: VectorGraphicsChunkSpecification, public parameters: Parameters) {
    super(chunkManager, spec);
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['parameters'] = this.parameters;
    super.initializeCounterpart(rpc, options);
  }
}

/**
 * Defines a VectorGraphicsSource for which all state is encapsulated in an object of type Parameters.
 */
export function defineParameterizedVectorGraphicsSource<Parameters>(
    parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  const newConstructor =
      class SpecializedParameterizedVectorGraphicsSource extends ParameterizedVectorGraphicsSource<Parameters> {
    constructor(
        chunkManager: ChunkManager, spec: VectorGraphicsChunkSpecification, public parameters: Parameters) {
      super(chunkManager, spec, parameters);
    }

    initializeCounterpart(rpc: RPC, options: any) {
      options['parameters'] = this.parameters;
      super.initializeCounterpart(rpc, options);
    }

    static get(chunkManager: ChunkManager, spec: VectorGraphicsChunkSpecification, parameters: Parameters) {
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

export interface MultiscaleVectorGraphicsChunkSource extends MultiscaleSliceViewChunkSource {
  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  For each scale,
   * there may be alternative sources with different chunk layouts.
   */
  getSources: (options: VectorGraphicsSourceOptions) => VectorGraphicsChunkSource[][];
}
