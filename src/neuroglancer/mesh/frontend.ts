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

import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {vec3, vec4, mat4, Vec3, Mat4} from 'neuroglancer/util/geom';
import {PerspectiveViewRenderLayer, PerspectiveViewRenderContext, perspectivePanelEmit} from 'neuroglancer/perspective_panel';
import {GL} from 'neuroglancer/webgl/context';
import {setVec4FromUint32} from 'neuroglancer/webgl/shader_lib';
import {ChunkManager, Chunk, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {RPC, SharedObject} from 'neuroglancer/worker_rpc';

export class MeshShaderManager {
  private tempLightVec = vec4.create();
  private tempPickID = new Float32Array(4);
  constructor() {}

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.addAttribute('highp vec3', 'aVertexNormal');
    builder.addVarying('highp vec3', 'vColor');
    builder.addUniform('highp vec4', 'uLightDirection');
    builder.addUniform('highp vec3', 'uColor');
    builder.addUniform('highp mat4', 'uModelMatrix');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp vec4', 'uPickID');
    builder.require(perspectivePanelEmit);
    builder.setVertexMain(`
gl_Position = uProjection * (uModelMatrix * vec4(aVertexPosition, 1.0));
vec3 normal = (uModelMatrix * vec4(aVertexNormal, 0.0)).xyz;
float lightingFactor = abs(dot(normal, uLightDirection.xyz)) + uLightDirection.w;
vColor = lightingFactor * uColor;
`);
    builder.setFragmentMain(`emit(vec4(vColor, 1.0), uPickID);`);
  }

  beginLayer(gl: GL, shader: ShaderProgram, renderContext: PerspectiveViewRenderContext) {
    let {dataToDevice, lightDirection, ambientLighting, directionalLighting} = renderContext;
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, dataToDevice);
    let lightVec = this.tempLightVec;
    vec3.scale(lightVec, lightDirection, directionalLighting);
    lightVec[3] = ambientLighting;
    gl.uniform4fv(shader.uniform('uLightDirection'), lightVec);
  }

  beginObject(
      gl: GL, shader: ShaderProgram, objectToDataMatrix: Mat4, color: Vec3, pickID: number) {
    gl.uniformMatrix4fv(shader.uniform('uModelMatrix'), false, objectToDataMatrix);
    gl.uniform4fv(shader.uniform('uPickID'), setVec4FromUint32(this.tempPickID, pickID));
    gl.uniform3fv(shader.uniform('uColor'), color);
  }

  getShader(gl: GL) {
    return gl.memoize.get('mesh/MeshShaderManager', () => {
      let builder = new ShaderBuilder(gl);
      this.defineShader(builder);
      return builder.build();
    });
  }

  drawFragment(gl: GL, shader: ShaderProgram, fragmentChunk: FragmentChunk) {
    fragmentChunk.vertexBuffer.bindToVertexAttrib(
        shader.attribute('aVertexPosition'),
        /*components=*/3);

    fragmentChunk.normalBuffer.bindToVertexAttrib(
        shader.attribute('aVertexNormal'),
        /*components=*/3);
    fragmentChunk.indexBuffer.bind();
    gl.drawElements(gl.TRIANGLES, fragmentChunk.numIndices, gl.UNSIGNED_INT, 0);
  }
  endLayer(gl: GL, shader: ShaderProgram) {
    gl.disableVertexAttribArray(shader.attribute('aVertexPosition'));
    gl.disableVertexAttribArray(shader.attribute('aVertexNormal'));
  }
};

export class MeshLayer extends PerspectiveViewRenderLayer {
  private meshShaderManager = new MeshShaderManager();
  private shader = this.registerDisposer(this.meshShaderManager.getShader(this.gl));

  constructor(
      public chunkManager: ChunkManager, public source: MeshSource,
      public displayState: SegmentationDisplayState) {
    super();

    let dispatchRedrawNeeded = () => { this.redrawNeeded.dispatch(); };
    this.registerSignalBinding(displayState.segmentColorHash.changed.add(dispatchRedrawNeeded));
    this.registerSignalBinding(displayState.visibleSegments.changed.add(dispatchRedrawNeeded));
    this.registerSignalBinding(
        displayState.segmentSelectionState.changed.add(dispatchRedrawNeeded));

    let sharedObject = this.registerDisposer(new SharedObject());
    sharedObject.initializeCounterpart(chunkManager.rpc, {
      'type': 'mesh/MeshLayer',
      'chunkManager': chunkManager.rpcId,
      'source': source.addCounterpartRef(),
      'visibleSegmentSet': displayState.visibleSegments.rpcId
    });
    this.setReady(true);
  }

  get gl() { return this.chunkManager.chunkQueueManager.gl; }

  draw(renderContext: PerspectiveViewRenderContext) {
    let gl = this.gl;
    let shader = this.shader;
    shader.bind();
    let {meshShaderManager} = this;
    meshShaderManager.beginLayer(gl, shader, renderContext);

    let objectChunks = this.source.fragmentSource.objectChunks;

    let {pickIDs} = renderContext;

    // FIXME: this maybe should change
    let objectToDataMatrix = mat4.create();
    mat4.identity(objectToDataMatrix);

    let color = vec3.create();
    let {displayState} = this;
    let {segmentColorHash, segmentSelectionState} = displayState;

    for (let objectId of displayState.visibleSegments) {
      let objectKey = `${objectId.low}:${objectId.high}`;
      let fragments = objectChunks.get(objectKey);
      if (fragments === undefined) {
        continue;
      }
      segmentColorHash.compute(color, objectId);
      if (segmentSelectionState.isSelected(objectId)) {
        for (let i = 0; i < 3; ++i) {
          color[i] = color[i] * 0.5 + 0.5;
        }
      }
      meshShaderManager.beginObject(
          gl, shader, objectToDataMatrix, color, pickIDs.register(this, objectId));
      for (let fragment of fragments) {
        if (fragment.state === ChunkState.GPU_MEMORY) {
          meshShaderManager.drawFragment(gl, shader, fragment);
        }
      }
    }

    meshShaderManager.endLayer(gl, shader);
  }
};

function makeNormals(positions: Float32Array, indices: Uint32Array) {
  let faceNormal = vec3.create();
  let v1v0 = vec3.create();
  let v2v1 = vec3.create();
  let vertexNormals = new Float32Array(positions.length);
  let vertexFaceCount = new Float32Array(positions.length / 3);
  let numIndices = indices.length;
  for (let i = 0; i < numIndices; i += 3) {
    for (let j = 0; j < 3; ++j) {
      vertexFaceCount[indices[i + j]] += 1;
    }
  }
  for (let i = 0; i < numIndices; i += 3) {
    let i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    for (let j = 0; j < 3; ++j) {
      v1v0[j] = positions[i1 + j] - positions[i0 + j];
      v2v1[j] = positions[i2 + j] - positions[i1 + j];
    }
    vec3.cross(faceNormal, v1v0, v2v1);
    vec3.normalize(faceNormal, faceNormal);

    for (let k = 0; k < 3; ++k) {
      let index = indices[i + k];
      let scalar = 1.0 / vertexFaceCount[index];
      let offset = index * 3;
      for (let j = 0; j < 3; ++j) {
        vertexNormals[offset + j] += scalar * faceNormal[j];
      }
    }
  }
  // Normalize all vertex normals.
  let numVertices = vertexNormals.length;
  for (let i = 0; i < numVertices; i += 3) {
    let vec = vertexNormals.subarray(i, 3);
    vec3.normalize(vec, vec);
  }
  return vertexNormals;
}

export class FragmentChunk extends Chunk {
  data: Uint8Array;
  objectKey: string;
  source: FragmentSource;
  vertexBuffer: Buffer;
  indexBuffer: Buffer;
  normalBuffer: Buffer;
  numIndices: number;

  constructor(source: FragmentSource, x: any) {
    super(source);
    this.objectKey = x['objectKey'];
    this.data = x['data'];
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    let {data} = this;
    let dv = new DataView(data.buffer);

    let numVertices = dv.getInt32(0, true);
    let positions = new Float32Array(data.buffer, 4, numVertices * 3);
    // 4 * 3 bytes per vertex position + 4 byte offset due to numVertices.
    let indices = new Uint32Array(data.buffer, 4 + 12 * numVertices);
    this.vertexBuffer = Buffer.fromData(gl, positions, gl.ARRAY_BUFFER, gl.STATIC_DRAW);

    this.indexBuffer = Buffer.fromData(gl, indices, gl.ELEMENT_ARRAY_BUFFER, gl.STATIC_DRAW);
    this.numIndices = indices.length;

    // console.log('positions', positions);
    // console.log('indices', indices);

    let normals = makeNormals(positions, indices);
    this.normalBuffer = Buffer.fromData(gl, normals, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.vertexBuffer.dispose();
    this.indexBuffer.dispose();
    this.normalBuffer.dispose();
  }
};

export class FragmentSource extends ChunkSource {
  objectChunks = new Map<string, Set<FragmentChunk>>();
  constructor(chunkManager: ChunkManager, public meshSource: MeshSource) {
    super(chunkManager);
    this.initializeCounterpart(chunkManager.rpc, {'type': 'mesh/FragmentSource'});
  }
  addChunk(key: string, chunk: FragmentChunk) {
    super.addChunk(key, chunk);
    let {objectChunks} = this;
    let {objectKey} = chunk;
    let fragments = objectChunks.get(objectKey);
    if (fragments === undefined) {
      fragments = new Set();
      objectChunks.set(objectKey, fragments);
    }
    fragments.add(chunk);
  }
  deleteChunk(key: string) {
    let chunk = <FragmentChunk>this.chunks.get(key);
    super.deleteChunk(key);
    let {objectChunks} = this;
    let {objectKey} = chunk;
    let fragments = objectChunks.get(objectKey);
    fragments.delete(chunk);
    if (fragments.size === 0) {
      objectChunks.delete(objectKey);
    }
  }

  getChunk(x: any) { return new FragmentChunk(this, x); }
};

export abstract class MeshSource extends ChunkSource {
  fragmentSource = new FragmentSource(this.chunkManager, this);
  initializeCounterpart(rpc: RPC, options: any) {
    options['fragmentSource'] = this.fragmentSource.addCounterpartRef();
    super.initializeCounterpart(rpc, options);
  }
};
