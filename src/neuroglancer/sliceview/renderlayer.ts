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

// We use the approach described in the following paper to determine the intersection between the
// viewport plane and a given 3-D chunk inside of a WebGL vertex shader:
//
// A Vertex Program for Efficient Box-Plane Intersection
// Christof Rezk Salama and Adreas Kolb
// VMV 2005.
// http://www.cg.informatik.uni-siegen.de/data/Publications/2005/rezksalamaVMV2005.pdf

import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3, vec4, Vec3, Mat4, BoundingBox} from 'neuroglancer/util/geom';
import {RenderLayer as GenericRenderLayer} from 'neuroglancer/layer';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {SliceView, VolumeChunkSource, MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {Signal} from 'signals';
import {RpcId, SharedObject} from 'neuroglancer/worker_rpc';

const DEBUG_VERTICES = false;

class SliceViewShaderBuffers extends RefCounted {
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
        vertexIndices.push(
            vertexUncorrectedToCorrected
                [vertexPermutation[vertexCorrectedToUncorrected[p] * 8 + vertexBaseIndices[i]]]);
      }
    }

    this.vertexIndices = new Int32Array(vertexIndices);
  }

  static get(gl: GL) {
    return gl.memoize.get('SliceViewShaderBuffers', () => new SliceViewShaderBuffers(gl));
  }
};

function findFrontVertexIndex(planeNormal: Vec3) {
  // Determine which vertex is front.
  let frontVertexIndex = 0;
  for (var axis_i = 0; axis_i < 3; ++axis_i) {
    // If plane normal is negative in axis direction, then choose the vertex
    // with the maximum axis_i-coordinate.
    if (planeNormal[axis_i] < 0) {
      frontVertexIndex += (1 << axis_i);
    }
  }
  return frontVertexIndex;
}

class VolumeSliceVertexComputationManager extends RefCounted {
  data: SliceViewShaderBuffers;
  static get(gl: GL) {
    return gl.memoize.get(
        'sliceview.VolumeSliceVertexComputationManager',
        () => new VolumeSliceVertexComputationManager(gl));
  }
  constructor(gl: GL) {
    super();
    this.data = this.registerDisposer(SliceViewShaderBuffers.get(gl));
  }

  defineShader(builder: ShaderBuilder) {
    let data = this.data;

    // A number in [0, 6) specifying which vertex to compute.
    builder.addAttribute('highp float', 'aVertexIndexFloat');

    // Specifies translation of the current chunk.
    builder.addUniform('highp vec3', 'uTranslation');

    // Matrix by which computed vertices will be transformed.
    builder.addUniform('highp mat4', 'uProjectionMatrix');

    // Slice plane normal.
    builder.addUniform('highp vec3', 'uPlaneNormal');

    // Distance from the origin to the slice plane.
    builder.addUniform('highp float', 'uPlaneDistance');

    // Two-dimensional array of dimensions [6x4], specifying the first and
    // second vertex index for each of the 4 candidate edges to test for each
    // computed vertex.
    builder.addUniform('highp ivec2', 'uVertexIndex', 24);

    // Base vertex positions.
    builder.addUniform('highp vec3', 'uVertexBasePosition', 8);
    builder.addInitializer(shader => {
      shader.gl.uniform3fv(
          shader.uniform('uVertexBasePosition'), new Float32Array(data.vertexBasePositions));
    });

    // Chunk size.
    builder.addUniform('highp vec3', 'uChunkSize');
    // Position within chunk of vertex.
    builder.addVarying('highp vec3', 'vChunkPosition');
    // varying highp vec2 vTexCoord;

    builder.setVertexMain(`
int vertexIndex = int(aVertexIndexFloat);
for (int e = 0; e < 4; ++e) {
  highp ivec2 vidx = uVertexIndex[vertexIndex*4 + e];
  highp vec3 v1 = uChunkSize * uVertexBasePosition[vidx.x];
  highp vec3 v2 = uChunkSize * uVertexBasePosition[vidx.y];
  highp vec3 vStart = v1 + uTranslation;
  highp vec3 vDir = v2 - v1;
  highp float denom = dot(vDir, uPlaneNormal);
  if (abs(denom) > 1e-6) {
    highp float lambda = (uPlaneDistance - dot(vStart, uPlaneNormal)) / denom;
    if ((lambda >= 0.0) && (lambda <= 1.0)) {
      highp vec3 position = vStart + lambda * vDir;
      gl_Position = uProjectionMatrix * vec4(position, 1.0);
      vChunkPosition = mix(uVertexBasePosition[vidx.x], uVertexBasePosition[vidx.y], lambda);
      break;
    }
  }
}
`);
  }

  computeVerticesDebug(
      uChunkSize: Vec3, uPlaneDistance: number, uPlaneNormal: Vec3, uTranslation: Vec3,
      uProjectionMatrix: Mat4) {
    let frontVertexIndex = findFrontVertexIndex(uPlaneNormal);
    let uVertexIndex =
        this.data.vertexIndices.subarray(frontVertexIndex * 48, (frontVertexIndex + 1) * 48);
    let vidx = [0, 0];
    let v = [vec3.create(), vec3.create()];
    let vStart = vec3.create(), vDir = vec3.create(), position = vec3.create(),
        gl_Position = vec3.create(), vChunkPosition = vec3.create();
    let vertexBasePositions = new Float32Array(this.data.vertexBasePositions);
    let uVertexBasePosition = (i: number) => vertexBasePositions.subarray(i * 3, i * 3 + 3);
    for (let vertexIndex = 0; vertexIndex < 6; ++vertexIndex) {
      for (let e = 0; e < 4; ++e) {
        for (let j = 0; j < 2; ++j) {
          vidx[j] = uVertexIndex[2 * (vertexIndex * 4 + e) + j];
          vec3.multiply(v[j], uChunkSize, uVertexBasePosition(vidx[j]));
        }
        vec3.add(vStart, v[0], uTranslation);
        vec3.subtract(vDir, v[1], v[0]);
        let denom = vec3.dot(vDir, uPlaneNormal);
        if (Math.abs(denom) > 1e-6) {
          let lambda = (uPlaneDistance - vec3.dot(vStart, uPlaneNormal)) / denom;
          if ((lambda >= 0.0) && (lambda <= 1.0)) {
            vec3.scaleAndAdd(position, vStart, vDir, lambda);
            vec3.transformMat4(
                gl_Position, vec4.fromValues(position[0], position[1], position[2], 1.0),
                uProjectionMatrix);
            vec3.scale(vChunkPosition, uVertexBasePosition(vidx[0]), 1.0 - lambda);
            vec3.scaleAndAdd(vChunkPosition, vChunkPosition, uVertexBasePosition(vidx[1]), lambda);
            console.log(
                `vertex ${vertexIndex} at ${gl_Position}, vChunkPosition = ${vChunkPosition}, edge dir = ${vDir}, denom = ${denom}`);
            break;
          }
        }
      }
    }
  }

  beginSlice(gl: GL, shader: ShaderProgram, dataToDeviceMatrix: Mat4, sliceView: SliceView) {
    let planeNormal = sliceView.viewportAxes[2];

    let frontVertexIndex = findFrontVertexIndex(planeNormal);
    gl.uniformMatrix4fv(shader.uniform('uProjectionMatrix'), false, dataToDeviceMatrix);
    gl.uniform3fv(shader.uniform('uPlaneNormal'), planeNormal.subarray(0, 3));
    gl.uniform1f(shader.uniform('uPlaneDistance'), sliceView.viewportPlaneDistanceToOrigin);

    let aVertexIndexFloat = shader.attribute('aVertexIndexFloat');
    this.data.outputVertexIndices.bindToVertexAttrib(aVertexIndexFloat, 1);

    gl.uniform2iv(
        shader.uniform('uVertexIndex'),
        this.data.vertexIndices.subarray(frontVertexIndex * 48, (frontVertexIndex + 1) * 48));

    if (DEBUG_VERTICES) {
      (<any>window)['debug_sliceView'] = sliceView;
      (<any>window)['debug_sliceView_dataToDevice'] = dataToDeviceMatrix;
    }
  }

  endSlice(gl: GL, shader: ShaderProgram) {
    let aVertexIndexFloat = shader.attribute('aVertexIndexFloat');
    gl.disableVertexAttribArray(aVertexIndexFloat);
  }

  setupChunkSize(gl: GL, shader: ShaderProgram, chunkSize: Vec3) {
    gl.uniform3fv(shader.uniform('uChunkSize'), chunkSize);

    if (DEBUG_VERTICES) {
      (<any>window)['debug_sliceView_chunkSize'] = chunkSize;
    }
  }

  drawChunk(gl: GL, shader: ShaderProgram, chunkPosition: Vec3) {
    gl.uniform3fv(shader.uniform('uTranslation'), chunkPosition);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);

    if (DEBUG_VERTICES) {
      let sliceView: SliceView = (<any>window)['debug_sliceView'];
      let chunkSize: Vec3 = (<any>window)['debug_sliceView_chunkSize'];
      let dataToDeviceMatrix: Mat4 = (<any>window)['debug_sliceView_dataToDevice'];
      this.computeVerticesDebug(
          chunkSize, sliceView.viewportPlaneDistanceToOrigin, sliceView.viewportAxes[2],
          chunkPosition, dataToDeviceMatrix);
    }
  }
};

export class RenderLayer extends GenericRenderLayer {
  sources: VolumeChunkSource[][] = null;
  shader: ShaderProgram = null;
  shaderUpdated = true;
  redrawNeeded = new Signal();
  voxelSize: Vec3 = null;
  boundingBox: BoundingBox = null;
  vertexComputationManager: VolumeSliceVertexComputationManager;
  rpcId: RpcId = null;
  constructor(
      public chunkManager: ChunkManager,
      multiscaleSourcePromise: Promise<MultiscaleVolumeChunkSource>) {
    super();
    let gl = this.gl;
    this.vertexComputationManager = VolumeSliceVertexComputationManager.get(gl);

    Promise.resolve(multiscaleSourcePromise).then(multiscaleSource => {
      let sources = this.sources = multiscaleSource.getSources(chunkManager);
      let sourceIds: number[][] = [];
      for (let alternatives of sources) {
        let alternativeIds: number[] = [];
        sourceIds.push(alternativeIds);
        for (let source of alternatives) {
          alternativeIds.push(source.rpcId);
        }
      }
      let sharedObject = this.registerDisposer(new SharedObject());
      sharedObject.initializeCounterpart(
          chunkManager.rpc, {'type': 'sliceview/RenderLayer', 'sources': sourceIds});
      this.rpcId = sharedObject.rpcId;
      let spec = this.sources[0][0].spec;
      this.voxelSize = spec.voxelSize;
      this.boundingBox = new BoundingBox(spec.lowerVoxelBound, spec.upperVoxelBound);
      this.setReady(true);
    });
  }

  get gl() { return this.chunkManager.chunkQueueManager.gl; }

  get chunkFormat() { return this.sources[0][0].chunkFormat; }

  initializeShader() {
    if (!this.shaderUpdated) {
      return;
    }
    this.shaderUpdated = false;
    let newShader = this.getShader();
    this.disposeShader();
    this.shader = newShader;
  }

  disposeShader() {
    if (this.shader) {
      this.shader.dispose();
      this.shader = null;
    }
  }

  dispose() { this.disposeShader(); }

  getValueAt(position: Vec3) {
    for (let alternatives of this.sources) {
      for (let source of alternatives) {
        let result = source.getValueAt(position);
        if (result != null) {
          return result;
        }
      }
    }
    return null;
  }

  getShaderKey() { return ''; }

  getShader() {
    let key = this.getShaderKey() + '/' + this.chunkFormat.shaderKey;
    return this.gl.memoize.get(key, () => this.buildShader());
  }

  buildShader() {
    let builder = new ShaderBuilder(this.gl);
    this.defineShader(builder);
    return builder.build();
  }

  defineShader(builder: ShaderBuilder) {
    this.vertexComputationManager.defineShader(builder);
    builder.addFragmentCode(`
void emit(vec4 color) {
  gl_FragData[0] = color;
}
`);
    this.chunkFormat.defineShader(builder);
  }

  beginSlice(sliceView: SliceView) {
    let {dataToDevice} = sliceView;
    let gl = this.gl;

    let shader = this.shader;
    shader.bind();
    this.vertexComputationManager.beginSlice(gl, shader, dataToDevice, sliceView);
    return shader;
  }

  endSlice(shader: ShaderProgram) {
    let gl = this.gl;
    this.vertexComputationManager.endSlice(gl, shader);
  }

  draw(sliceView: SliceView) {
    let visibleSources = sliceView.visibleLayers.get(this);
    if (visibleSources.length === 0) {
      return;
    }

    this.initializeShader();

    let gl = this.gl;

    let chunkPosition = vec3.create();
    let chunkSize = vec3.create();
    let shader = this.beginSlice(sliceView);
    let vertexComputationManager = this.vertexComputationManager;

    // All sources are required to have the same texture format.
    let chunkFormat = this.chunkFormat;
    chunkFormat.beginDrawing(gl, shader);

    for (let source of visibleSources) {
      let chunkLayout = source.spec.chunkLayout;
      let {offset} = chunkLayout;

      let chunks = source.chunks;

      let originalChunkSize = chunkLayout.size;

      let chunkDataSize: Vec3 = null;
      let visibleChunks = sliceView.visibleChunks.get(chunkLayout);
      if (!visibleChunks) {
        continue;
      }

      let setChunkDataSize = (newChunkDataSize: Vec3) => {
        vec3.multiply(chunkSize, newChunkDataSize, source.spec.voxelSize);
        chunkDataSize = newChunkDataSize;
        vertexComputationManager.setupChunkSize(gl, shader, chunkSize);
      };

      for (let key of visibleChunks) {
        let chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          let newChunkDataSize = chunk.chunkDataSize;
          if (newChunkDataSize !== chunkDataSize) {
            setChunkDataSize(newChunkDataSize);
          }

          vec3.multiply(chunkPosition, originalChunkSize, chunk.chunkGridPosition);
          vec3.add(chunkPosition, chunkPosition, offset);
          chunkFormat.bindChunk(gl, shader, chunk);
          vertexComputationManager.drawChunk(gl, shader, chunkPosition);
        }
      }
    }
    chunkFormat.endDrawing(gl, shader);
    this.endSlice(shader);
  }
};
