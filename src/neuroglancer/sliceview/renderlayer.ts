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
 
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {RenderLayer as GenericRenderLayer} from 'neuroglancer/layer';
import {SLICEVIEW_RENDERLAYER_RPC_ID, SliceViewChunkSpecification, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {SliceView, SliceViewChunkSource, MultiscaleSliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {RefCounted} from 'neuroglancer/util/disposable';
import {BoundingBox, mat4, vec3, vec3Key, vec4} from 'neuroglancer/util/geom';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {makeWatchableShaderError, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';
import {RpcId, SharedObject} from 'neuroglancer/worker_rpc';


export class SliceViewShaderBuffers extends RefCounted {
  outputVertexIndices: Buffer;
  vertexBasePositions: number[];
  vertexIndices: Int32Array;
  constructor(gl: GL) {
    super();
    this.outputVertexIndices = this.registerDisposer(
        Buffer.fromData(gl, new Float32Array([0, 1, 2, 3, 4, 5]), gl.ARRAY_BUFFER, gl.STATIC_DRAW));

    // This specifies the original, "uncorrected" vertex positions.
    // var vertexBasePositions = [
    //   0, 0, 0,
    //   1, 0, 0,
    //   0, 1, 0,
    //   0, 0, 1,
    //   1, 0, 1,
    //   1, 1, 0,
    //   0, 1, 1,
    //   1, 1, 1,
    // ];

    // This specifies the "corrected" vertex positions.
    this.vertexBasePositions = [
      0, 0, 0,  //
      1, 0, 0,  //
      0, 1, 0,  //
      1, 1, 0,  //
      0, 0, 1,  //
      1, 0, 1,  //
      0, 1, 1,  //
      1, 1, 1,  //
    ];

    // correct_index, vertex_position, uncorrected_index
    // 0:  0, 0, 0   0
    // 1:  1, 0, 0   1
    // 2:  0, 1, 0   2
    // 4:  0, 0, 1   3
    // 5:  1, 0, 1   4
    // 3:  1, 1, 0   5
    // 6:  0, 1, 1   6
    // 7:  1, 1, 1   7

    // This maps uncorrected vertex indices to corrected vertex indices.
    let vertexUncorrectedToCorrected = [0, 1, 2, 4, 5, 3, 6, 7];

    // This maps corrected vertex indices to uncorrected vertex indices.
    let vertexCorrectedToUncorrected = [0, 1, 2, 5, 3, 4, 6, 7];


    // Page 666
    let vertexBaseIndices = [
      0, 1, 1, 4, 4, 7, 4, 7,  //
      1, 5, 0, 1, 1, 4, 4, 7,  //
      0, 2, 2, 5, 5, 7, 5, 7,  //
      2, 6, 0, 2, 2, 5, 5, 7,  //
      0, 3, 3, 6, 6, 7, 6, 7,  //
      3, 4, 0, 3, 3, 6, 6, 7,  //
    ];

    // Determined by looking at the figure and determining the corresponding
    // vertex order for each possible front vertex.
    let vertexPermutation = [
      0, 1, 2, 3, 4, 5, 6, 7,  //
      1, 4, 5, 0, 3, 7, 2, 6,  //
      2, 6, 0, 5, 7, 3, 1, 4,  //
      3, 0, 6, 4, 1, 2, 7, 5,  //
      4, 3, 7, 1, 0, 6, 5, 2,  //
      5, 2, 1, 7, 6, 0, 4, 3,  //
      6, 7, 3, 2, 5, 4, 0, 1,  //
      7, 5, 4, 6, 2, 1, 3, 0,  //
    ];

    let vertexIndices: number[] = [];
    for (var p = 0; p < 8; ++p) {
      for (var i = 0; i < vertexBaseIndices.length; ++i) {
        const vertexPermutationIndex = vertexCorrectedToUncorrected[p] * 8 + vertexBaseIndices[i];
        vertexIndices.push(vertexUncorrectedToCorrected[vertexPermutation[vertexPermutationIndex]]);
      }
    }

    this.vertexIndices = new Int32Array(vertexIndices);
  }

  static get(gl: GL) {
    return gl.memoize.get('SliceViewShaderBuffers', () => new SliceViewShaderBuffers(gl));
  }
};

const tempVec3 = vec3.create();
const tempVec3b = vec3.create();
const tempMat4 = mat4.create();

export abstract class RenderLayer extends GenericRenderLayer {
  chunkManager: ChunkManager;
  sources: SliceViewChunkSource[][]|null = null;
  shader: ShaderProgram|undefined = undefined;
  shaderUpdated = true;
  rpcId: RpcId|null = null;
  shaderError: WatchableShaderError;
  constructor(chunkManager: ChunkManager, spec: SliceViewChunkSpecification, {
    shaderError = makeWatchableShaderError(),
  } = {}) {
    super();

    this.shaderError = shaderError;
    shaderError.value = undefined;
    this.chunkManager = chunkManager;
    let gl = this.gl;

    let {chunkLayout} = spec;

    const voxelSize = this.voxelSize =
        chunkLayout.localSpatialVectorToGlobal(vec3.create(), spec.voxelSize);
    for (let i = 0; i < 3; ++i) {
      voxelSize[i] = Math.abs(voxelSize[i]);
    }

    const boundingBox = this.boundingBox = new BoundingBox(
        vec3.fromValues(Infinity, Infinity, Infinity),
        vec3.fromValues(-Infinity, -Infinity, -Infinity));
    const globalCorner = vec3.create();
    const localCorner = tempVec3;

    for (let cornerIndex = 0; cornerIndex < 8; ++cornerIndex) {
      for (let i = 0; i < 3; ++i) {
        localCorner[i] = cornerIndex & (1 << i) ? spec.upperClipBound[i] : spec.lowerClipBound[i];
      }
      chunkLayout.localSpatialToGlobal(globalCorner, localCorner);
      vec3.min(boundingBox.lower, boundingBox.lower, globalCorner);
      vec3.max(boundingBox.upper, boundingBox.upper, globalCorner);
    }
    this.setReady(true);
  }

  get gl() { return this.chunkManager.chunkQueueManager.gl; }

  initializeShader() {
    if (!this.shaderUpdated) {
      return;
    }
    this.shaderUpdated = false;
    try {
      let newShader = this.getShader();
      this.disposeShader();
      this.shader = newShader;
      this.shaderError.value = null;
    } catch (shaderError) {
      this.shaderError.value = shaderError;
    }
  }

  disposeShader() {
    if (this.shader) {
      this.shader.dispose();
      this.shader = undefined;
    }
  }

  disposed() {
    super.disposed();
    this.disposeShader();
  }

  getShaderKey() { return ''; }

  getShader() {
    let key = this.getShaderKey(); 
    return this.gl.memoize.get(key, () => this.buildShader());
  }

  buildShader() {
    let builder = new ShaderBuilder(this.gl);
    this.defineShader(builder);
    return builder.build();
  }

  abstract defineShader(builder: ShaderBuilder): void

  abstract beginSlice(_sliceView: SliceView): ShaderProgram 

  abstract endSlice(shader: ShaderProgram): void 

  abstract draw(sliceView: SliceView): void 
}