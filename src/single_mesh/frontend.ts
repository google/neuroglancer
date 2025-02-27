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

import { ChunkState } from "#src/chunk_manager/base.js";
import {
  Chunk,
  ChunkSource,
  WithParameters,
} from "#src/chunk_manager/frontend.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
} from "#src/coordinate_transform.js";
import type {
  DataSource,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { ensureEmptyUrlSuffix } from "#src/kvstore/url.js";
import type { PickState, VisibleLayerInfo } from "#src/layer/index.js";
import type { PerspectivePanel } from "#src/perspective_view/panel.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type { WatchableRenderLayerTransform } from "#src/render_coordinate_transform.js";
import type { ThreeDimensionalRenderLayerAttachmentState } from "#src/renderlayer.js";
import { update3dRenderLayerAttachment } from "#src/renderlayer.js";
import type {
  SingleMeshInfo,
  VertexAttributeInfo,
} from "#src/single_mesh/base.js";
import {
  GET_SINGLE_MESH_INFO_RPC_ID,
  SINGLE_MESH_CHUNK_KEY,
  SINGLE_MESH_LAYER_RPC_ID,
  SingleMeshSourceParametersWithInfo,
} from "#src/single_mesh/base.js";
import { WatchableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import type { mat4 } from "#src/util/geom.js";
import { vec3 } from "#src/util/geom.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { withSharedVisibility } from "#src/visibility_priority/frontend.js";
import type { GLBuffer } from "#src/webgl/buffer.js";
import { glsl_COLORMAPS } from "#src/webgl/colormaps.js";
import type { GL } from "#src/webgl/context.js";
import {
  makeTrackableFragmentMain,
  makeWatchableShaderError,
  parameterizedEmitterDependentShaderGetter,
  shaderCodeWithLineDirective,
} from "#src/webgl/dynamic_shader.js";
import type { CountingBuffer } from "#src/webgl/index_emulation.js";
import {
  countingBufferShaderModule,
  disableCountingBuffer,
  getCountingBuffer,
  IndexBufferAttributeHelper,
  makeIndexBuffer,
} from "#src/webgl/index_emulation.js";
import type {
  ShaderBuilder,
  ShaderModule,
  ShaderProgram,
  ShaderSamplerType,
} from "#src/webgl/shader.js";
import { getShaderType } from "#src/webgl/shader_lib.js";
import type { ShaderControlsBuilderState } from "#src/webgl/shader_ui_controls.js";
import {
  addControlsToBuilder,
  getFallbackBuilderState,
  parseShaderUiControls,
  setControlsInShader,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";
import {
  computeTextureFormat,
  getSamplerPrefixForDataType,
  OneDimensionalTextureAccessHelper,
  setOneDimensionalTextureData,
  TextureFormat,
} from "#src/webgl/texture_access.js";
import { SharedObject } from "#src/worker_rpc.js";

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitGray();
}
`;

export class SingleMeshDisplayState {
  shaderError = makeWatchableShaderError();
  fragmentMain = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  shaderControlState = new ShaderControlState(this.fragmentMain);
}

export function getShaderAttributeType(info: {
  dataType: DataType;
  numComponents: number;
}) {
  return getShaderType(info.dataType, info.numComponents);
}

const vertexAttributeSamplerSymbols: symbol[] = [];

const vertexPositionTextureFormat = computeTextureFormat(
  new TextureFormat(),
  DataType.FLOAT32,
  3,
);
const vertexNormalTextureFormat = vertexPositionTextureFormat;

function makeValidIdentifier(x: string) {
  return x
    .split(/[^a-zA-Z0-9]+/)
    .filter((y) => y)
    .join("_");
}

export function pickAttributeNames(existingNames: string[]) {
  const seenNames = new Set<string>();
  const result: string[] = [];
  for (const existingName of existingNames) {
    const name = makeValidIdentifier(existingName);
    let suffix = "";
    let suffixNumber = 0;
    while (seenNames.has(name + suffix)) {
      suffix = "" + ++suffixNumber;
    }
    result.push(name + suffix);
  }
  return result;
}

export class SingleMeshShaderManager {
  private tempLightVec = new Float32Array(4);

  private textureAccessHelper = new OneDimensionalTextureAccessHelper(
    "vertexData",
  );
  private indexBufferHelper = new IndexBufferAttributeHelper("vertexIndex");

  constructor(
    public attributeNames: string[],
    public attributeInfo: VertexAttributeInfo[],
  ) {}

  defineAttributeAccess(builder: ShaderBuilder, vertexIndexVariable: string) {
    const { textureAccessHelper } = this;
    textureAccessHelper.defineShader(builder);
    const { attributeNames } = this;
    let numAttributes = 2 + attributeNames.length;
    for (let j = vertexAttributeSamplerSymbols.length; j < numAttributes; ++j) {
      vertexAttributeSamplerSymbols[j] = Symbol(
        `SingleMeshShaderManager.vertexAttributeTextureUnit${j}`,
      );
    }
    numAttributes = 0;

    builder.addTextureSampler(
      "sampler2D",
      "uVertexAttributeSampler0",
      vertexAttributeSamplerSymbols[numAttributes++],
    );
    builder.addTextureSampler(
      "sampler2D",
      "uVertexAttributeSampler1",
      vertexAttributeSamplerSymbols[numAttributes++],
    );

    builder.addVertexCode(
      textureAccessHelper.getAccessor(
        "readVertexPosition",
        "uVertexAttributeSampler0",
        DataType.FLOAT32,
        3,
      ),
    );
    builder.addVertexCode(
      textureAccessHelper.getAccessor(
        "readVertexNormal",
        "uVertexAttributeSampler1",
        DataType.FLOAT32,
        3,
      ),
    );
    let vertexMain = `
vec3 vertexPosition = readVertexPosition(${vertexIndexVariable});
vec3 vertexNormal = readVertexNormal(${vertexIndexVariable});
`;
    this.attributeInfo.forEach((info, i) => {
      builder.addTextureSampler(
        `${getSamplerPrefixForDataType(
          info.dataType,
        )}sampler2D` as ShaderSamplerType,
        `uVertexAttributeSampler${numAttributes}`,
        vertexAttributeSamplerSymbols[numAttributes],
      );

      const attributeType = getShaderAttributeType(info);
      builder.addVarying(`highp ${attributeType}`, `vCustom${i}`);
      builder.addFragmentCode(`
#define ${attributeNames[i]} vCustom${i}
`);
      builder.addVertexCode(
        textureAccessHelper.getAccessor(
          `readAttribute${i}`,
          `uVertexAttributeSampler${numAttributes}`,
          info.dataType,
          info.numComponents,
        ),
      );
      vertexMain += `vCustom${i} = readAttribute${i}(${vertexIndexVariable});\n`;
      ++numAttributes;
    });
    builder.addVertexMain(vertexMain);
  }

  defineShader(builder: ShaderBuilder) {
    builder.require(countingBufferShaderModule);
    this.indexBufferHelper.defineShader(builder);
    builder.addVarying("highp float", "vLightingFactor");
    builder.addUniform("highp vec4", "uLightDirection");
    builder.addUniform("highp vec4", "uColor");
    builder.addUniform("highp mat4", "uModelMatrix");
    builder.addUniform("highp mat4", "uProjection");
    builder.addUniform("highp uint", "uPickID");
    builder.addVarying("highp uint", "vPickID", "flat");
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
    this.defineAttributeAccess(builder, "vertexIndex");

    builder.addVertexMain(`
gl_Position = uProjection * (uModelMatrix * vec4(vertexPosition, 1.0));
vec3 normal = normalize((uModelMatrix * vec4(vertexNormal, 0.0)).xyz);
vLightingFactor = abs(dot(normal, uLightDirection.xyz)) + uLightDirection.w;
`);
  }

  beginLayer(
    gl: GL,
    shader: ShaderProgram,
    renderContext: PerspectiveViewRenderContext,
  ) {
    const {
      lightDirection,
      ambientLighting,
      directionalLighting,
      projectionParameters,
    } = renderContext;
    const { viewProjectionMat } = projectionParameters;
    gl.uniformMatrix4fv(
      shader.uniform("uProjection"),
      false,
      viewProjectionMat,
    );
    const lightVec = <vec3>this.tempLightVec;
    vec3.scale(lightVec, lightDirection, directionalLighting);
    lightVec[3] = ambientLighting;
    gl.uniform4fv(shader.uniform("uLightDirection"), lightVec);
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform1ui(shader.uniform("uPickID"), pickID);
  }

  beginObject(gl: GL, shader: ShaderProgram, objectToDataMatrix: mat4) {
    gl.uniformMatrix4fv(
      shader.uniform("uModelMatrix"),
      false,
      objectToDataMatrix,
    );
  }

  bindVertexData(gl: GL, shader: ShaderProgram, data: VertexChunkData) {
    let index = 0;
    const bindTexture = (texture: WebGLTexture | null) => {
      const textureUnit =
        WebGL2RenderingContext.TEXTURE0 +
        shader.textureUnit(vertexAttributeSamplerSymbols[index]);
      gl.activeTexture(textureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      ++index;
    };
    bindTexture(data.vertexTexture);
    bindTexture(data.normalTexture);
    const { attributeNames } = this;
    data.vertexAttributeTextures.forEach((texture, i) => {
      if (attributeNames[i] !== undefined) {
        bindTexture(texture);
      }
    });
  }

  disableVertexData(gl: GL, shader: ShaderProgram) {
    let numTextures = 2;
    const numVertexAttributes = this.attributeInfo.length;
    const { attributeNames } = this;
    for (let i = 0; i < numVertexAttributes; ++i) {
      if (attributeNames[i] !== undefined) {
        ++numTextures;
      }
    }
    for (let i = 0; i < numTextures; ++i) {
      const curTextureUnit =
        shader.textureUnit(vertexAttributeSamplerSymbols[i]) +
        WebGL2RenderingContext.TEXTURE0;
      gl.activeTexture(curTextureUnit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  drawFragment(
    gl: GL,
    shader: ShaderProgram,
    chunk: SingleMeshChunk,
    countingBuffer: CountingBuffer,
  ) {
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
  vertexTexture: WebGLTexture | null;
  normalTexture: WebGLTexture | null;
  vertexAttributes: Float32Array[];
  vertexAttributeTextures: (WebGLTexture | null)[];

  copyToGPU(gl: GL, attributeFormats: TextureFormat[]) {
    const getBufferTexture = (data: Float32Array, format: TextureFormat) => {
      const texture = gl.createTexture();
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      setOneDimensionalTextureData(gl, format, data);
      return texture;
    };
    this.vertexTexture = getBufferTexture(
      this.vertexPositions,
      vertexPositionTextureFormat,
    );
    this.normalTexture = getBufferTexture(
      this.vertexNormals,
      vertexNormalTextureFormat,
    );
    this.vertexAttributeTextures = this.vertexAttributes.map((data, i) =>
      getBufferTexture(data, attributeFormats[i]),
    );
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
  }

  freeGPUMemory(gl: GL) {
    gl.deleteTexture(this.vertexTexture);
    gl.deleteTexture(this.normalTexture);
    const { vertexAttributeTextures } = this;
    for (const buffer of vertexAttributeTextures) {
      gl.deleteTexture(buffer);
    }
    vertexAttributeTextures.length = 0;
  }
}

export class SingleMeshChunk extends Chunk {
  declare source: SingleMeshSource;
  indexBuffer: GLBuffer;
  numIndices: number;
  indices: Uint32Array;
  vertexData: VertexChunkData;

  constructor(source: SingleMeshSource, x: any) {
    super(source);

    const vertexData = (this.vertexData = new VertexChunkData());
    vertexData.vertexPositions = x.vertexPositions;
    vertexData.vertexNormals = x.vertexNormals;
    vertexData.vertexAttributes = x.vertexAttributes;
    const indices = (this.indices = x.indices);
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

export function getAttributeTextureFormats(
  vertexAttributes: VertexAttributeInfo[],
) {
  return vertexAttributes.map((x) =>
    computeTextureFormat(new TextureFormat(), x.dataType, x.numComponents),
  );
}

export class SingleMeshSource extends WithParameters(
  WithSharedKvStoreContext(ChunkSource),
  SingleMeshSourceParametersWithInfo,
) {
  attributeTextureFormats = getAttributeTextureFormats(
    this.info.vertexAttributes,
  );

  get info() {
    return this.parameters.info;
  }

  getChunk(x: any) {
    return new SingleMeshChunk(this, x);
  }
}

const SharedObjectWithSharedVisibility = withSharedVisibility(SharedObject);
class SingleMeshLayerSharedObject extends SharedObjectWithSharedVisibility {}

export class SingleMeshLayer extends PerspectiveViewRenderLayer<ThreeDimensionalRenderLayerAttachmentState> {
  private shaderManager: SingleMeshShaderManager;
  private shaders = new Map<ShaderModule, ShaderProgram | null>();
  private sharedObject = this.registerDisposer(
    new SingleMeshLayerSharedObject(),
  );
  private shaderGetter;
  protected countingBuffer;
  constructor(
    public source: SingleMeshSource,
    public displayState: SingleMeshDisplayState,
    public transform: WatchableRenderLayerTransform,
  ) {
    super();
    this.shaderManager = new SingleMeshShaderManager(
      pickAttributeNames(source.info.vertexAttributes.map((a) => a.name)),
      source.info.vertexAttributes,
    );
    this.shaderGetter = parameterizedEmitterDependentShaderGetter(
      this,
      this.gl,
      {
        memoizeKey: {
          t: "single_mesh/RenderLayer",
          attributes: this.source.info.vertexAttributes,
        },
        fallbackParameters: new WatchableValue(
          getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)),
        ),
        parameters: this.displayState.shaderControlState.builderState,
        encodeParameters: (p) => p.key,
        shaderError: this.displayState.shaderError,
        defineShader: (
          builder: ShaderBuilder,
          shaderBuilderState: ShaderControlsBuilderState,
        ) => {
          if (shaderBuilderState.parseResult.errors.length !== 0) {
            throw new Error("Invalid UI control specification");
          }
          addControlsToBuilder(shaderBuilderState, builder);
          this.shaderManager.defineShader(builder);
          builder.setFragmentMainFunction(
            shaderCodeWithLineDirective(shaderBuilderState.parseResult.code),
          );
        },
      },
    );

    this.countingBuffer = this.registerDisposer(getCountingBuffer(this.gl));

    this.registerDisposer(
      displayState.shaderControlState.parseResult.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
    this.registerDisposer(
      displayState.shaderControlState.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(transform.changed.add(this.redrawNeeded.dispatch));
    const { sharedObject } = this;
    sharedObject.visibility.add(this.visibility);
    sharedObject.RPC_TYPE_ID = SINGLE_MESH_LAYER_RPC_ID;
    sharedObject.initializeCounterpart(source.chunkManager.rpc!, {
      chunkManager: source.chunkManager.rpcId,
      source: source.addCounterpartRef(),
    });
  }

  private disposeShaders() {
    const { shaders } = this;
    for (const shader of shaders.values()) {
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
    return (
      this.displayState.fragmentMain.value.match(
        /emitRGBA|emitPremultipliedRGBA/,
      ) !== null
    );
  }

  get gl() {
    return this.source.gl;
  }

  isReady() {
    const chunk = <SingleMeshChunk | undefined>(
      this.source.chunks.get(SINGLE_MESH_CHUNK_KEY)
    );
    if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
      return false;
    }
    return true;
  }

  draw(
    renderContext: PerspectiveViewRenderContext,
    attachment: VisibleLayerInfo<
      PerspectivePanel,
      ThreeDimensionalRenderLayerAttachmentState
    >,
  ) {
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      // No need for a separate pick ID pass.
      return;
    }
    const modelMatrix = update3dRenderLayerAttachment(
      this.transform.value,
      renderContext.projectionParameters.displayDimensionRenderInfo,
      attachment,
    );
    if (modelMatrix === undefined) return;
    const chunk = <SingleMeshChunk | undefined>(
      this.source.chunks.get(SINGLE_MESH_CHUNK_KEY)
    );
    if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
      return;
    }
    const shaderResult = this.shaderGetter(renderContext.emitter);
    const { shader, parameters } = shaderResult;
    if (shader === null) {
      return;
    }
    const { gl } = this;
    const shaderManager = this.shaderManager!;
    shader.bind();
    shaderManager.beginLayer(gl, shader, renderContext);
    setControlsInShader(
      gl,
      shader,
      this.displayState.shaderControlState,
      parameters.parseResult.controls,
    );

    const { pickIDs } = renderContext;

    shaderManager.beginObject(gl, shader, modelMatrix);
    if (renderContext.emitPickID) {
      shaderManager.setPickID(
        gl,
        shader,
        pickIDs.register(this, chunk.numIndices / 3),
      );
    }
    shaderManager.drawFragment(gl, shader, chunk, this.countingBuffer);
    shaderManager.endLayer(gl, shader);
  }

  transformPickedValue(pickState: PickState) {
    const { pickedOffset } = pickState;
    const chunk = <SingleMeshChunk | undefined>(
      this.source.chunks.get(SINGLE_MESH_CHUNK_KEY)
    );
    if (chunk === undefined) {
      return undefined;
    }
    const startIndex = pickedOffset * 3;
    const { indices } = chunk;

    if (startIndex >= indices.length) {
      return undefined;
    }

    // FIXME: compute closest vertex position.  For now just use first vertex.
    const vertexIndex = indices[startIndex];

    const values: string[] = [];
    const { attributeNames } = this.shaderManager;
    chunk.vertexData.vertexAttributes.forEach((attributes, i) => {
      const attributeName = attributeNames[i];
      if (attributeName !== undefined) {
        values.push(
          `${attributeName}=${attributes[vertexIndex].toPrecision(6)}`,
        );
      }
    });

    return values.join(", ");
  }
}

function getSingleMeshInfo(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
) {
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    { type: "single_mesh:getMeshInfo", url },
    options,
    async (progressOptions) => {
      const info =
        await sharedKvStoreContext.chunkManager.rpc!.promiseInvoke<SingleMeshInfo>(
          GET_SINGLE_MESH_INFO_RPC_ID,
          {
            sharedKvStoreContext: sharedKvStoreContext.rpcId,
            parameters: { meshSourceUrl: url },
          },
          {
            signal: progressOptions.signal,
            progressListener: options.progressListener,
          },
        );
      return info;
    },
  );
}

export async function getSingleMeshSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
) {
  const info = await getSingleMeshInfo(sharedKvStoreContext, url, options);
  return sharedKvStoreContext.chunkManager.getChunkSource(SingleMeshSource, {
    sharedKvStoreContext,
    parameters: { meshSourceUrl: url, info },
  });
}

export class SingleMeshDataSource implements KvStoreBasedDataSourceProvider {
  constructor(
    public scheme: string,
    public description: string,
  ) {}

  get singleFile() {
    return true;
  }

  async get(options: GetKvStoreBasedDataSourceOptions): Promise<DataSource> {
    ensureEmptyUrlSuffix(options.url);
    const meshSource = await getSingleMeshSource(
      options.registry.sharedKvStoreContext,
      `${options.url.scheme}://${options.kvStoreUrl}`,
      options,
    );
    const modelSpace = makeCoordinateSpace({
      rank: 3,
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.of(1e-9, 1e-9, 1e-9),
    });
    const dataSource: DataSource = {
      canonicalUrl: `${options.kvStoreUrl}|${options.url.scheme}:`,
      modelTransform: makeIdentityTransform(modelSpace),
      subsources: [
        {
          id: "default",
          default: true,
          subsource: { singleMesh: meshSource },
        },
      ],
    };
    return dataSource;
  }
}
