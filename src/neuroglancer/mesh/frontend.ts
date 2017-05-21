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
import {FRAGMENT_SOURCE_RPC_ID, MESH_LAYER_RPC_ID} from 'neuroglancer/mesh/base';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {forEachSegmentToDraw, getObjectColor, registerRedrawWhenSegmentationDisplayState3DChanged, SegmentationDisplayState3D, SegmentationLayerSharedObject} from 'neuroglancer/segmentation_display_state/frontend';
import {mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {stableStringify} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {setVec4FromUint32} from 'neuroglancer/webgl/shader_lib';
import {registerSharedObjectOwner, RPC} from 'neuroglancer/worker_rpc';

export class MeshShaderManager {
  private tempLightVec = new Float32Array(4);
  private tempPickID = new Float32Array(4);
  constructor() {}

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.addAttribute('highp vec3', 'aVertexNormal');
    builder.addVarying('highp vec4', 'vColor');
    builder.addUniform('highp vec4', 'uLightDirection');
    builder.addUniform('highp vec4', 'uColor');
    builder.addUniform('highp mat4', 'uModelMatrix');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp vec4', 'uPickID');
    builder.setVertexMain(`
gl_Position = uProjection * (uModelMatrix * vec4(aVertexPosition, 1.0));
vec3 normal = (uModelMatrix * vec4(aVertexNormal, 0.0)).xyz;
float lightingFactor = abs(dot(normal, uLightDirection.xyz)) + uLightDirection.w;
vColor = vec4(lightingFactor * uColor.rgb, uColor.a);
`);
    builder.setFragmentMain(`emit(vColor, uPickID);`);
  }

  beginLayer(gl: GL, shader: ShaderProgram, renderContext: PerspectiveViewRenderContext) {
    let {dataToDevice, lightDirection, ambientLighting, directionalLighting} = renderContext;
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, dataToDevice);
    let lightVec = <vec3>this.tempLightVec;
    vec3.scale(lightVec, lightDirection, directionalLighting);
    lightVec[3] = ambientLighting;
    gl.uniform4fv(shader.uniform('uLightDirection'), lightVec);
  }

  setColor(gl: GL, shader: ShaderProgram, color: vec4) {
    gl.uniform4fv(shader.uniform('uColor'), color);
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform4fv(shader.uniform('uPickID'), setVec4FromUint32(this.tempPickID, pickID));
  }

  beginObject(gl: GL, shader: ShaderProgram, objectToDataMatrix: mat4) {
    gl.uniformMatrix4fv(shader.uniform('uModelMatrix'), false, objectToDataMatrix);
  }

  getShader(gl: GL, emitter: ShaderModule) {
    return gl.memoize.get(`mesh/MeshShaderManager:${getObjectId(emitter)}`, () => {
      let builder = new ShaderBuilder(gl);
      builder.require(emitter);
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
}

export class MeshLayer extends PerspectiveViewRenderLayer {
  private meshShaderManager = new MeshShaderManager();
  private shaders = new Map<ShaderModule, ShaderProgram>();
  private sharedObject: SegmentationLayerSharedObject;

  constructor(
      public chunkManager: ChunkManager, public source: MeshSource,
      public displayState: SegmentationDisplayState3D) {
    super();

    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);

    let sharedObject = this.sharedObject =
        this.registerDisposer(new SegmentationLayerSharedObject(chunkManager, displayState));
    sharedObject.RPC_TYPE_ID = MESH_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      'source': source.addCounterpartRef(),
    });
    this.setReady(true);
    sharedObject.visibility.add(this.visibility);
  }

  private getShader(emitter: ShaderModule) {
    let {shaders} = this;
    let shader = shaders.get(emitter);
    if (shader === undefined) {
      shader = this.registerDisposer(this.meshShaderManager.getShader(this.gl, emitter));
      shaders.set(emitter, shader);
    }
    return shader;
  }

  get isTransparent() {
    return this.displayState.objectAlpha.value < 1.0;
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  draw(renderContext: PerspectiveViewRenderContext) {
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      // No need for a separate pick ID pass.
      return;
    }
    let {gl, displayState, meshShaderManager} = this;
    let alpha = Math.min(1.0, displayState.objectAlpha.value);
    if (alpha <= 0.0) {
      // Skip drawing.
      return;
    }
    let shader = this.getShader(renderContext.emitter);
    shader.bind();
    meshShaderManager.beginLayer(gl, shader, renderContext);

    let objectChunks = this.source.fragmentSource.objectChunks;

    let {pickIDs} = renderContext;

    const objectToDataMatrix = this.displayState.objectToDataTransform.transform;

    forEachSegmentToDraw(displayState, objectChunks, (rootObjectId, objectId, fragments) => {
      if (renderContext.emitColor) {
        meshShaderManager.setColor(gl, shader, getObjectColor(displayState, rootObjectId, alpha));
      }
      if (renderContext.emitPickID) {
        meshShaderManager.setPickID(gl, shader, pickIDs.registerUint64(this, objectId));
      }
      meshShaderManager.beginObject(gl, shader, objectToDataMatrix);
      for (let fragment of fragments) {
        if (fragment.state === ChunkState.GPU_MEMORY) {
          meshShaderManager.drawFragment(gl, shader, fragment);
        }
      }
    });

    meshShaderManager.endLayer(gl, shader);
  }
}

export class FragmentChunk extends Chunk {
  vertexPositions: Float32Array;
  indices: Uint32Array;
  vertexNormals: Float32Array;
  objectKey: string;
  source: FragmentSource;
  vertexBuffer: Buffer;
  indexBuffer: Buffer;
  normalBuffer: Buffer;
  numIndices: number;

  constructor(source: FragmentSource, x: any) {
    super(source);
    this.objectKey = x['objectKey'];
    this.vertexPositions = x['vertexPositions'];
    let indices = this.indices = x['indices'];
    this.numIndices = indices.length;
    this.vertexNormals = x['vertexNormals'];
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    this.vertexBuffer = Buffer.fromData(gl, this.vertexPositions, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
    this.indexBuffer = Buffer.fromData(gl, this.indices, gl.ELEMENT_ARRAY_BUFFER, gl.STATIC_DRAW);
    this.normalBuffer = Buffer.fromData(gl, this.vertexNormals, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.vertexBuffer.dispose();
    this.indexBuffer.dispose();
    this.normalBuffer.dispose();
  }
}

export abstract class MeshSource extends ChunkSource {
  fragmentSource = this.registerDisposer(new FragmentSource(this.chunkManager, this));
  initializeCounterpart(rpc: RPC, options: any) {
    this.fragmentSource.initializeCounterpart(this.chunkManager.rpc!, {});
    options['fragmentSource'] = this.fragmentSource.addCounterpartRef();
    super.initializeCounterpart(rpc, options);
  }
}

@registerSharedObjectOwner(FRAGMENT_SOURCE_RPC_ID)
export class FragmentSource extends ChunkSource {
  objectChunks = new Map<string, Set<FragmentChunk>>();
  constructor(chunkManager: ChunkManager, public meshSource: MeshSource) {
    super(chunkManager);
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
    let fragments = objectChunks.get(objectKey)!;
    fragments.delete(chunk);
    if (fragments.size === 0) {
      objectChunks.delete(objectKey);
    }
  }
  getChunk(x: any) {
    return new FragmentChunk(this, x);
  }
}

/**
 * Defines a MeshSource for which all state is encapsulated in an object of type Parameters.
 */
export function defineParameterizedMeshSource<Parameters>(
    parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  const newConstructor = class ParameterizedMeshSource extends MeshSource {
    constructor(chunkManager: ChunkManager, public parameters: Parameters) {
      super(chunkManager);
    }
    initializeCounterpart(rpc: RPC, options: any) {
      options['parameters'] = this.parameters;
      super.initializeCounterpart(rpc, options);
    }
    static get(chunkManager: ChunkManager, parameters: Parameters) {
      return chunkManager.getChunkSource(
          this, stableStringify(parameters), () => new this(chunkManager, parameters));
    }
    toString() {
      return parametersConstructor.stringify(this.parameters);
    }
  };
  newConstructor.prototype.RPC_TYPE_ID = parametersConstructor.RPC_ID;
  return newConstructor;
}
