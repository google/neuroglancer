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
import {Chunk, ChunkManager, ChunkSource, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {GET_SINGLE_MESH_INFO_RPC_ID, SINGLE_MESH_CHUNK_KEY, SINGLE_MESH_LAYER_RPC_ID, SingleMeshInfo, SingleMeshSourceParameters, SingleMeshSourceParametersWithInfo, VertexAttributeInfo} from 'neuroglancer/single_mesh/base';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {DataType} from 'neuroglancer/util/data_type';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseArray, stableStringify, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {Uint64} from 'neuroglancer/util/uint64';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {Buffer} from 'neuroglancer/webgl/buffer';
import glsl_COLORMAPS from 'neuroglancer/webgl/colormaps.glsl';
import {GL} from 'neuroglancer/webgl/context';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {CountingBuffer, countingBufferShaderModule, disableCountingBuffer, getCountingBuffer, IndexBufferAttributeHelper, makeIndexBuffer} from 'neuroglancer/webgl/index_emulation';
import {ShaderBuilder, ShaderModule, ShaderProgram, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';
import {compute1dTextureLayout, computeTextureFormat, getSamplerPrefixForDataType, OneDimensionalTextureAccessHelper, setOneDimensionalTextureData, TextureFormat} from 'neuroglancer/webgl/texture_access';
import {SharedObject} from 'neuroglancer/worker_rpc';

export const FRAGMENT_MAIN_START = '//NEUROGLANCER_SINGLE_MESH_LAYER_FRAGMENT_MAIN_START';

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitGray();
}
`;

export type TrackableFragmentMain = TrackableValue<string>;

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return new TrackableValue<string>(value, verifyString);
}

export type TrackableAttributeNames = TrackableValue<Array<string|undefined>>;

export function getTrackableAttributeNames() {
  return new TrackableValue<Array<string|undefined>>([], x => parseArray(x, verifyOptionalString));
}

export class SingleMeshDisplayState {
  shaderError = makeWatchableShaderError();
  fragmentMain = getTrackableFragmentMain();
  attributeNames = getTrackableAttributeNames();
  objectToDataTransform = new CoordinateTransform();
}

export function getShaderAttributeType(info: {dataType: DataType, numComponents: number}) {
  return getShaderType(info.dataType, info.numComponents);
}

const vertexAttributeSamplerSymbols: Symbol[] = [];

const vertexPositionTextureFormat = computeTextureFormat(new TextureFormat(), DataType.FLOAT32, 3);
const vertexNormalTextureFormat = vertexPositionTextureFormat;

export class SingleMeshShaderManager {
  private tempLightVec = new Float32Array(4);

  private textureAccessHelper = new OneDimensionalTextureAccessHelper('vertexData');
  private indexBufferHelper = new IndexBufferAttributeHelper('vertexIndex');

  constructor(
      public attributeNames: (string|undefined)[], public attributeInfo: VertexAttributeInfo[],
      public fragmentMain: string) {}

  defineAttributeAccess(builder: ShaderBuilder, vertexIndexVariable: string) {
    let {textureAccessHelper} = this;
    textureAccessHelper.defineShader(builder);
    let numAttributes = 2;
    const {attributeNames} = this;
    for (const attributeName of attributeNames) {
      if (attributeName !== undefined) {
        ++numAttributes;
      }
    }
    for (let j = vertexAttributeSamplerSymbols.length; j < numAttributes; ++j) {
      vertexAttributeSamplerSymbols[j] =
          Symbol(`SingleMeshShaderManager.vertexAttributeTextureUnit${j}`);
    }
    numAttributes = 0;

    builder.addTextureSampler(
        `sampler2D`, 'uVertexAttributeSampler0', vertexAttributeSamplerSymbols[numAttributes++]);
    builder.addTextureSampler(
        `sampler2D`, 'uVertexAttributeSampler1', vertexAttributeSamplerSymbols[numAttributes++]);

    builder.addVertexCode(textureAccessHelper.getAccessor(
        'readVertexPosition', 'uVertexAttributeSampler0', DataType.FLOAT32, 3));
    builder.addVertexCode(textureAccessHelper.getAccessor(
        'readVertexNormal', 'uVertexAttributeSampler1', DataType.FLOAT32, 3));
    let vertexMain = `
vec3 vertexPosition = readVertexPosition(${vertexIndexVariable});
vec3 vertexNormal = readVertexNormal(${vertexIndexVariable});
`;
    this.attributeInfo.forEach((info, i) => {
      const attributeName = attributeNames[i];
      if (attributeName !== undefined) {
        builder.addTextureSampler(
            `${getSamplerPrefixForDataType(info.dataType)}sampler2D` as ShaderSamplerType,
            `uVertexAttributeSampler${numAttributes}`,
            vertexAttributeSamplerSymbols[numAttributes]);

        const attributeType = getShaderAttributeType(info);
        builder.addVarying(`highp ${attributeType}`, `vCustom${i}`);
        builder.addFragmentCode(`
#define ${attributeNames[i]} vCustom${i}
`);
        builder.addVertexCode(textureAccessHelper.getAccessor(
            `readAttribute${i}`, `uVertexAttributeSampler${numAttributes}`, info.dataType,
            info.numComponents));
        vertexMain += `vCustom${i} = readAttribute${i}(${vertexIndexVariable});\n`;
        ++numAttributes;
      }
    });
    builder.addVertexMain(vertexMain);
  }

  defineShader(builder: ShaderBuilder) {
    builder.require(countingBufferShaderModule);
    this.indexBufferHelper.defineShader(builder);
    builder.addVarying('highp float', 'vLightingFactor');
    builder.addUniform('highp vec4', 'uLightDirection');
    builder.addUniform('highp vec4', 'uColor');
    builder.addUniform('highp mat4', 'uModelMatrix');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp uint', 'uPickID');
    builder.addVarying('highp uint', 'vPickID', 'flat');
    builder.addVertexMain(`
uint triangleIndex = getPrimitiveIndex() / 3u;
vPickID = uPickID + triangleIndex;
`);
    builder.addFragmentCode(`
void emitPremultipliedRGBA(vec4 color) {
  emit(vec4(color.rgb * vLightingFactor, color.a), vPickID);
}
void emitRGBA(vec4 color) {
  color = clamp(color, 0.0, 1.0);
  color.xyz *= color.a;
  emitPremultipliedRGBA(color);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitGray() {
  emitRGB(vec3(1.0, 1.0, 1.0));
}
`);
    builder.addFragmentCode(glsl_COLORMAPS);

    // Make sure defineAttributeAccess is the last thing that adds fragment code prior to
    // this.fragmentMain, so that the #define attributes don't mess anything up.
    this.defineAttributeAccess(builder, 'vertexIndex');

    builder.addVertexMain(`
gl_Position = uProjection * (uModelMatrix * vec4(vertexPosition, 1.0));
vec3 normal = normalize((uModelMatrix * vec4(vertexNormal, 0.0)).xyz);
vLightingFactor = abs(dot(normal, uLightDirection.xyz)) + uLightDirection.w;
`);
    builder.setFragmentMainFunction(FRAGMENT_MAIN_START + '\n' + this.fragmentMain);
  }

  beginLayer(gl: GL, shader: ShaderProgram, renderContext: PerspectiveViewRenderContext) {
    let {dataToDevice, lightDirection, ambientLighting, directionalLighting} = renderContext;
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, dataToDevice);
    let lightVec = <vec3>this.tempLightVec;
    vec3.scale(lightVec, lightDirection, directionalLighting);
    lightVec[3] = ambientLighting;
    gl.uniform4fv(shader.uniform('uLightDirection'), lightVec);
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform1ui(shader.uniform('uPickID'), pickID);
  }

  beginObject(gl: GL, shader: ShaderProgram, objectToDataMatrix: mat4) {
    gl.uniformMatrix4fv(shader.uniform('uModelMatrix'), false, objectToDataMatrix);
  }

  getShader(gl: GL, emitter: ShaderModule) {
    const key = {
      attributeNames: this.attributeNames,
      attributeInfo: this.attributeInfo,
      fragmentMain: this.fragmentMain
    };
    return gl.memoize.get(
        `single_mesh/SingleMeshShaderManager:${getObjectId(emitter)}:${stableStringify(key)}`,
        () => {
          let builder = new ShaderBuilder(gl);
          builder.require(emitter);
          this.defineShader(builder);
          return builder.build();
        });
  }

  bindVertexData(gl: GL, shader: ShaderProgram, data: VertexChunkData) {
    this.textureAccessHelper.setupTextureLayout(gl, shader, data);
    let index = 0;
    const bindTexture = (texture: WebGLTexture|null) => {
      const textureUnit = WebGL2RenderingContext.TEXTURE0 +
          shader.textureUnit(vertexAttributeSamplerSymbols[index]);
      gl.activeTexture(textureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      ++index;
    };
    bindTexture(data.vertexTexture);
    bindTexture(data.normalTexture);
    const {attributeNames} = this;
    data.vertexAttributeTextures.forEach((texture, i) => {
      if (attributeNames[i] !== undefined) {
        bindTexture(texture);
      }
    });
  }

  disableVertexData(gl: GL, shader: ShaderProgram) {
    let numTextures = 2;
    let numVertexAttributes = this.attributeInfo.length;
    let {attributeNames} = this;
    for (let i = 0; i < numVertexAttributes; ++i) {
      if (attributeNames[i] !== undefined) {
        ++numTextures;
      }
    }
    for (let i = 0; i < numTextures; ++i) {
      let curTextureUnit =
          shader.textureUnit(vertexAttributeSamplerSymbols[i]) + WebGL2RenderingContext.TEXTURE0;
      gl.activeTexture(curTextureUnit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  drawFragment(
      gl: GL, shader: ShaderProgram, chunk: SingleMeshChunk, countingBuffer: CountingBuffer) {
    countingBuffer.ensure(chunk.numIndices).bind(shader);
    this.bindVertexData(gl, shader, chunk.vertexData);
    this.indexBufferHelper.bind(chunk.indexBuffer, shader);
    gl.drawArrays(WebGL2RenderingContext.TRIANGLES, 0, chunk.numIndices);
  }

  endLayer(gl: GL, shader: ShaderProgram) {
    disableCountingBuffer(gl, shader);
    this.indexBufferHelper.disable(shader);
    this.disableVertexData(gl, shader);
  }
}

export class VertexChunkData {
  vertexPositions: Float32Array;
  vertexNormals: Float32Array;
  vertexTexture: WebGLTexture|null;
  normalTexture: WebGLTexture|null;
  vertexAttributes: Float32Array[];
  vertexAttributeTextures: (WebGLTexture|null)[];

  // Emulation of buffer as texture.
  textureXBits: number;
  textureWidth: number;
  textureHeight: number;

  copyToGPU(gl: GL, attributeFormats: TextureFormat[]) {
    let numVertices = this.vertexPositions.length / 3;
    compute1dTextureLayout(this, gl, /*texelsPerElement=*/ 1, numVertices);
    const getBufferTexture = (data: Float32Array, format: TextureFormat) => {
      let texture = gl.createTexture();
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      setOneDimensionalTextureData(gl, this, format, data);
      return texture;
    };
    this.vertexTexture = getBufferTexture(this.vertexPositions, vertexPositionTextureFormat);
    this.normalTexture = getBufferTexture(this.vertexNormals, vertexNormalTextureFormat);
    this.vertexAttributeTextures =
        this.vertexAttributes.map((data, i) => getBufferTexture(data, attributeFormats[i]));
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
  }

  freeGPUMemory(gl: GL) {
    gl.deleteTexture(this.vertexTexture);
    gl.deleteTexture(this.normalTexture);
    let {vertexAttributeTextures} = this;
    for (const buffer of vertexAttributeTextures) {
      gl.deleteTexture(buffer);
    }
    vertexAttributeTextures.length = 0;
  }
}

export class SingleMeshChunk extends Chunk {
  source: SingleMeshSource;
  indexBuffer: Buffer;
  numIndices: number;
  indices: Uint32Array;
  vertexData: VertexChunkData;

  constructor(source: SingleMeshSource, x: any) {
    super(source);

    const vertexData = this.vertexData = new VertexChunkData();
    vertexData.vertexPositions = x['vertexPositions'];
    vertexData.vertexNormals = x['vertexNormals'];
    vertexData.vertexAttributes = x['vertexAttributes'];
    let indices = this.indices = x['indices'];
    this.numIndices = indices.length;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    this.vertexData.copyToGPU(gl, this.source.attributeTextureFormats);
    this.indexBuffer = makeIndexBuffer(gl, this.indices);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.vertexData.freeGPUMemory(gl);
    this.indexBuffer.dispose();
  }
}

export function getAttributeTextureFormats(vertexAttributes: VertexAttributeInfo[]) {
  return vertexAttributes.map(
      x => computeTextureFormat(new TextureFormat(), x.dataType, x.numComponents));
}

export class SingleMeshSource extends
(WithParameters(ChunkSource, SingleMeshSourceParametersWithInfo)) {
  attributeTextureFormats = getAttributeTextureFormats(this.info.vertexAttributes);

  get info() {
    return this.parameters.info;
  }

  getChunk(x: any) {
    return new SingleMeshChunk(this, x);
  }
}

const SharedObjectWithSharedVisibility = withSharedVisibility(SharedObject);
class SingleMeshLayerSharedObject extends SharedObjectWithSharedVisibility {}

export class SingleMeshLayer extends PerspectiveViewRenderLayer {
  protected shaderManager: SingleMeshShaderManager|undefined;
  private shaders = new Map<ShaderModule, ShaderProgram|null>();
  private sharedObject = this.registerDisposer(new SingleMeshLayerSharedObject());
  private fallbackFragmentMain = DEFAULT_FRAGMENT_MAIN;
  protected countingBuffer = this.registerDisposer(getCountingBuffer(this.gl));

  constructor(public source: SingleMeshSource, public displayState: SingleMeshDisplayState) {
    super();

    this.displayState.shaderError.value = undefined;
    const shaderChanged = () => {
      this.shaderManager = undefined;
      this.displayState.shaderError.value = undefined;
      this.disposeShaders();
      this.redrawNeeded.dispatch();
    };
    this.registerDisposer(displayState.fragmentMain.changed.add(shaderChanged));
    this.registerDisposer(displayState.attributeNames.changed.add(shaderChanged));
    this.registerDisposer(displayState.objectToDataTransform.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.displayState.shaderError.value = undefined;
    const {sharedObject} = this;
    sharedObject.visibility.add(this.visibility);
    sharedObject.RPC_TYPE_ID = SINGLE_MESH_LAYER_RPC_ID;
    sharedObject.initializeCounterpart(source.chunkManager.rpc!, {
      'chunkManager': source.chunkManager.rpcId,
      'source': source.addCounterpartRef(),
    });
    this.setReady(true);
  }

  private disposeShaders() {
    let {shaders} = this;
    for (let shader of shaders.values()) {
      if (shader !== null) {
        shader.dispose();
      }
    }
    shaders.clear();
  }

  disposed() {
    this.disposeShaders();
    super.disposed();
  }

  protected makeShaderManager(fragmentMain = this.displayState.fragmentMain.value) {
    return new SingleMeshShaderManager(
        this.displayState.attributeNames.value, this.source.info.vertexAttributes, fragmentMain);
  }

  protected getShader(emitter: ShaderModule): ShaderProgram|null {
    let {shaders} = this;
    let shader = shaders.get(emitter);
    if (shader === undefined) {
      shader = null;
      let {shaderManager} = this;
      if (shaderManager === undefined) {
        shaderManager = this.shaderManager = this.makeShaderManager();
      }
      const fragmentMain = this.displayState.fragmentMain.value;
      try {
        shader = shaderManager.getShader(this.gl, emitter);
        this.fallbackFragmentMain = fragmentMain;
        this.displayState.shaderError.value = null;
      } catch (shaderError) {
        this.displayState.shaderError.value = shaderError;
        let {fallbackFragmentMain} = this;
        if (fallbackFragmentMain !== fragmentMain) {
          shaderManager = this.shaderManager = this.makeShaderManager(fallbackFragmentMain);
          try {
            shader = shaderManager.getShader(this.gl, emitter);
          } catch (otherShaderError) {
          }
        }
      }
      shaders.set(emitter, shader);
    }
    return shader;
  }

  get isTransparent() {
    return this.displayState.fragmentMain.value.match(/emitRGBA|emitPremultipliedRGBA/) !== null;
  }

  get gl() {
    return this.source.gl;
  }

  draw(renderContext: PerspectiveViewRenderContext) {
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      // No need for a separate pick ID pass.
      return;
    }
    let chunk = <SingleMeshChunk|undefined>this.source.chunks.get(SINGLE_MESH_CHUNK_KEY);
    if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
      return;
    }
    let shader = this.getShader(renderContext.emitter);
    if (shader === null) {
      return;
    }

    let {gl} = this;
    let shaderManager = this.shaderManager!;
    shader.bind();
    shaderManager.beginLayer(gl, shader, renderContext);


    let {pickIDs} = renderContext;

    shaderManager.beginObject(gl, shader, this.displayState.objectToDataTransform.transform);
    if (renderContext.emitPickID) {
      shaderManager.setPickID(gl, shader, pickIDs.register(this, chunk.numIndices / 3));
    }
    shaderManager.drawFragment(gl, shader, chunk, this.countingBuffer);
    shaderManager.endLayer(gl, shader);
  }

  drawPicking(renderContext: PerspectiveViewRenderContext) {
    this.draw(renderContext);
  }

  transformPickedValue(_pickedValue: Uint64, pickedOffset: number) {
    let chunk = <SingleMeshChunk|undefined>this.source.chunks.get(SINGLE_MESH_CHUNK_KEY);
    if (chunk === undefined) {
      return undefined;
    }
    let startIndex = pickedOffset * 3;
    let {indices} = chunk;

    if (startIndex >= indices.length) {
      return undefined;
    }

    // FIXME: compute closest vertex position.  For now just use first vertex.
    let vertexIndex = indices[startIndex];

    let values: string[] = [];
    let attributeNames = this.displayState.attributeNames.value;
    chunk.vertexData.vertexAttributes.forEach((attributes, i) => {
      const attributeName = attributeNames[i];
      if (attributeName !== undefined) {
        values.push(`${attributeName}=${attributes[vertexIndex].toPrecision(6)}`);
      }
    });

    return values.join(', ');
  }
}

function getSingleMeshInfo(chunkManager: ChunkManager, parameters: SingleMeshSourceParameters) {
  return chunkManager.memoize.getUncounted(
      {type: 'single_mesh:getMeshInfo', parameters},
      () => chunkManager.rpc!.promiseInvoke<SingleMeshInfo>(
          GET_SINGLE_MESH_INFO_RPC_ID,
          {'chunkManager': chunkManager.addCounterpartRef(), 'parameters': parameters}));
}

export function getSingleMeshSource(
    chunkManager: ChunkManager, parameters: SingleMeshSourceParameters) {
  return getSingleMeshInfo(chunkManager, parameters)
      .then(
          info =>
              chunkManager.getChunkSource(SingleMeshSource, {parameters: {...parameters, info}}));
}
