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
import {LayerManager} from 'neuroglancer/layer';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {NavigationState} from 'neuroglancer/navigation_state';
import {DataType, SLICEVIEW_RPC_ID, SliceViewBase, VolumeChunkSource as VolumeChunkSourceInterface, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {RenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Disposable} from 'neuroglancer/util/disposable';
import {mat4, rectifyTransformMatrixIfAxisAligned, vec3, vec3Key, vec4} from 'neuroglancer/util/geom';
import {stableStringify} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, makeTextureBuffers, StencilBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {registerSharedObjectOwner, RPC} from 'neuroglancer/worker_rpc';

export type VolumeChunkKey = string;

const tempMat = mat4.create();

@registerSharedObjectOwner(SLICEVIEW_RPC_ID)
export class SliceView extends SliceViewBase {
  gl = this.chunkManager.gl;

  dataToViewport = mat4.create();

  // Transforms viewport coordinates to OpenGL normalized device coordinates
  // [left: -1, right: 1], [top: 1, bottom: -1].
  viewportToDevice = mat4.create();

  // Equals viewportToDevice * dataToViewport.
  dataToDevice = mat4.create();

  visibleChunks = new Map<ChunkLayout, VolumeChunkKey[]>();

  viewChanged = new NullarySignal();

  renderingStale = true;

  visibleChunksStale = true;

  visibleLayersStale = false;

  visibleLayerList = new Array<RenderLayer>();

  visibleLayers: Map<RenderLayer, VolumeChunkSource[]>;

  newVisibleLayers = new Set<RenderLayer>();

  offscreenFramebuffer = this.registerDisposer(new FramebufferConfiguration(
      this.gl,
      {colorBuffers: makeTextureBuffers(this.gl, 1), depthBuffer: new StencilBuffer(this.gl)}));

  constructor(
      public chunkManager: ChunkManager, public layerManager: LayerManager,
      public navigationState: NavigationState) {
    super();
    mat4.identity(this.dataToViewport);
    this.initializeCounterpart(this.chunkManager.rpc!, {'chunkManager': chunkManager.rpcId});
    this.updateVisibleLayers();

    this.registerDisposer(
        navigationState.changed.add(() => { this.updateViewportFromNavigationState(); }));
    this.updateViewportFromNavigationState();

    this.registerDisposer(layerManager.layersChanged.add(() => {
      if (!this.visibleLayersStale) {
        if (this.hasValidViewport) {
          this.visibleLayersStale = true;
          setTimeout(this.updateVisibleLayers.bind(this), 0);
        }
      }
    }));

    this.viewChanged.add(() => { this.renderingStale = true; });
    this.registerDisposer(chunkManager.chunkQueueManager.visibleChunksChanged.add(this.viewChanged.dispatch));

    this.updateViewportFromNavigationState();
  }

  private updateViewportFromNavigationState() {
    let {navigationState} = this;
    if (!navigationState.valid) {
      return;
    }
    navigationState.toMat4(tempMat);
    this.setViewportToDataMatrix(tempMat);
  }

  updateVisibleLayers() {
    if (!this.hasValidViewport) {
      return false;
    }
    this.visibleLayersStale = false;
    let visibleLayers = this.visibleLayers;
    let rpc = this.rpc!;
    let rpcMessage: any = {'id': this.rpcId};
    let newVisibleLayers = this.newVisibleLayers;
    let changed = false;
    let visibleLayerList = this.visibleLayerList;
    visibleLayerList.length = 0;
    for (let renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof RenderLayer) {
        newVisibleLayers.add(renderLayer);
        visibleLayerList.push(renderLayer);
        if (!visibleLayers.has(renderLayer)) {
          visibleLayers.set(renderLayer.addRef(), []);
          renderLayer.redrawNeeded.add(this.viewChanged.dispatch);
          rpcMessage['layerId'] = renderLayer.rpcId;
          rpc.invoke('SliceView.addVisibleLayer', rpcMessage);
          changed = true;
        }
      }
    }
    for (let renderLayer of visibleLayers.keys()) {
      if (!newVisibleLayers.has(renderLayer)) {
        visibleLayers.delete(renderLayer);
        renderLayer.redrawNeeded.remove(this.viewChanged.dispatch);
        rpcMessage['layerId'] = renderLayer.rpcId;
        rpc.invoke('SliceView.removeVisibleLayer', rpcMessage);
        renderLayer.dispose();
        changed = true;
      }
    }
    newVisibleLayers.clear();
    if (changed) {
      this.visibleSourcesStale = true;
    }
    // Unconditionally call viewChanged, because layers may have been reordered even if the set of
    // sources is the same.
    this.viewChanged.dispatch();
    return changed;
  }

  onViewportChanged() {
    var {width, height, viewportToDevice, dataToViewport, dataToDevice} = this;
    // FIXME: Make this adjustable.
    const sliceThickness = 10;
    mat4.ortho(
        viewportToDevice, -width / 2, width / 2, height / 2, -height / 2, -sliceThickness,
        sliceThickness);
    mat4.multiply(dataToDevice, viewportToDevice, dataToViewport);

    this.visibleChunksStale = true;
    this.viewChanged.dispatch();
  }
  setViewportSize(width: number, height: number) {
    if (super.setViewportSize(width, height)) {
      this.rpc!.invoke('SliceView.updateView', {id: this.rpcId, width: width, height: height});
      // this.chunkManager.scheduleUpdateChunkPriorities();
      return true;
    }
    return false;
  }

  onViewportToDataMatrixChanged() {
    let {viewportToData, dataToViewport} = this;
    mat4.invert(dataToViewport, viewportToData);
    rectifyTransformMatrixIfAxisAligned(dataToViewport);
    this.rpc!.invoke('SliceView.updateView', {id: this.rpcId, viewportToData: viewportToData});
  }

  onHasValidViewport() { this.updateVisibleLayers(); }

  updateRendering() {
    if (!this.renderingStale || !this.hasValidViewport || this.width === 0 || this.height === 0) {
      return;
    }
    this.renderingStale = false;
    this.maybeUpdateVisibleChunks();

    let {gl, offscreenFramebuffer, width, height} = this;

    offscreenFramebuffer.bind(width!, height!);
    gl.disable(gl.SCISSOR_TEST);

    // we have viewportToData
    // we need: matrix that maps input x to the output x axis, scaled by

    gl.clearStencil(0);
    gl.clearColor(0, 0, 0, 0);
    gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.stencilOpSeparate(
        /*face=*/gl.FRONT_AND_BACK, /*sfail=*/gl.KEEP, /*dpfail=*/gl.KEEP,
        /*dppass=*/gl.REPLACE);

    // console.log("Drawing sliceview");
    let renderLayerNum = 0;
    for (let renderLayer of this.visibleLayerList) {
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.stencilFuncSeparate(
          /*face=*/gl.FRONT_AND_BACK,
          /*func=*/gl.GREATER,
          /*ref=*/1,
          /*mask=*/1);
      if (renderLayerNum === 1) {
        // Turn on blending after the first layer.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      renderLayer.draw(this);
      ++renderLayerNum;
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    offscreenFramebuffer.unbind();
  }

  maybeUpdateVisibleChunks() {
    if (!this.visibleChunksStale && !this.visibleSourcesStale) {
      // console.log("Not updating visible chunks");
      return false;
    }
    // console.log("Updating visible");
    this.visibleChunksStale = false;
    this.updateVisibleChunks();
    return true;
  }
  updateVisibleChunks() {
    let allVisibleChunks = this.visibleChunks;

    function getLayoutObject(chunkLayout: ChunkLayout) {
      let visibleChunks = allVisibleChunks.get(chunkLayout);
      if (visibleChunks === undefined) {
        visibleChunks = [];
        allVisibleChunks.set(chunkLayout, visibleChunks);
      } else {
        visibleChunks.length = 0;
      }
      return visibleChunks;
    }
    function addChunk(_chunkLayout: ChunkLayout, visibleChunks: string[], positionInChunks: vec3) {
      let key = vec3Key(positionInChunks);
      visibleChunks[visibleChunks.length] = key;
    }
    this.computeVisibleChunks(getLayoutObject, addChunk);
  }

  disposed() {
    for (let renderLayer of this.visibleLayers.keys()) {
      renderLayer.dispose();
    }
    this.visibleLayers.clear();
    this.visibleLayerList.length = 0;
  }
};

export interface ChunkFormat {
  shaderKey: string;

  /**
   * Called on the ChunkFormat of the first source of a RenderLayer.
   *
   * This should define a fragment shader function:
   *
   *   value_type getDataValue(int channelIndex);
   *
   * where value_type is the shader data type corresponding to the chunk data type.  This function
   * should retrieve the value for channel `channelIndex` at position `getPositionWithinChunk()`
   * within the chunk.
   */
  defineShader: (builder: ShaderBuilder) => void;

  /**
   * Called once per RenderLayer when starting to draw chunks, on the ChunkFormat of the first
   * source.  This is not called before each source is drawn.
   */
  beginDrawing: (gl: GL, shader: ShaderProgram) => void;

  /**
   * Called once after all chunks have been drawn, on the ChunkFormat of the first source.
   */
  endDrawing: (gl: GL, shader: ShaderProgram) => void;

  /**
   * Called just before drawing each chunk, on the ChunkFormat .
   */
  bindChunk: (gl: GL, shader: ShaderProgram, chunk: VolumeChunk) => void;

  /**
   * Called just before drawing chunks for the source.
   */
  beginSource: (gl: GL, shader: ShaderProgram) => void;
}

export interface ChunkFormatHandler extends Disposable {
  chunkFormat: ChunkFormat;
  getChunk(source: VolumeChunkSource, x: any): VolumeChunk;
}

export type ChunkFormatHandlerFactory = (gl: GL, spec: VolumeChunkSpecification) =>
    ChunkFormatHandler | null;

var chunkFormatHandlers = new Array<ChunkFormatHandlerFactory>();

export function registerChunkFormatHandler(factory: ChunkFormatHandlerFactory) {
  chunkFormatHandlers.push(factory);
}

function getChunkFormatHandler(gl: GL, spec: VolumeChunkSpecification) {
  for (let handler of chunkFormatHandlers) {
    let result = handler(gl, spec);
    if (result != null) {
      return result;
    }
  }
  throw new Error('No chunk format handler found.');
}

const tempChunkGridPosition = vec3.create();
const tempLocalPosition = vec3.create();

export abstract class VolumeChunkSource extends ChunkSource implements VolumeChunkSourceInterface {
  chunkFormatHandler: ChunkFormatHandler;

  chunks: Map<string, VolumeChunk>;

  constructor(chunkManager: ChunkManager, public spec: VolumeChunkSpecification) {
    super(chunkManager);
    this.chunkFormatHandler =
        this.registerDisposer(getChunkFormatHandler(chunkManager.chunkQueueManager.gl, spec));
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['spec'] = this.spec.toObject();
    super.initializeCounterpart(rpc, options);
  }

  get chunkFormat() { return this.chunkFormatHandler.chunkFormat; }

  getValueAt(position: vec3) {
    const chunkGridPosition = tempChunkGridPosition;
    const localPosition = tempLocalPosition;
    let spec = this.spec;
    let chunkLayout = spec.chunkLayout;
    let chunkSize = chunkLayout.size;
    chunkLayout.globalToLocalSpatial(localPosition, position);
    for (let i = 0; i < 3; ++i) {
      const chunkSizeValue = chunkSize[i];
      const localPositionValue = localPosition[i];
      chunkGridPosition[i] = Math.floor(localPositionValue / chunkSizeValue);
    }
    let key = vec3Key(chunkGridPosition);
    let chunk = <VolumeChunk>this.chunks.get(key);
    if (!chunk) {
      return null;
    }
    // Reuse temporary variable.
    const dataPosition = chunkGridPosition;
    const voxelSize = spec.voxelSize;
    for (let i = 0; i < 3; ++i) {
      dataPosition[i] =
          Math.floor((localPosition[i] - chunkGridPosition[i] * chunkSize[i]) / voxelSize[i]);
    }
    let chunkDataSize = chunk.chunkDataSize;
    for (let i = 0; i < 3; ++i) {
      if (dataPosition[i] >= chunkDataSize[i]) {
        return undefined;
      }
    }
    let {numChannels} = spec;
    if (numChannels === 1) {
      return chunk.getChannelValueAt(dataPosition, 0);
    } else {
      let result = new Array<number|Uint64>(numChannels);
      for (let i = 0; i < numChannels; ++i) {
        result[i] = chunk.getChannelValueAt(dataPosition, i);
      }
      return result;
    }
  }

  getChunk(x: any) { return this.chunkFormatHandler.getChunk(this, x); }
};

/**
 * Defines a VolumeChunkSource for which all state, other than the VolumeChunkSpecification, is
 * encapsulated in an object of type Parameters.
 */
export function defineParameterizedVolumeChunkSource<Parameters>(
    parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  const newConstructor = class ParameterizedVolumeChunkSource extends VolumeChunkSource {
    constructor(
        chunkManager: ChunkManager, spec: VolumeChunkSpecification, public parameters: Parameters) {
      super(chunkManager, spec);
    }
    initializeCounterpart(rpc: RPC, options: any) {
      options['parameters'] = this.parameters;
      super.initializeCounterpart(rpc, options);
    }
    static get(chunkManager: ChunkManager, spec: VolumeChunkSpecification, parameters: Parameters) {
      return chunkManager.getChunkSource(
          this, stableStringify({parameters, spec: spec.toObject()}),
          () => new this(chunkManager, spec, parameters));
    }
    toString() { return parametersConstructor.stringify(this.parameters); }
  };
  newConstructor.prototype.RPC_TYPE_ID = parametersConstructor.RPC_ID;
  return newConstructor;
}

export abstract class VolumeChunk extends Chunk {
  chunkDataSize: vec3;
  chunkGridPosition: vec3;
  source: VolumeChunkSource;

  get chunkFormat() { return this.source.chunkFormat; }

  constructor(source: VolumeChunkSource, x: any) {
    super(source);
    this.chunkGridPosition = x['chunkGridPosition'];
    this.chunkDataSize = x['chunkDataSize'] || source.spec.chunkDataSize;
    this.state = ChunkState.SYSTEM_MEMORY;
  }
  abstract getChannelValueAt(dataPosition: vec3, channel: number): any;
};

export interface MultiscaleVolumeChunkSource {
  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  For each scale,
   * there may be alternative sources with different chunk layouts.
   */
  getSources: (options: VolumeSourceOptions) => VolumeChunkSource[][];

  chunkManager: ChunkManager;

  numChannels: number;
  dataType: DataType;
  volumeType: VolumeType;

  /**
   * Returns the associated mesh source, if there is one.
   *
   * This only makes sense if volumeType === VolumeType.SEGMENTATION.
   */
  getMeshSource: () => MeshSource | null;
}

/**
 * Helper for rendering a SliceView that has been pre-rendered to a texture.
 */
export class SliceViewRenderHelper extends RefCounted {
  private copyVertexPositionsBuffer = getSquareCornersBuffer(this.gl);
  private shader: ShaderProgram;

  private textureCoordinateAdjustment = new Float32Array(4);

  constructor(public gl: GL, emitter: ShaderModule) {
    super();
    let builder = new ShaderBuilder(gl);
    builder.addVarying('vec2', 'vTexCoord');
    builder.addUniform('sampler2D', 'uSampler');
    builder.addInitializer(shader => { gl.uniform1i(shader.uniform('uSampler'), 0); });
    builder.addUniform('vec4', 'uColorFactor');
    builder.addUniform('vec4', 'uBackgroundColor');
    builder.addUniform('mat4', 'uProjectionMatrix');
    builder.addUniform('vec4', 'uTextureCoordinateAdjustment');
    builder.require(emitter);
    builder.setFragmentMain(`
vec4 sampledColor = texture2D(uSampler, vTexCoord);
if (sampledColor.a == 0.0) {
  sampledColor = uBackgroundColor;
}
emit(sampledColor * uColorFactor, vec4(0,0,0,0));
`);
    builder.addAttribute('vec4', 'aVertexPosition');
    builder.setVertexMain(`
vTexCoord = uTextureCoordinateAdjustment.xy + 0.5 * (aVertexPosition.xy + 1.0) * uTextureCoordinateAdjustment.zw;
gl_Position = uProjectionMatrix * aVertexPosition;
`);
    this.shader = this.registerDisposer(builder.build());
  }

  draw(
      texture: WebGLTexture|null, projectionMatrix: mat4, colorFactor: vec4, backgroundColor: vec4,
      xStart: number, yStart: number, xEnd: number, yEnd: number) {
    let {gl, shader, textureCoordinateAdjustment} = this;
    textureCoordinateAdjustment[0] = xStart;
    textureCoordinateAdjustment[1] = yStart;
    textureCoordinateAdjustment[2] = xEnd - xStart;
    textureCoordinateAdjustment[3] = yEnd - yStart;
    shader.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniformMatrix4fv(shader.uniform('uProjectionMatrix'), false, projectionMatrix);
    gl.uniform4fv(shader.uniform('uColorFactor'), colorFactor);
    gl.uniform4fv(shader.uniform('uBackgroundColor'), backgroundColor);
    gl.uniform4fv(shader.uniform('uTextureCoordinateAdjustment'), textureCoordinateAdjustment);

    let aVertexPosition = shader.attribute('aVertexPosition');
    this.copyVertexPositionsBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/2);

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    gl.disableVertexAttribArray(aVertexPosition);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  static get(gl: GL, emitter: ShaderModule) {
    return gl.memoize.get(
        `sliceview/SliceViewRenderHelper:${getObjectId(emitter)}`,
        () => new SliceViewRenderHelper(gl, emitter));
  }
}
