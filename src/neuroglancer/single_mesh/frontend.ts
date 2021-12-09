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
import {CredentialsManager} from 'neuroglancer/credentials_provider';
import {getCredentialsProviderCounterpart, WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {PickState, VisibleLayerInfo} from 'neuroglancer/layer';
import {PerspectivePanel} from 'neuroglancer/perspective_view/panel';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {WatchableRenderLayerTransform} from 'neuroglancer/render_coordinate_transform';
import {ThreeDimensionalRenderLayerAttachmentState, update3dRenderLayerAttachment} from 'neuroglancer/renderlayer';
import {GET_SINGLE_MESH_INFO_RPC_ID, SINGLE_MESH_CHUNK_KEY, SINGLE_MESH_LAYER_RPC_ID, SingleMeshInfo, SingleMeshSourceParametersWithInfo, VertexAttributeInfo} from 'neuroglancer/single_mesh/base';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {DataType} from 'neuroglancer/util/data_type';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseSpecialUrl, SpecialProtocolCredentials} from 'neuroglancer/util/special_protocol_request';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {glsl_COLORMAPS} from 'neuroglancer/webgl/colormaps';
import {GL} from 'neuroglancer/webgl/context';
import {makeTrackableFragmentMain, makeWatchableShaderError, parameterizedEmitterDependentShaderGetter, shaderCodeWithLineDirective} from 'neuroglancer/webgl/dynamic_shader';
import {CountingBuffer, countingBufferShaderModule, disableCountingBuffer, getCountingBuffer, IndexBufferAttributeHelper, makeIndexBuffer} from 'neuroglancer/webgl/index_emulation';
import {ShaderBuilder, ShaderModule, ShaderProgram, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';
import {addControlsToBuilder, getFallbackBuilderState, parseShaderUiControls, setControlsInShader, ShaderControlsBuilderState, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {computeTextureFormat, getSamplerPrefixForDataType, OneDimensionalTextureAccessHelper, setOneDimensionalTextureData, TextureFormat} from 'neuroglancer/webgl/texture_access';
import {SharedObject} from 'neuroglancer/worker_rpc';

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitGray();
}
`;

export class SingleMeshDisplayState {
  shaderError = makeWatchableShaderError();
  fragmentMain = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  shaderControlState = new ShaderControlState(this.fragmentMain);
}

export function getShaderAttributeType(info: {dataType: DataType, numComponents: number}) {
  return getShaderType(info.dataType, info.numComponents);
}

const vertexAttributeSamplerSymbols: Symbol[] = [];

const vertexPositionTextureFormat = computeTextureFormat(new TextureFormat(), DataType.FLOAT32, 3);
const vertexNormalTextureFormat = vertexPositionTextureFormat;

function makeValidIdentifier(x: string) {
  return x.split(/[^a-zA-Z0-9]+/).filter(y => y).join('_');
}

export function pickAttributeNames(existingNames: string[]) {
  const seenNames = new Set<string>();
  let result: string[] = [];
  for (let existingName of existingNames) {
    let name = makeValidIdentifier(existingName);
    let suffix = '';
    let suffixNumber = 0;
    while (seenNames.has(name + suffix)) {
      suffix = '' + (++suffixNumber);
    }
    result.push(name + suffix);
  }
  return result;
}

export class SingleMeshShaderManager {
  private tempLightVec = new Float32Array(4);

  private textureAccessHelper = new OneDimensionalTextureAccessHelper('vertexData');
  private indexBufferHelper = new IndexBufferAttributeHelper('vertexIndex');

  constructor(public attributeNames: string[], public attributeInfo: VertexAttributeInfo[]) {}

  defineAttributeAccess(builder: ShaderBuilder, vertexIndexVariable: string) {
    let {textureAccessHelper} = this;
    textureAccessHelper.defineShader(builder);
    const {attributeNames} = this;
    let numAttributes = 2 + attributeNames.length;
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
      builder.addTextureSampler(
          `${getSamplerPrefixForDataType(info.dataType)}sampler2D` as ShaderSamplerType,
          `uVertexAttributeSampler${numAttributes}`, vertexAttributeSamplerSymbols[numAttributes]);

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
  }

  beginLayer(gl: GL, shader: ShaderProgram, renderContext: PerspectiveViewRenderContext) {
    const {lightDirection, ambientLighting, directionalLighting, projectionParameters} =
        renderContext;
    const {viewProjectionMat} = projectionParameters;
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, viewProjectionMat);
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

  bindVertexData(gl: GL, shader: ShaderProgram, data: VertexChunkData) {
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

  copyToGPU(gl: GL, attributeFormats: TextureFormat[]) {
    const getBufferTexture = (data: Float32Array, format: TextureFormat) => {
      let texture = gl.createTexture();
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      setOneDimensionalTextureData(gl, format, data);
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
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(ChunkSource), SingleMeshSourceParametersWithInfo)) {
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

export class SingleMeshLayer extends
    PerspectiveViewRenderLayer<ThreeDimensionalRenderLayerAttachmentState> {
  private shaderManager = new SingleMeshShaderManager(
      pickAttributeNames(this.source.info.vertexAttributes.map(a => a.name)),
      this.source.info.vertexAttributes);
  private shaders = new Map<ShaderModule, ShaderProgram|null>();
  private sharedObject = this.registerDisposer(new SingleMeshLayerSharedObject());
  private shaderGetter = parameterizedEmitterDependentShaderGetter(this, this.gl, {
    memoizeKey: {t: `single_mesh/RenderLayer`, attributes: this.source.info.vertexAttributes},
    fallbackParameters:
        new WatchableValue(getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN))),
    parameters: this.displayState.shaderControlState.builderState,
    encodeParameters: p => p.key,
    shaderError: this.displayState.shaderError,
    defineShader:
        (builder: ShaderBuilder, shaderBuilderState: ShaderControlsBuilderState) => {
          if (shaderBuilderState.parseResult.errors.length !== 0) {
            throw new Error('Invalid UI control specification');
          }
          addControlsToBuilder(shaderBuilderState, builder);
          this.shaderManager.defineShader(builder);
          builder.setFragmentMainFunction(
              shaderCodeWithLineDirective(shaderBuilderState.parseResult.code));
        },
  });

  protected countingBuffer = this.registerDisposer(getCountingBuffer(this.gl));
  constructor(
      public source: SingleMeshSource, public displayState: SingleMeshDisplayState,
      public transform: WatchableRenderLayerTransform) {
    super();
    this.registerDisposer(
        displayState.shaderControlState.parseResult.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(displayState.shaderControlState.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(transform.changed.add(this.redrawNeeded.dispatch));
    const {sharedObject} = this;
    sharedObject.visibility.add(this.visibility);
    sharedObject.RPC_TYPE_ID = SINGLE_MESH_LAYER_RPC_ID;
    sharedObject.initializeCounterpart(source.chunkManager.rpc!, {
      'chunkManager': source.chunkManager.rpcId,
      'source': source.addCounterpartRef(),
    });
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

  get isTransparent() {
    return this.displayState.fragmentMain.value.match(/emitRGBA|emitPremultipliedRGBA/) !== null;
  }

  get gl() {
    return this.source.gl;
  }

  isReady() {
    let chunk = <SingleMeshChunk|undefined>this.source.chunks.get(SINGLE_MESH_CHUNK_KEY);
    if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
      return false;
    }
    return true;
  }

  draw(
      renderContext: PerspectiveViewRenderContext,
      attachment: VisibleLayerInfo<PerspectivePanel, ThreeDimensionalRenderLayerAttachmentState>) {
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      // No need for a separate pick ID pass.
      return;
    }
    const modelMatrix = update3dRenderLayerAttachment(
        this.transform.value, renderContext.projectionParameters.displayDimensionRenderInfo,
        attachment);
    if (modelMatrix === undefined) return;
    let chunk = <SingleMeshChunk|undefined>this.source.chunks.get(SINGLE_MESH_CHUNK_KEY);
    if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
      return;
    }
    const shaderResult = this.shaderGetter(renderContext.emitter);
    const {shader, parameters} = shaderResult;
    if (shader === null) {
      return;
    }
    const {gl} = this;
    const shaderManager = this.shaderManager!;
    shader.bind();
    shaderManager.beginLayer(gl, shader, renderContext);
    setControlsInShader(
        gl, shader, this.displayState.shaderControlState, parameters.parseResult.controls);

    let {pickIDs} = renderContext;

    shaderManager.beginObject(gl, shader, modelMatrix);
    if (renderContext.emitPickID) {
      shaderManager.setPickID(gl, shader, pickIDs.register(this, chunk.numIndices / 3));
    }
    shaderManager.drawFragment(gl, shader, chunk, this.countingBuffer);
    shaderManager.endLayer(gl, shader);
  }

  transformPickedValue(pickState: PickState) {
    const {pickedOffset} = pickState;
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
    const {attributeNames} = this.shaderManager;
    chunk.vertexData.vertexAttributes.forEach((attributes, i) => {
      const attributeName = attributeNames[i];
      if (attributeName !== undefined) {
        values.push(`${attributeName}=${attributes[vertexIndex].toPrecision(6)}`);
      }
    });

    return values.join(', ');
  }
}

function getSingleMeshInfo(
    chunkManager: ChunkManager, credentialsManager: CredentialsManager, url: string) {
  return chunkManager.memoize.getUncounted({type: 'single_mesh:getMeshInfo', url}, async () => {
    const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(url, credentialsManager);
    const info =
        await chunkManager.rpc!.promiseInvoke<SingleMeshInfo>(GET_SINGLE_MESH_INFO_RPC_ID, {
          'chunkManager': chunkManager.addCounterpartRef(),
          credentialsProvider: getCredentialsProviderCounterpart<SpecialProtocolCredentials>(
              chunkManager, credentialsProvider),
          'parameters': {meshSourceUrl: parsedUrl}
        });
    return {info, url: parsedUrl, credentialsProvider};
  });
}

export async function getSingleMeshSource(
    chunkManager: ChunkManager, credentialsManager: CredentialsManager, url: string) {
  const {info, url: parsedUrl, credentialsProvider} =
      await getSingleMeshInfo(chunkManager, credentialsManager, url);
  return chunkManager.getChunkSource(
      SingleMeshSource, {credentialsProvider, parameters: {meshSourceUrl: parsedUrl, info}});
}
