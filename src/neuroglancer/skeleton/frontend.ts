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

import {ChunkState, LayerChunkProgressInfo} from 'neuroglancer/chunk_manager/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {LayerView, VisibleLayerInfo} from 'neuroglancer/layer';
import {PerspectivePanel} from 'neuroglancer/perspective_view/panel';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {RenderLayer, ThreeDimensionalRenderLayerAttachmentState, update3dRenderLayerAttachment} from 'neuroglancer/renderlayer';
import {forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {forEachVisibleSegmentToDraw, registerRedrawWhenSegmentationDisplayState3DChanged, SegmentationDisplayState3D, SegmentationLayerSharedObject} from 'neuroglancer/segmentation_display_state/frontend';
import {SKELETON_LAYER_RPC_ID, VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SliceViewPanel} from 'neuroglancer/sliceview/panel';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {TrackableValue, WatchableValue} from 'neuroglancer/trackable_value';
import {DataType} from 'neuroglancer/util/data_type';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {verifyFinitePositiveFloat} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {CompoundTrackable, Trackable} from 'neuroglancer/util/trackable';
import {TrackableEnum} from 'neuroglancer/util/trackable_enum';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {defineCircleShader, drawCircles, initializeCircleShader} from 'neuroglancer/webgl/circles';
import {glsl_COLORMAPS} from 'neuroglancer/webgl/colormaps';
import {GL} from 'neuroglancer/webgl/context';
import {makeTrackableFragmentMain, parameterizedEmitterDependentShaderGetter, shaderCodeWithLineDirective, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {defineLineShader, drawLines, initializeLineShader} from 'neuroglancer/webgl/lines';
import {ShaderBuilder, ShaderProgram, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {addControlsToBuilder, getFallbackBuilderState, parseShaderUiControls, setControlsInShader, ShaderControlsBuilderState, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {computeTextureFormat, getSamplerPrefixForDataType, OneDimensionalTextureAccessHelper, setOneDimensionalTextureData, TextureFormat} from 'neuroglancer/webgl/texture_access';
import {defineVertexId, VertexIdHelper} from 'neuroglancer/webgl/vertex_id';

const tempMat2 = mat4.create();

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitDefault();
}
`;

interface VertexAttributeRenderInfo extends VertexAttributeInfo {
  name: string;
  webglDataType: number;
  glslDataType: string;
}

const vertexAttributeSamplerSymbols: Symbol[] = [];

const vertexPositionTextureFormat = computeTextureFormat(new TextureFormat(), DataType.FLOAT32, 3);

class RenderHelper extends RefCounted {
  private textureAccessHelper = new OneDimensionalTextureAccessHelper('vertexData');
  private vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));
  get vertexAttributes(): VertexAttributeRenderInfo[] {
    return this.base.vertexAttributes;
  }

  defineCommonShader(builder: ShaderBuilder) {
    defineVertexId(builder);
    builder.addUniform('highp vec4', 'uColor');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp uint', 'uPickID');
  }

  edgeShaderGetter = parameterizedEmitterDependentShaderGetter(this, this.gl, {
    memoizeKey:
        {type: 'skeleton/SkeletonShaderManager/edge', vertexAttributes: this.vertexAttributes},
    fallbackParameters: this.base.fallbackShaderParameters,
    parameters: this.base.displayState.skeletonRenderingOptions.shaderControlState.builderState,
    shaderError: this.base.displayState.shaderError,
    defineShader:
        (builder: ShaderBuilder, shaderBuilderState: ShaderControlsBuilderState) => {
          if (shaderBuilderState.parseResult.errors.length !== 0) {
            throw new Error('Invalid UI control specification');
          }
          this.defineCommonShader(builder);
          this.defineAttributeAccess(builder);
          defineLineShader(builder);
          builder.addAttribute('highp uvec2', 'aVertexIndex');
          builder.addUniform('highp float', 'uLineWidth');
          let vertexMain = `
highp vec3 vertexA = readAttribute0(aVertexIndex.x);
highp vec3 vertexB = readAttribute0(aVertexIndex.y);
emitLine(uProjection, vertexA, vertexB, uLineWidth);
highp uint lineEndpointIndex = getLineEndpointIndex();
highp uint vertexIndex = aVertexIndex.x * lineEndpointIndex + aVertexIndex.y * (1u - lineEndpointIndex);
`;

          builder.addFragmentCode(`
vec4 segmentColor() {
  return uColor;
}
void emitRGB(vec3 color) {
  emit(vec4(color * uColor.a, uColor.a * getLineAlpha() * ${
              this.getCrossSectionFadeFactor()}), uPickID);
}
void emitDefault() {
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
          addControlsToBuilder(shaderBuilderState, builder);
          builder.setFragmentMainFunction(
              shaderCodeWithLineDirective(shaderBuilderState.parseResult.code));
        },
  });

  nodeShaderGetter = parameterizedEmitterDependentShaderGetter(this, this.gl, {
    memoizeKey:
        {type: 'skeleton/SkeletonShaderManager/node', vertexAttributes: this.vertexAttributes},
    fallbackParameters: this.base.fallbackShaderParameters,
    parameters: this.base.displayState.skeletonRenderingOptions.shaderControlState.builderState,
    shaderError: this.base.displayState.shaderError,
    defineShader:
        (builder: ShaderBuilder, shaderBuilderState: ShaderControlsBuilderState) => {
          if (shaderBuilderState.parseResult.errors.length !== 0) {
            throw new Error('Invalid UI control specification');
          }
          this.defineCommonShader(builder);
          this.defineAttributeAccess(builder);
          defineCircleShader(builder, /*crossSectionFade=*/ this.targetIsSliceView);
          builder.addUniform('highp float', 'uNodeDiameter');
          let vertexMain = `
highp uint vertexIndex = uint(gl_InstanceID);
highp vec3 vertexPosition = readAttribute0(vertexIndex);
emitCircle(uProjection * vec4(vertexPosition, 1.0), uNodeDiameter, 0.0);
`;

          builder.addFragmentCode(`
vec4 segmentColor() {
  return uColor;
}
void emitRGBA(vec4 color) {
  vec4 borderColor = color;
  emit(getCircleColor(color, borderColor), uPickID);
}
void emitRGB(vec3 color) {
  emitRGBA(vec4(color, 1.0));
}
void emitDefault() {
  emitRGBA(uColor);
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
          addControlsToBuilder(shaderBuilderState, builder);
          builder.setFragmentMainFunction(
              shaderCodeWithLineDirective(shaderBuilderState.parseResult.code));
        },
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
      renderContext: SliceViewPanelRenderContext|PerspectiveViewRenderContext, modelMatrix: mat4) {
    const {viewProjectionMat} = renderContext.projectionParameters;
    let mat = mat4.multiply(tempMat2, viewProjectionMat, modelMatrix);
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, mat);
    this.vertexIdHelper.enable();
  }

  setColor(gl: GL, shader: ShaderProgram, color: vec3) {
    gl.uniform4fv(shader.uniform('uColor'), color);
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform1ui(shader.uniform('uPickID'), pickID);
  }

  drawSkeleton(
      gl: GL, edgeShader: ShaderProgram, nodeShader: ShaderProgram|null,
      skeletonChunk: SkeletonChunk, projectionParameters: {width: number, height: number}) {
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
      const aVertexIndex = edgeShader.attribute('aVertexIndex');
      skeletonChunk.indexBuffer.bindToVertexAttribI(
          aVertexIndex, 2, WebGL2RenderingContext.UNSIGNED_INT);
      gl.vertexAttribDivisor(aVertexIndex, 1);
      initializeLineShader(edgeShader, projectionParameters, this.targetIsSliceView ? 1.0 : 0.0);
      drawLines(gl, 1, skeletonChunk.numIndices / 2);
      gl.vertexAttribDivisor(aVertexIndex, 0);
      gl.disableVertexAttribArray(aVertexIndex);
    }

    if (nodeShader !== null) {
      nodeShader.bind();
      initializeCircleShader(
          nodeShader, projectionParameters,
          {featherWidthInPixels: this.targetIsSliceView ? 1.0 : 0.0});
      drawCircles(nodeShader.gl, 2, skeletonChunk.numVertices);
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
    this.vertexIdHelper.disable();
  }
}

export enum SkeletonRenderMode {
  LINES,
  LINES_AND_POINTS,
}

export class TrackableSkeletonRenderMode extends TrackableEnum<SkeletonRenderMode> {
  constructor(value: SkeletonRenderMode, defaultValue: SkeletonRenderMode = value) {
    super(SkeletonRenderMode, value, defaultValue);
  }
}

export class TrackableSkeletonLineWidth extends TrackableValue<number> {
  constructor(value: number, defaultValue: number = value) {
    super(value, verifyFinitePositiveFloat, defaultValue);
  }
}

export interface ViewSpecificSkeletonRenderingOptions {
  mode: TrackableSkeletonRenderMode;
  lineWidth: TrackableSkeletonLineWidth;
}

export class SkeletonRenderingOptions implements Trackable {
  private compound = new CompoundTrackable();
  get changed() {
    return this.compound.changed;
  }

  shader = makeTrackableFragmentMain(DEFAULT_FRAGMENT_MAIN);
  shaderControlState = new ShaderControlState(this.shader);
  params2d: ViewSpecificSkeletonRenderingOptions = {
    mode: new TrackableSkeletonRenderMode(SkeletonRenderMode.LINES_AND_POINTS),
    lineWidth: new TrackableSkeletonLineWidth(2),
  };
  params3d: ViewSpecificSkeletonRenderingOptions = {
    mode: new TrackableSkeletonRenderMode(SkeletonRenderMode.LINES),
    lineWidth: new TrackableSkeletonLineWidth(1),
  };

  constructor() {
    const {compound} = this;
    compound.add('shader', this.shader);
    compound.add('shaderControls', this.shaderControlState);
    compound.add('mode2d', this.params2d.mode);
    compound.add('lineWidth2d', this.params2d.lineWidth);
    compound.add('mode3d', this.params3d.mode);
    compound.add('lineWidth3d', this.params3d.lineWidth);
  }

  reset() {
    this.compound.reset();
  }

  restoreState(obj: any) {
    if (obj === undefined) return;
    this.compound.restoreState(obj);
  }

  toJSON(): any {
    const obj = this.compound.toJSON();
    for (const v of Object.values(obj)) {
      if (v !== undefined) return obj;
    }
    return undefined;
  }
}

export interface SkeletonLayerDisplayState extends SegmentationDisplayState3D {
  shaderError: WatchableShaderError;
  skeletonRenderingOptions: SkeletonRenderingOptions;
}

export class SkeletonLayer extends RefCounted {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;
  vertexAttributes: VertexAttributeRenderInfo[];
  fallbackShaderParameters =
      new WatchableValue(getFallbackBuilderState(parseShaderUiControls(DEFAULT_FRAGMENT_MAIN)));

  get visibility() {
    return this.sharedObject.visibility;
  }

  constructor(
      public chunkManager: ChunkManager, public source: SkeletonSource,
      public displayState: SkeletonLayerDisplayState) {
    super();

    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);
    this.displayState.shaderError.value = undefined;
    const {skeletonRenderingOptions: renderingOptions} = displayState;
    this.registerDisposer(renderingOptions.shader.changed.add(() => {
      this.displayState.shaderError.value = undefined;
      this.redrawNeeded.dispatch();
    }));
    let sharedObject = this.sharedObject = this.registerDisposer(
        new SegmentationLayerSharedObject(chunkManager, displayState, this.layerChunkProgressInfo));
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
      renderHelper: RenderHelper, renderOptions: ViewSpecificSkeletonRenderingOptions,
      attachment: VisibleLayerInfo<LayerView, ThreeDimensionalRenderLayerAttachmentState>) {
    let lineWidth = renderOptions.lineWidth.value;
    const {gl, source, displayState} = this;
    if (displayState.objectAlpha.value <= 0.0) {
      // Skip drawing.
      return;
    }
    const modelMatrix = update3dRenderLayerAttachment(
        displayState.transform.value, renderContext.projectionParameters.displayDimensionRenderInfo,
        attachment);
    if (modelMatrix === undefined) return;
    let pointDiameter: number;
    if (renderOptions.mode.value === SkeletonRenderMode.LINES_AND_POINTS) {
      pointDiameter = Math.max(5, lineWidth * 2);
    } else {
      pointDiameter = lineWidth;
    }

    const edgeShaderResult = renderHelper.edgeShaderGetter(renderContext.emitter);
    const nodeShaderResult = renderHelper.nodeShaderGetter(renderContext.emitter);
    const {shader: edgeShader, parameters: edgeShaderParameters} = edgeShaderResult;
    const {shader: nodeShader, parameters: nodeShaderParameters} = nodeShaderResult;
    if (edgeShader === null || nodeShader === null) {
      // Shader error, skip drawing.
      return;
    }

    const {shaderControlState} = this.displayState.skeletonRenderingOptions;

    edgeShader.bind();
    renderHelper.beginLayer(gl, edgeShader, renderContext, modelMatrix);
    setControlsInShader(
        gl, edgeShader, shaderControlState, edgeShaderParameters.parseResult.controls);
    gl.uniform1f(edgeShader.uniform('uLineWidth'), lineWidth!);

    nodeShader.bind();
    renderHelper.beginLayer(gl, nodeShader, renderContext, modelMatrix);
    gl.uniform1f(nodeShader.uniform('uNodeDiameter'), pointDiameter);
    setControlsInShader(
        gl, nodeShader, shaderControlState, nodeShaderParameters.parseResult.controls);

    const skeletons = source.chunks;

    forEachVisibleSegmentToDraw(
        displayState, layer, renderContext.emitColor,
        renderContext.emitPickID ? renderContext.pickIDs : undefined,
        (objectId, color, pickIndex) => {
          const key = getObjectKey(objectId);
          const skeleton = skeletons.get(key);
          if (skeleton === undefined || skeleton.state !== ChunkState.GPU_MEMORY) {
            return;
          }
          if (color !== undefined) {
            edgeShader.bind();
            renderHelper.setColor(gl, edgeShader, <vec3><Float32Array>color);
            nodeShader.bind();
            renderHelper.setColor(gl, nodeShader, <vec3><Float32Array>color);
          }
          if (pickIndex !== undefined) {
            edgeShader.bind();
            renderHelper.setPickID(gl, edgeShader, pickIndex);
            nodeShader.bind();
            renderHelper.setPickID(gl, nodeShader, pickIndex);
          }
          renderHelper.drawSkeleton(
              gl, edgeShader, nodeShader, skeleton, renderContext.projectionParameters);
        });
    renderHelper.endLayer(gl, edgeShader);
  }

  isReady() {
    const {source, displayState} = this;
    if (displayState.objectAlpha.value <= 0.0) {
      // Skip drawing.
      return true;
    }

    const skeletons = source.chunks;

    let ready = true;

    forEachVisibleSegment(displayState.segmentationGroupState.value, objectId => {
      const key = getObjectKey(objectId);
      const skeleton = skeletons.get(key);
      if (skeleton === undefined || skeleton.state !== ChunkState.GPU_MEMORY) {
        ready = false;
        return;
      }
    });
    return ready;
  }
}

export class PerspectiveViewSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper = this.registerDisposer(new RenderHelper(this.base, false));
  private renderOptions = this.base.displayState.skeletonRenderingOptions.params3d;
  constructor(public base: SkeletonLayer) {
    super();
    this.layerChunkProgressInfo = base.layerChunkProgressInfo;
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
    const {renderOptions} = this;
    this.registerDisposer(renderOptions.mode.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(renderOptions.lineWidth.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(base.visibility.add(this.visibility));
  }
  get gl() {
    return this.base.gl;
  }

  get isTransparent() {
    return this.base.displayState.objectAlpha.value < 1.0;
  }

  draw(
      renderContext: PerspectiveViewRenderContext,
      attachment: VisibleLayerInfo<PerspectivePanel, ThreeDimensionalRenderLayerAttachmentState>) {
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      // No need for a separate pick ID pass.
      return;
    }
    this.base.draw(renderContext, this, this.renderHelper, this.renderOptions, attachment);
  }

  isReady() {
    return this.base.isReady();
  }
}

export class SliceViewPanelSkeletonLayer extends SliceViewPanelRenderLayer {
  private renderHelper = this.registerDisposer(new RenderHelper(this.base, true));
  private renderOptions = this.base.displayState.skeletonRenderingOptions.params2d;
  constructor(public base: SkeletonLayer) {
    super();
    this.layerChunkProgressInfo = base.layerChunkProgressInfo;
    this.registerDisposer(base);
    const {renderOptions} = this;
    this.registerDisposer(renderOptions.mode.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(renderOptions.lineWidth.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
    this.registerDisposer(base.visibility.add(this.visibility));
  }
  get gl() {
    return this.base.gl;
  }

  draw(
      renderContext: SliceViewPanelRenderContext,
      attachment: VisibleLayerInfo<SliceViewPanel, ThreeDimensionalRenderLayerAttachmentState>) {
    this.base.draw(renderContext, this, this.renderHelper, this.renderOptions, attachment);
  }

  isReady() {
    return this.base.isReady();
  }
}

function getWebglDataType(dataType: DataType) {
  switch (dataType) {
    case DataType.FLOAT32:
      return WebGL2RenderingContext.FLOAT;
    default:
      throw new Error(`Data type not supported by WebGL: ${DataType[dataType]}`);
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
    const {attributeTextureFormats} = this.source;
    const {vertexAttributes, vertexAttributeOffsets} = this;
    const vertexAttributeTextures: (WebGLTexture|null)[] = this.vertexAttributeTextures = [];
    for (let i = 0, numAttributes = vertexAttributeOffsets.length; i < numAttributes; ++i) {
      const texture = gl.createTexture();
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
      setOneDimensionalTextureData(
          gl, attributeTextureFormats[i],
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

export interface SkeletonSourceOptions {}

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

  constructor(chunkManager: Borrowed<ChunkManager>, options: SkeletonSourceOptions) {
    super(chunkManager, options);
  }

  get vertexAttributes(): Map<string, VertexAttributeInfo> {
    return emptyVertexAttributes;
  }
}
