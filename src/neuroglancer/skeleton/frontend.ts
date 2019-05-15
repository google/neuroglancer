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
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {RenderLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {getObjectColor, registerRedrawWhenSegmentationDisplayState3DChanged, SegmentationDisplayState3D, SegmentationLayerSharedObject} from 'neuroglancer/segmentation_display_state/frontend';
import {SKELETON_LAYER_RPC_ID, VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/panel';
import {TrackableValue, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {DataType} from 'neuroglancer/util/data_type';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {verifyString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {CircleShader} from 'neuroglancer/webgl/circles';
import glsl_COLORMAPS from 'neuroglancer/webgl/colormaps.glsl';
import {GL} from 'neuroglancer/webgl/context';
import {parameterizedEmitterDependentShaderGetter, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {LineShader} from 'neuroglancer/webgl/lines';
import {ShaderBuilder, ShaderProgram, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {compute1dTextureLayout, computeTextureFormat, getSamplerPrefixForDataType, OneDimensionalTextureAccessHelper, setOneDimensionalTextureData, TextureFormat} from 'neuroglancer/webgl/texture_access';

const tempMat2 = mat4.create();

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitDefault();
}
`;

export const FRAGMENT_MAIN_START = '//NEUROGLANCER_SKELETON_LAYER_FRAGMENT_MAIN_START';

export type TrackableFragmentMain = TrackableValue<string>;

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return new TrackableValue<string>(value, verifyString);
}

interface VertexAttributeRenderInfo extends VertexAttributeInfo {
  name: string;
  webglDataType: number;
  glslDataType: string;
}

const vertexAttributeSamplerSymbols: Symbol[] = [];

const vertexPositionTextureFormat = computeTextureFormat(new TextureFormat(), DataType.FLOAT32, 3);

class RenderHelper extends RefCounted {
  private textureAccessHelper = new OneDimensionalTextureAccessHelper('vertexData');
  private lineShader = this.registerDisposer(new LineShader(this.gl, 1));
  private circleShader = this.registerDisposer(new CircleShader(this.gl, 2));

  get vertexAttributes(): VertexAttributeRenderInfo[] {
    return this.base.vertexAttributes;
  }

  defineCommonShader(builder: ShaderBuilder) {
    builder.addUniform('highp vec4', 'uColor');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp uint', 'uPickID');
  }

  edgeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this, this.gl,
      {type: 'skeleton/SkeletonShaderManager/edge', vertexAttributes: this.vertexAttributes},
      this.base.fallbackFragmentMain, this.base.displayState.fragmentMain,
      this.base.displayState.shaderError, (builder: ShaderBuilder, fragmentMain: string) => {
        this.defineAttributeAccess(builder);
        this.lineShader.defineShader(builder);
        builder.addAttribute('highp uvec2', 'aVertexIndex');
        this.defineCommonShader(builder);
        let vertexMain = `
highp vec3 vertexA = readAttribute0(aVertexIndex.x);
highp vec3 vertexB = readAttribute0(aVertexIndex.y);
emitLine(uProjection, vertexA, vertexB);
highp uint lineEndpointIndex = getLineEndpointIndex();
highp uint vertexIndex = aVertexIndex.x * lineEndpointIndex + aVertexIndex.y * (1u - lineEndpointIndex);
`;

        builder.addFragmentCode(`
vec4 segmentColor() {
  return uColor;
}
void emitRGB(vec3 color) {
  emit(vec4(color * uColor.a, uColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()}), uPickID);
}
void emitDefault() {
  //emit(vec4(uColor.rgb, uColor.a * ${this.getCrossSectionFadeFactor()}), uPickID);
  emit(vec4(uColor.rgb, uColor.a * getLineAlpha() * ${this.getCrossSectionFadeFactor()}), uPickID);
}
`);
        builder.addFragmentCode(glsl_COLORMAPS);
        const {vertexAttributes} = this;
        const numAttributes = vertexAttributes.length;
        for (let i = 1; i < numAttributes; ++i) {
          const info = vertexAttributes[i];
          builder.addVarying(`highp ${info.glslDataType}`, `vCustom${i}`);
          vertexMain += `vCustom${i} = readAttribute${i}(vertexIndex);\n`;
          builder.addFragmentCode(`#define ${info.name} vCustom${i}\n`);
        }
        builder.setVertexMain(vertexMain);
        builder.setFragmentMainFunction(FRAGMENT_MAIN_START + '\n' + fragmentMain);
      });

  nodeShaderGetter = parameterizedEmitterDependentShaderGetter(
      this, this.gl,
      {type: 'skeleton/SkeletonShaderManager/node', vertexAttributes: this.vertexAttributes},
      this.base.fallbackFragmentMain, this.base.displayState.fragmentMain,
      this.base.displayState.shaderError, (builder: ShaderBuilder, fragmentMain: string) => {
        this.defineAttributeAccess(builder);
        this.circleShader.defineShader(builder, /*crossSectionFade=*/ this.targetIsSliceView);
        this.defineCommonShader(builder);
        let vertexMain = `
highp uint vertexIndex = uint(gl_InstanceID);
highp vec3 vertexPosition = readAttribute0(vertexIndex);
emitCircle(uProjection * vec4(vertexPosition, 1.0));
`;

        builder.addFragmentCode(`
vec4 segmentColor() {
  return uColor;
}
void emitRGB(vec3 color) {
  vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
  emit(getCircleColor(vec4(color, 1.0), borderColor), uPickID);
}
void emitDefault() {
  vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
  emit(getCircleColor(uColor, borderColor), uPickID);
}
`);
        builder.addFragmentCode(glsl_COLORMAPS);
        const {vertexAttributes} = this;
        const numAttributes = vertexAttributes.length;
        for (let i = 1; i < numAttributes; ++i) {
          const info = vertexAttributes[i];
          builder.addVarying(`highp ${info.glslDataType}`, `vCustom${i}`);
          vertexMain += `vCustom${i} = readAttribute${i}(vertexIndex);\n`;
          builder.addFragmentCode(`#define ${info.name} vCustom${i}\n`);
        }
        builder.setVertexMain(vertexMain);
        builder.setFragmentMainFunction(FRAGMENT_MAIN_START + '\n' + fragmentMain);
      });

  get gl(): GL {
    return this.base.gl;
  }

  constructor(public base: SkeletonLayer, public targetIsSliceView: boolean) {
    super();
  }

  defineAttributeAccess(builder: ShaderBuilder) {
    const {textureAccessHelper} = this;
    textureAccessHelper.defineShader(builder);
    const numAttributes = this.vertexAttributes.length;
    for (let j = vertexAttributeSamplerSymbols.length; j < numAttributes; ++j) {
      vertexAttributeSamplerSymbols[j] = Symbol(`SkeletonShader.vertexAttributeTextureUnit${j}`);
    }
    this.vertexAttributes.forEach((info, i) => {
      builder.addTextureSampler(
          `${getSamplerPrefixForDataType(info.dataType)}sampler2D` as ShaderSamplerType,
          `uVertexAttributeSampler${i}`, vertexAttributeSamplerSymbols[i]);
      builder.addVertexCode(textureAccessHelper.getAccessor(
          `readAttribute${i}`, `uVertexAttributeSampler${i}`, info.dataType, info.numComponents));
    });
  }

  getCrossSectionFadeFactor() {
    if (this.targetIsSliceView) {
      return `(clamp(1.0 - 2.0 * abs(0.5 - gl_FragCoord.z), 0.0, 1.0))`;
    } else {
      return `(1.0)`;
    }
  }

  beginLayer(
      gl: GL, shader: ShaderProgram,
      renderContext: SliceViewPanelRenderContext|PerspectiveViewRenderContext,
      objectToDataMatrix: mat4) {
    let {dataToDevice} = renderContext;
    let mat = mat4.multiply(tempMat2, dataToDevice, objectToDataMatrix);
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, mat);
  }

  setColor(gl: GL, shader: ShaderProgram, color: vec3) {
    gl.uniform4fv(shader.uniform('uColor'), color);
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform1ui(shader.uniform('uPickID'), pickID);
  }

  drawSkeleton(
      gl: GL, edgeShader: ShaderProgram, nodeShader: ShaderProgram|null,
      skeletonChunk: SkeletonChunk, renderContext: {viewportWidth: number, viewportHeight: number},
    lineWidth: number) {
    const {vertexAttributes} = this;
    const numAttributes = vertexAttributes.length;
    const {vertexAttributeTextures} = skeletonChunk;
    for (let i = 0; i < numAttributes; ++i) {
      const textureUnit = WebGL2RenderingContext.TEXTURE0 +
          edgeShader.textureUnit(vertexAttributeSamplerSymbols[i]);
      gl.activeTexture(textureUnit);
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, vertexAttributeTextures[i]);
    }

    // Draw edges
    {
      edgeShader.bind();
      this.textureAccessHelper.setupTextureLayout(gl, edgeShader, skeletonChunk);
      const aVertexIndex = edgeShader.attribute('aVertexIndex');
      skeletonChunk.indexBuffer.bindToVertexAttribI(
          aVertexIndex, 2, WebGL2RenderingContext.UNSIGNED_INT);
      gl.vertexAttribDivisor(aVertexIndex, 1);
      this.lineShader.draw(
          edgeShader, renderContext, lineWidth, this.targetIsSliceView ? 1.0 : 0.0,
          skeletonChunk.numIndices / 2);
      gl.vertexAttribDivisor(aVertexIndex, 0);
      gl.disableVertexAttribArray(aVertexIndex);
    }

    if (nodeShader !== null) {
      nodeShader.bind();
      this.textureAccessHelper.setupTextureLayout(gl, nodeShader, skeletonChunk);
      this.circleShader.draw(
          nodeShader, renderContext, {
            interiorRadiusInPixels: 5,
            borderWidthInPixels: 0,
            featherWidthInPixels: this.targetIsSliceView ? 1.0 : 0.0,
          },
          skeletonChunk.numVertices);
    }
  }

  endLayer(gl: GL, shader: ShaderProgram) {
    const {vertexAttributes} = this;
    const numAttributes = vertexAttributes.length;
    for (let i = 0; i < numAttributes; ++i) {
      let curTextureUnit =
          shader.textureUnit(vertexAttributeSamplerSymbols[i]) + WebGL2RenderingContext.TEXTURE0;
      gl.activeTexture(curTextureUnit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
}

export interface SkeletonLayerDisplayState extends SegmentationDisplayState3D {
  shaderError: WatchableShaderError;
  fragmentMain: TrackableValue<string>;
  showSkeletonNodes: WatchableValueInterface<boolean>;
}

export class SkeletonLayer extends RefCounted {
  private tempMat = mat4.create();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;
  vertexAttributes: VertexAttributeRenderInfo[];
  fallbackFragmentMain = new WatchableValue<string>(DEFAULT_FRAGMENT_MAIN);

  get visibility() {
    return this.sharedObject.visibility;
  }

  constructor(
      public chunkManager: ChunkManager, public source: SkeletonSource,
      public voxelSizeObject: VoxelSize, public displayState: SkeletonLayerDisplayState) {
    super();

    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);
    this.displayState.shaderError.value = undefined;
    this.registerDisposer(displayState.fragmentMain.changed.add(() => {
      this.displayState.shaderError.value = undefined;
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(displayState.showSkeletonNodes.changed.add(this.redrawNeeded.dispatch));
    let sharedObject = this.sharedObject =
        this.registerDisposer(new SegmentationLayerSharedObject(chunkManager, displayState));
    sharedObject.RPC_TYPE_ID = SKELETON_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      'source': source.addCounterpartRef(),
    });

    const vertexAttributes = this.vertexAttributes = [vertexPositionAttribute];

    for (let [name, info] of source.vertexAttributes) {
      vertexAttributes.push({
        name,
        dataType: info.dataType,
        numComponents: info.numComponents,
        webglDataType: getWebglDataType(info.dataType),
        glslDataType: info.numComponents > 1 ? `vec${info.numComponents}` : 'float',
      });
    }
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  draw(
      renderContext: SliceViewPanelRenderContext|PerspectiveViewRenderContext, layer: RenderLayer,
      renderHelper: RenderHelper, lineWidth?: number) {
    if (lineWidth === undefined) {
      lineWidth = renderContext.emitColor ? 1 : 5;
    }
    let {gl, source, displayState} = this;
    let alpha = Math.min(1.0, displayState.objectAlpha.value);
    if (alpha <= 0.0) {
      // Skip drawing.
      return;
    }
    const showSkeletonNodes = this.displayState.showSkeletonNodes.value;

    const edgeShader = renderHelper.edgeShaderGetter(renderContext.emitter);
    const nodeShader = renderHelper.nodeShaderGetter(renderContext.emitter);
    if (edgeShader === null || nodeShader === null) {
      // Shader error, skip drawing.
      return;
    }

    let objectToDataMatrix = this.tempMat;
    mat4.identity(objectToDataMatrix);
    if (source.skeletonVertexCoordinatesInVoxels) {
      mat4.scale(objectToDataMatrix, objectToDataMatrix, this.voxelSizeObject.size);
    }
    mat4.multiply(objectToDataMatrix, objectToDataMatrix, source.transform);
    mat4.multiply(
        objectToDataMatrix, this.displayState.objectToDataTransform.transform, objectToDataMatrix);

    edgeShader.bind();
    renderHelper.beginLayer(gl, edgeShader, renderContext, objectToDataMatrix);

    nodeShader.bind();
    renderHelper.beginLayer(gl, nodeShader, renderContext, objectToDataMatrix);

    const skeletons = source.chunks;
    const {pickIDs} = renderContext;

    forEachVisibleSegment(displayState, (objectId, rootObjectId) => {
      const key = getObjectKey(objectId);
      const skeleton = skeletons.get(key);
      if (skeleton === undefined || skeleton.state !== ChunkState.GPU_MEMORY) {
        return;
      }
      if (renderContext.emitColor) {
        edgeShader.bind();
        renderHelper.setColor(
            gl, edgeShader, <vec3><Float32Array>getObjectColor(displayState, rootObjectId, alpha));
        nodeShader.bind();
        renderHelper.setColor(
            gl, nodeShader, <vec3><Float32Array>getObjectColor(displayState, rootObjectId, alpha));
      }
      if (renderContext.emitPickID) {
        edgeShader.bind();
        renderHelper.setPickID(gl, edgeShader, pickIDs.registerUint64(layer, objectId));
        nodeShader.bind();
        renderHelper.setPickID(gl, nodeShader, pickIDs.registerUint64(layer, objectId));
      }
      renderHelper.drawSkeleton(
          gl, edgeShader, showSkeletonNodes ? nodeShader : null, skeleton, renderContext, lineWidth!
      );
    });
    renderHelper.endLayer(gl, edgeShader);
  }
}

export class PerspectiveViewSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper = this.registerDisposer(new RenderHelper(this.base, false));

  constructor(public base: SkeletonLayer) {
    super();
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.setReady(true);
    this.registerDisposer(base.visibility.add(this.visibility));
  }
  get gl() {
    return this.base.gl;
  }

  get isTransparent() {
    return this.base.displayState.objectAlpha.value < 1.0;
  }

  draw(renderContext: PerspectiveViewRenderContext) {
    this.base.draw(renderContext, this, this.renderHelper);
  }
}

export class SliceViewPanelSkeletonLayer extends SliceViewPanelRenderLayer {
  private renderHelper = this.registerDisposer(new RenderHelper(this.base, true));

  constructor(public base: SkeletonLayer) {
    super();
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.setReady(true);
    this.registerDisposer(base.visibility.add(this.visibility));
  }
  get gl() {
    return this.base.gl;
  }

  draw(renderContext: SliceViewPanelRenderContext) {
    this.base.draw(renderContext, this, this.renderHelper, 1);
  }
}

function getWebglDataType(dataType: DataType) {
  switch (dataType) {
    case DataType.FLOAT32:
      return WebGL2RenderingContext.FLOAT;
    default:
      throw new Error('Data type not supported by WebGL: ${DataType[dataType]}');
  }
}

const vertexPositionAttribute: VertexAttributeRenderInfo = {
  dataType: DataType.FLOAT32,
  numComponents: 3,
  name: '',
  webglDataType: WebGL2RenderingContext.FLOAT,
  glslDataType: 'vec3',
};

export class SkeletonChunk extends Chunk {
  source: SkeletonSource;
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  indexBuffer: Buffer;
  numIndices: number;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;
  vertexAttributeTextures: (WebGLTexture|null)[];

  // Emulation of buffer as texture.
  textureXBits: number;
  textureWidth: number;
  textureHeight: number;

  constructor(source: SkeletonSource, x: any) {
    super(source);
    this.vertexAttributes = x['vertexAttributes'];
    let indices = this.indices = x['indices'];
    this.numVertices = x['numVertices'];
    this.vertexAttributeOffsets = x['vertexAttributeOffsets'];
    this.numIndices = indices.length;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    compute1dTextureLayout(this, gl, /*texelsPerElement=*/ 1, this.numVertices);
    const {attributeTextureFormats} = this.source;
    const {vertexAttributes, vertexAttributeOffsets} = this;
    const vertexAttributeTextures: (WebGLTexture|null)[] = this.vertexAttributeTextures = [];
    for (let i = 0, numAttributes = vertexAttributeOffsets.length; i < numAttributes; ++i) {
      const texture = gl.createTexture();
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      setOneDimensionalTextureData(
          gl, this, attributeTextureFormats[i],
          vertexAttributes.subarray(
              vertexAttributeOffsets[i],
              i + 1 !== numAttributes ? vertexAttributeOffsets[i + 1] : vertexAttributes.length));
      vertexAttributeTextures[i] = texture;
    }
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
    this.indexBuffer = Buffer.fromData(
        gl, this.indices, WebGL2RenderingContext.ARRAY_BUFFER, WebGL2RenderingContext.STATIC_DRAW);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    const {vertexAttributeTextures} = this;
    for (const texture of vertexAttributeTextures) {
      gl.deleteTexture(texture);
    }
    vertexAttributeTextures.length = 0;
    this.indexBuffer.dispose();
  }
}

const emptyVertexAttributes = new Map<string, VertexAttributeInfo>();

function getAttributeTextureFormats(vertexAttributes: Map<string, VertexAttributeInfo>):
    TextureFormat[] {
  const attributeTextureFormats: TextureFormat[] = [vertexPositionTextureFormat];
  for (const info of vertexAttributes.values()) {
    attributeTextureFormats.push(
        computeTextureFormat(new TextureFormat(), info.dataType, info.numComponents));
  }
  return attributeTextureFormats;
}

export class SkeletonSource extends ChunkSource {
  private attributeTextureFormats_?: TextureFormat[];

  get attributeTextureFormats() {
    let attributeTextureFormats = this.attributeTextureFormats_;
    if (attributeTextureFormats === undefined) {
      attributeTextureFormats = this.attributeTextureFormats_ =
          getAttributeTextureFormats(this.vertexAttributes);
    }
    return attributeTextureFormats;
  }

  chunks: Map<string, SkeletonChunk>;
  getChunk(x: any) {
    return new SkeletonChunk(this, x);
  }

  transform: mat4;

  constructor(chunkManager: Borrowed<ChunkManager>, options: {transform?: mat4}) {
    super(chunkManager, options);
    const {transform = mat4.create()} = options;
    this.transform = transform;
  }

  /**
   * Specifies whether the skeleton vertex coordinates are specified in units of voxels rather than
   * nanometers.
   */
  get skeletonVertexCoordinatesInVoxels() {
    return true;
  }

  get vertexAttributes(): Map<string, VertexAttributeInfo> {
    return emptyVertexAttributes;
  }
}
