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
import {POINT_RENDERLAYER_RPC_ID, PointChunkSource as PointChunkSourceInterface, PointChunkSpecification, PointSourceOptions} from 'neuroglancer/point/base';
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
import {makeWatchableShaderError, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {FramebufferConfiguration, makeTextureBuffers, StencilBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {registerSharedObjectOwner, RPC, RpcId, SharedObject} from 'neuroglancer/worker_rpc';

const tempMat4 = mat4.create();

export class RenderLayer extends GenericSliceViewRenderLayer {
  shader: ShaderProgram|undefined = undefined;
  shaderUpdated = true;
  rpcId: RpcId|null = null;
  shaderError: WatchableShaderError;
  private sharedObject: SharedObject;

  private tempMat = mat4.create();

  constructor(
      multiscaleSource: MultiscalePointChunkSource,
      {shaderError = makeWatchableShaderError(), sourceOptions = <PointSourceOptions> {}} = {}) {
    super(multiscaleSource.chunkManager, multiscaleSource.getSources(sourceOptions)[0][0].spec, {
      shaderError = makeWatchableShaderError(),
    } = {});

    let gl = this.gl;

    let sources = this.sources = multiscaleSource.getSources(sourceOptions);
    let sourceIds: number[][] = [];
    for (let alternatives of sources) {
      let alternativeIds: number[] = [];
      sourceIds.push(alternativeIds);
      for (let source of alternatives) {
        alternativeIds.push(source.rpcId!);
      }
    }

    let sharedObject = this.registerDisposer(new SharedObject());
    sharedObject.RPC_TYPE_ID = POINT_RENDERLAYER_RPC_ID;
    sharedObject.initializeCounterpart(this.chunkManager.rpc!, {'sources': sourceIds});
    this.rpcId = sharedObject.rpcId;
  }

  defineShader(builder: ShaderBuilder) {
    builder.addFragmentCode(`
void emit(vec4 color) {
  gl_FragData[0] = color;
}
`);

    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.addUniform('highp vec3', 'uColor');
    builder.addUniform('highp mat4', 'uProjection');
    builder.setVertexMain(`gl_Position = uProjection * vec4(aVertexPosition, 1.0);`);
    builder.setFragmentMain(`emit(vec4(uColor.rgb, 1.0));`);
  }

  beginSlice(_sliceView: SliceView) {
    let gl = this.gl;

    let shader = this.shader!;
    shader.bind();
    return shader;
  }

  endSlice(shader: ShaderProgram) {
    let gl = this.gl;
    gl.disableVertexAttribArray(shader.attribute('aVertexPosition'));
  }

  draw(sliceView: SliceView) {
    let visibleSources = sliceView.visibleLayers.get(this)!;
    if (visibleSources.length === 0) {
      return;
    }

    this.initializeShader();
    if (this.shader === undefined) {
      console.log('error: shader undefined');
      return;
    }

    let gl = this.gl;

    let shader = this.beginSlice(sliceView);

    // All sources are required to have the same texture format.
    for (let _source of visibleSources) {
      let source = _source as PointChunkSource;
      let chunkLayout = source.spec.chunkLayout;
      let chunks = source.chunks;

      // Compute projection matrix that transforms vertex coordinates to device coordinates
      gl.uniformMatrix4fv(
          shader.uniform('uProjection'), false,
          mat4.multiply(tempMat4, sliceView.dataToDevice, chunkLayout.transform));

      let chunkDataSize: vec3|undefined;
      let visibleChunks = sliceView.visibleChunks.get(chunkLayout);
      if (!visibleChunks) {
        continue;
      }

      for (let key of visibleChunks) {
        let chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          chunk.vertexBuffer.bindToVertexAttrib(
              shader.attribute('aVertexPosition'),
              /*components=*/3);
          // gl.drawArrays(gl.POINTS, 0, chunk.numPoints);
          gl.drawArrays(gl.LINES, 0, chunk.numPoints);
        }
      }
    }
    this.endSlice(shader);
  }
}

export class PointChunk extends SliceViewChunk {
  source: PointChunkSource;
  vertexPositions: Float32Array;
  vertexBuffer: Buffer;
  numPoints: number;

  constructor(source: PointChunkSource, x: any) {
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
};

export abstract class PointChunkSource extends SliceViewChunkSource implements
    PointChunkSourceInterface {
  chunks: Map<string, PointChunk>;

  constructor(chunkManager: ChunkManager, public spec: PointChunkSpecification) {
    super(chunkManager, spec);
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['spec'] = this.spec.toObject();
    super.initializeCounterpart(rpc, options);
  }

  getChunk(x: any): PointChunk {
    return new PointChunk(this, x);
  }

  /**
   * Specifies whether the point vertex coordinates are specified in units of voxels rather than
   * nanometers.
   */
  get pointVertexCoordinatesInVoxels() {
    return true;
  }
};

export class ParameterizedPointSource<Parameters> extends PointChunkSource {
  constructor(
      chunkManager: ChunkManager, spec: PointChunkSpecification, public parameters: Parameters) {
    super(chunkManager, spec);
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['parameters'] = this.parameters;
    super.initializeCounterpart(rpc, options);
  }
};

/**
 * Defines a PointSource for which all state is encapsulated in an object of type Parameters.
 */
export function defineParameterizedPointSource<Parameters>(
    parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  const newConstructor =
      class SpecializedParameterizedPointSource extends ParameterizedPointSource<Parameters> {
    constructor(
        chunkManager: ChunkManager, spec: PointChunkSpecification, public parameters: Parameters) {
      super(chunkManager, spec, parameters);
    }

    initializeCounterpart(rpc: RPC, options: any) {
      options['parameters'] = this.parameters;
      super.initializeCounterpart(rpc, options);
    }

    static get(chunkManager: ChunkManager, spec: PointChunkSpecification, parameters: Parameters) {
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

export interface MultiscalePointChunkSource extends MultiscaleSliceViewChunkSource {
  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  For each scale,
   * there may be alternative sources with different chunk layouts.
   */
  getSources: (options: PointSourceOptions) => PointChunkSource[][];
}
