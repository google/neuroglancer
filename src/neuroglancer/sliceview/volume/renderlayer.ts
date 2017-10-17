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

// We use the approach described in the following paper to determine the
// intersection between the
// viewport plane and a given 3-D chunk inside of a WebGL vertex shader:
//
// A Vertex Program for Efficient Box-Plane Intersection
// Christof Rezk Salama and Adreas Kolb
// VMV 2005.
// http://www.cg.informatik.uni-siegen.de/data/Publications/2005/rezksalamaVMV2005.pdf

import {ChunkState} from '../../chunk_manager/base';
import {SliceView} from '../frontend';
import {RenderLayer as GenericSliceViewRenderLayer} from '../renderlayer';
import {VOLUME_RENDERLAYER_RPC_ID, VolumeChunkSpecification, VolumeSourceOptions} from './base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from './frontend';
import {RefCounted} from '../../util/disposable';
import {mat4, vec3, vec3Key} from '../../util/geom';
import {Buffer} from '../../webgl/buffer';
import {GL} from '../../webgl/context';
import {makeWatchableShaderError} from '../../webgl/dynamic_shader';
import {ShaderBuilder, ShaderProgram} from '../../webgl/shader';
import {getShaderType} from '../../webgl/shader_lib';
import {SharedObject} from '../../worker_rpc';

const DEBUG_VERTICES = false;

/**
 * Amount by which a computed intersection point may lie outside the [0, 1] range and still be
 * considered valid.  This needs to be non-zero in order to avoid vertex placement artifacts.
 */
const LAMBDA_EPSILON = 1e-3;


/**
 * Extra amount by which the chunk position computed in the vertex shader is shifted in the
 * direction of the component-wise absolute value of the plane normal.  In Neuroglancer, a
 * cross-section plane exactly on the boundary between two voxels is a common occurrence and is
 * intended to result in the display of the "next" (i.e. higher coordinate) plane rather than the
 * "previous" (lower coordinate) plane.  However, due to various sources of floating point
 * inaccuracy (in particular, shader code which has relaxed rules), values exactly on the boundary
 * between voxels may be slightly shifted in either direction.  To ensure that this doesn't result
 * in the display of the wrong data (i.e. the previous rather than next plane), we always shift
 * toward the "next" plane by this small amount.
 */
const CHUNK_POSITION_EPSILON = 1e-3;

/**
 * If the absolute value of the dot product of a cube edge direction and the viewport plane normal
 * is less than this value, intersections along that cube edge will be exluded.  This needs to be
 * non-zero in order to avoid vertex placement artifacts.
 */
const ORTHOGONAL_EPSILON = 1e-3;

function findFrontVertexIndex(planeNormal: vec3) {
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

export const glsl_getPositionWithinChunk = `
vec3 getPositionWithinChunk () {
  return floor(min(vChunkPosition, uChunkDataSize - 1.0));
}
`;


const tempVec3 = vec3.create();
const tempVec3b = vec3.create();
const tempMat4 = mat4.create();

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
}

class VolumeSliceVertexComputationManager extends RefCounted {
  data: SliceViewShaderBuffers;
  static get(gl: GL) {
    return gl.memoize.get(
        'volume.VolumeSliceVertexComputationManager',
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

    // Chunk size in voxels.
    builder.addUniform('highp vec3', 'uChunkDataSize');

    // Size of a voxel in nanometers.
    builder.addUniform('highp vec3', 'uVoxelSize');

    builder.addUniform('highp vec3', 'uLowerClipBound');
    builder.addUniform('highp vec3', 'uUpperClipBound');

    // Position within chunk of vertex, in floating point range [0, chunkDataSize].
    builder.addVarying('highp vec3', 'vChunkPosition');

    builder.setVertexMain(`
vec3 chunkSize = uChunkDataSize * uVoxelSize;
int vertexIndex = int(aVertexIndexFloat);
for (int e = 0; e < 4; ++e) {
  highp ivec2 vidx = uVertexIndex[vertexIndex*4 + e];
  highp vec3 v1 = max(uLowerClipBound, min(uUpperClipBound, chunkSize * uVertexBasePosition[vidx.x] + uTranslation));
  highp vec3 v2 = max(uLowerClipBound, min(uUpperClipBound, chunkSize * uVertexBasePosition[vidx.y] + uTranslation));
  highp vec3 vDir = v2 - v1;
  highp float denom = dot(vDir, uPlaneNormal);
  if (abs(denom) > ${ORTHOGONAL_EPSILON}) {
    highp float lambda = (uPlaneDistance - dot(v1, uPlaneNormal)) / denom;
    if ((lambda >= -${LAMBDA_EPSILON}) && (lambda <= (1.0 + ${LAMBDA_EPSILON}))) {
      lambda = clamp(lambda, 0.0, 1.0);
      highp vec3 position = v1 + lambda * vDir;
      gl_Position = uProjectionMatrix * vec4(position, 1.0);
      vChunkPosition = (position - uTranslation) / uVoxelSize + ${CHUNK_POSITION_EPSILON} * abs(uPlaneNormal);
      break;
    }
  }
}
`);

    builder.addFragmentCode(glsl_getPositionWithinChunk);
  }

  computeVerticesDebug(
      uChunkDataSize: vec3, uVoxelSize: vec3, uLowerClipBound: vec3, uUpperClipBound: vec3,
      uPlaneDistance: number, uPlaneNormal: vec3, uTranslation: vec3, uProjectionMatrix: mat4) {
    let chunkSize = vec3.multiply(vec3.create(), uChunkDataSize, uVoxelSize);
    let frontVertexIndex = findFrontVertexIndex(uPlaneNormal);
    let uVertexIndex =
        this.data.vertexIndices.subarray(frontVertexIndex * 48, (frontVertexIndex + 1) * 48);
    let vidx = [0, 0];
    let v = [vec3.create(), vec3.create()];
    let vDir = vec3.create(), position = vec3.create(), gl_Position = vec3.create(),
        vChunkPosition = vec3.create(),
        planeNormalAbs = vec3.fromValues(
            Math.abs(uPlaneNormal[0]), Math.abs(uPlaneNormal[1]), Math.abs(uPlaneNormal[2]));
    let vertexBasePositions = new Float32Array(this.data.vertexBasePositions);
    let uVertexBasePosition = (i: number) => <vec3>vertexBasePositions.subarray(i * 3, i * 3 + 3);
    for (let vertexIndex = 0; vertexIndex < 6; ++vertexIndex) {
      for (let e = 0; e < 4; ++e) {
        for (let j = 0; j < 2; ++j) {
          vidx[j] = uVertexIndex[2 * (vertexIndex * 4 + e) + j];
          vec3.multiply(v[j], chunkSize, uVertexBasePosition(vidx[j]));
          vec3.add(v[j], v[j], uTranslation);
          vec3.min(v[j], v[j], uUpperClipBound);
          vec3.max(v[j], v[j], uLowerClipBound);
        }
        vec3.subtract(vDir, v[1], v[0]);
        let denom = vec3.dot(vDir, uPlaneNormal);
        if (Math.abs(denom) > ORTHOGONAL_EPSILON) {
          let lambda = (uPlaneDistance - vec3.dot(v[0], uPlaneNormal)) / denom;
          if ((lambda >= -LAMBDA_EPSILON) && (lambda <= 1.0 + LAMBDA_EPSILON)) {
            lambda = Math.max(0, Math.min(1, lambda));
            vec3.scaleAndAdd(position, v[0], vDir, lambda);
            vec3.transformMat4(gl_Position, position, uProjectionMatrix);
            vec3.sub(vChunkPosition, position, uTranslation);
            vec3.divide(vChunkPosition, vChunkPosition, uVoxelSize);
            vec3.scaleAndAdd(
                vChunkPosition, vChunkPosition, planeNormalAbs, CHUNK_POSITION_EPSILON);
            console.log(
                `vertex ${vertexIndex}, e = ${e}, at ${gl_Position}, ` +
                `vChunkPosition = ${vChunkPosition}, edge dir = ${vDir}, denom = ${denom}`);
            break;
          } else {
            console.log(
                `vertex ${vertexIndex}, e = ${e}, skipped, deom = ${denom}, ` +
                `vDir = ${vec3Key(vDir)}, ` +
                `uPlaneNormal = ${vec3Key(uPlaneNormal)}, ` +
                `lambda=${lambda}`);
          }
        } else {
          console.log(
              `vertex ${vertexIndex}, e = ${e}, skipped, deom = ${denom}, ` +
              `vDir = ${vec3Key(vDir)}, uPlaneNormal = ${vec3Key(uPlaneNormal)}`);
        }
      }
    }
  }

  beginSlice(_gl: GL, shader: ShaderProgram) {
    let aVertexIndexFloat = shader.attribute('aVertexIndexFloat');
    this.data.outputVertexIndices.bindToVertexAttrib(aVertexIndexFloat, 1);
  }

  endSlice(gl: GL, shader: ShaderProgram) {
    let aVertexIndexFloat = shader.attribute('aVertexIndexFloat');
    gl.disableVertexAttribArray(aVertexIndexFloat);
  }

  beginSource(
      gl: GL, shader: ShaderProgram, sliceView: SliceView, dataToDeviceMatrix: mat4,
      spec: VolumeChunkSpecification) {
    let {chunkLayout} = spec;

    // Compute plane normal and distance to origin in chunk layout coordindates.
    {
      const localPlaneNormal =
          chunkLayout.globalToLocalSpatialVector(tempVec3, sliceView.viewportAxes[2]);
      const planeDistanceToOrigin = vec3.dot(
          chunkLayout.globalToLocalSpatial(tempVec3b, sliceView.centerDataPosition),
          localPlaneNormal);
      gl.uniform3fv(shader.uniform('uPlaneNormal'), localPlaneNormal);
      gl.uniform1f(shader.uniform('uPlaneDistance'), planeDistanceToOrigin);

      const frontVertexIndex = findFrontVertexIndex(localPlaneNormal);
      gl.uniform2iv(
          shader.uniform('uVertexIndex'),
          this.data.vertexIndices.subarray(frontVertexIndex * 48, (frontVertexIndex + 1) * 48));
    }

    // Compute projection matrix that transforms chunk layout coordinates to device coordinates.
    gl.uniformMatrix4fv(
        shader.uniform('uProjectionMatrix'), false,
        mat4.multiply(tempMat4, dataToDeviceMatrix, chunkLayout.transform));

    gl.uniform3fv(shader.uniform('uVoxelSize'), spec.voxelSize);
    gl.uniform3fv(shader.uniform('uLowerClipBound'), spec.lowerClipBound);
    gl.uniform3fv(shader.uniform('uUpperClipBound'), spec.upperClipBound);
    if (DEBUG_VERTICES) {
      (<any>window)['debug_sliceView_uVoxelSize'] = spec.voxelSize;
      (<any>window)['debug_sliceView_uLowerClipBound'] = spec.lowerClipBound;
      (<any>window)['debug_sliceView_uUpperClipBound'] = spec.upperClipBound;
      (<any>window)['debug_sliceView'] = sliceView;
      (<any>window)['debug_sliceView_dataToDevice'] = dataToDeviceMatrix;
    }
  }

  setupChunkDataSize(gl: GL, shader: ShaderProgram, chunkDataSize: vec3) {
    gl.uniform3fv(shader.uniform('uChunkDataSize'), chunkDataSize);

    if (DEBUG_VERTICES) {
      (<any>window)['debug_sliceView_chunkDataSize'] = chunkDataSize;
    }
  }

  drawChunk(gl: GL, shader: ShaderProgram, chunkPosition: vec3) {
    gl.uniform3fv(shader.uniform('uTranslation'), chunkPosition);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);

    if (DEBUG_VERTICES) {
      let sliceView: SliceView = (<any>window)['debug_sliceView'];
      let chunkDataSize: vec3 = (<any>window)['debug_sliceView_chunkDataSize'];
      let voxelSize: vec3 = (<any>window)['debug_sliceView_uVoxelSize'];
      let lowerClipBound: vec3 = (<any>window)['debug_sliceView_uLowerClipBound'];
      let upperClipBound: vec3 = (<any>window)['debug_sliceView_uUpperClipBound'];
      console.log(
          `Drawing chunk: ${vec3Key(chunkPosition)} of data size ${vec3Key(chunkDataSize)}`);
      let dataToDeviceMatrix: mat4 = (<any>window)['debug_sliceView_dataToDevice'];
      this.computeVerticesDebug(
          chunkDataSize, voxelSize, lowerClipBound, upperClipBound,
          sliceView.viewportPlaneDistanceToOrigin, sliceView.viewportAxes[2], chunkPosition,
          dataToDeviceMatrix);
    }
  }
}

export class RenderLayer extends GenericSliceViewRenderLayer {
  sources: VolumeChunkSource[][];
  vertexComputationManager: VolumeSliceVertexComputationManager;
  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      {shaderError = makeWatchableShaderError(), sourceOptions = <VolumeSourceOptions> {}} = {}) {
    super(multiscaleSource.chunkManager, multiscaleSource.getSources(sourceOptions), {shaderError});

    let gl = this.gl;
    this.vertexComputationManager = VolumeSliceVertexComputationManager.get(gl);

    let sharedObject = this.registerDisposer(new SharedObject());
    sharedObject.RPC_TYPE_ID = VOLUME_RENDERLAYER_RPC_ID;
    sharedObject.initializeCounterpart(this.chunkManager.rpc!, {'sources': this.sourceIds});
    this.rpcId = sharedObject.rpcId;
  }

  get dataType() {
    return this.sources![0][0].spec.dataType;
  }

  get chunkFormat() {
    return this.sources![0][0].chunkFormat;
  }

  getValueAt(position: vec3) {
    for (let alternatives of this.sources!) {
      for (let source of alternatives) {
        let result = source.getValueAt(position);
        if (result != null) {
          return result;
        }
      }
    }
    return null;
  }

  getShader() {
    let key = this.getShaderKey() + '/' + this.chunkFormat.shaderKey;
    return this.gl.memoize.get(key, () => this.buildShader());
  }

  defineShader(builder: ShaderBuilder) {
    this.vertexComputationManager.defineShader(builder);
    builder.addFragmentCode(`
void emit(vec4 color) {
  gl_FragData[0] = color;
}
`);
    this.chunkFormat.defineShader(builder);
    builder.addFragmentCode(`
${getShaderType(this.dataType)} getDataValue() { return getDataValue(0); }
`);
  }

  beginSlice(_sliceView: SliceView) {
    let gl = this.gl;

    let shader = this.shader!;
    shader.bind();
    this.vertexComputationManager.beginSlice(gl, shader);
    return shader;
  }

  endSlice(shader: ShaderProgram) {
    let gl = this.gl;
    this.vertexComputationManager.endSlice(gl, shader);
  }

  draw(sliceView: SliceView) {
    let visibleSources = sliceView.visibleLayers.get(this)!;
    if (visibleSources.length === 0) {
      return;
    }

    this.initializeShader();
    if (this.shader === undefined) {
      return;
    }

    let gl = this.gl;

    let chunkPosition = vec3.create();
    let shader = this.beginSlice(sliceView);
    let vertexComputationManager = this.vertexComputationManager;

    // All sources are required to have the same texture format.
    let chunkFormat = this.chunkFormat;
    chunkFormat.beginDrawing(gl, shader);

    for (let _source of visibleSources) {
      let source = _source as VolumeChunkSource;
      let chunkLayout = source.spec.chunkLayout;
      let chunks = source.chunks;

      let originalChunkSize = chunkLayout.size;

      let chunkDataSize: vec3|undefined;
      let visibleChunks = sliceView.visibleChunks.get(chunkLayout);
      if (!visibleChunks) {
        continue;
      }

      vertexComputationManager.beginSource(
          gl, shader, sliceView, sliceView.dataToDevice, source.spec);
      let sourceChunkFormat = source.chunkFormat;
      sourceChunkFormat.beginSource(gl, shader);

      let setChunkDataSize = (newChunkDataSize: vec3) => {
        chunkDataSize = newChunkDataSize;
        vertexComputationManager.setupChunkDataSize(gl, shader, chunkDataSize);
      };

      for (let key of visibleChunks) {
        let chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          let newChunkDataSize = chunk.chunkDataSize;
          if (newChunkDataSize !== chunkDataSize) {
            setChunkDataSize(newChunkDataSize);
          }

          vec3.multiply(chunkPosition, originalChunkSize, chunk.chunkGridPosition);
          sourceChunkFormat.bindChunk(gl, shader, chunk);
          vertexComputationManager.drawChunk(gl, shader, chunkPosition);
        }
      }
    }
    chunkFormat.endDrawing(gl, shader);
    this.endSlice(shader);
  }
}
