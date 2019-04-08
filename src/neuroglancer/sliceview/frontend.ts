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

import debounce from 'lodash/debounce';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {LayerManager} from 'neuroglancer/layer';
import {NavigationState} from 'neuroglancer/navigation_state';
import {SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, SLICEVIEW_RPC_ID, SLICEVIEW_UPDATE_VIEW_RPC_ID, SliceViewBase, SliceViewChunkSource as SliceViewChunkSourceInterface, SliceViewChunkSpecification, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {RenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {Disposer, invokeDisposers, RefCounted} from 'neuroglancer/util/disposable';
import {mat4, rectifyTransformMatrixIfAxisAligned, vec3, vec3Key, vec4} from 'neuroglancer/util/geom';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, makeTextureBuffers, StencilBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {registerSharedObjectOwner, RPC} from 'neuroglancer/worker_rpc';

export type GenericChunkKey = string;

const tempMat = mat4.create();

class FrontendSliceViewBase extends SliceViewBase<SliceViewChunkSource, RenderLayer> {}
const Base = withSharedVisibility(FrontendSliceViewBase);

@registerSharedObjectOwner(SLICEVIEW_RPC_ID)
export class SliceView extends Base {
  gl = this.chunkManager.gl;

  dataToViewport = mat4.create();

  // Transforms viewport coordinates to OpenGL normalized device coordinates
  // [left: -1, right: 1], [top: 1, bottom: -1].
  viewportToDevice = mat4.create();

  // Equals viewportToDevice * dataToViewport.
  dataToDevice = mat4.create();

  visibleChunks = new Map<ChunkLayout, GenericChunkKey[]>();

  viewChanged = new NullarySignal();

  renderingStale = true;

  visibleChunksStale = true;

  visibleLayerList = new Array<RenderLayer>();

  newVisibleLayers = new Set<RenderLayer>();

  offscreenFramebuffer = this.registerDisposer(new FramebufferConfiguration(
      this.gl,
      {colorBuffers: makeTextureBuffers(this.gl, 1), depthBuffer: new StencilBuffer(this.gl)}));

  numVisibleChunks = 0;

  constructor(
      public chunkManager: ChunkManager, public layerManager: LayerManager,
      public navigationState: NavigationState) {
    super();
    mat4.identity(this.dataToViewport);
    const rpc = this.chunkManager.rpc!;
    this.initializeCounterpart(rpc, {
      'chunkManager': chunkManager.rpcId,
    });
    this.registerDisposer(navigationState.changed.add(() => {
      this.updateViewportFromNavigationState();
    }));
    this.updateViewportFromNavigationState();

    this.registerDisposer(layerManager.layersChanged.add(() => {
      if (this.hasValidViewport) {
        this.updateVisibleLayers();
      }
    }));

    this.viewChanged.add(() => {
      this.renderingStale = true;
    });
    this.registerDisposer(
        chunkManager.chunkQueueManager.visibleChunksChanged.add(this.viewChanged.dispatch));

    this.updateViewportFromNavigationState();
    this.updateVisibleLayers();
  }

  isReady() {
    this.setViewportSizeDebounced.flush();
    if (!this.hasValidViewport) {
      return false;
    }
    this.maybeUpdateVisibleChunks();
    let numValidChunks = 0;
    for (const visibleSources of this.visibleLayers.values()) {
      for (const {chunkLayout, source} of visibleSources) {
        // FIXME: handle change to chunkLayout
        const visibleChunks = this.visibleChunks.get(chunkLayout);
        if (!visibleChunks) {
          return false;
        }
        const {chunks} = source;
        for (const key of visibleChunks) {
          const chunk = chunks.get(key);
          if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
            ++numValidChunks;
          }
        }
      }
    }
    return numValidChunks === this.numVisibleChunks;
  }

  private updateViewportFromNavigationState() {
    let {navigationState} = this;
    if (!navigationState.valid) {
      return;
    }
    navigationState.toMat4(tempMat);
    this.setViewportToDataMatrix(tempMat);
  }

  private updateVisibleLayers = this.registerCancellable(debounce(() => {
    this.updateVisibleLayersNow();
  }, 0));

  private invalidateVisibleSources = (() => {
    this.visibleSourcesStale = true;
    this.viewChanged.dispatch();
  });

  private bindVisibleRenderLayer(renderLayer: RenderLayer, disposers: Disposer[]) {
    disposers.push(renderLayer.redrawNeeded.add(this.viewChanged.dispatch));
    disposers.push(renderLayer.transform.changed.add(this.invalidateVisibleSources));
    disposers.push(renderLayer.renderScaleTarget.changed.add(this.invalidateVisibleSources));
    const {renderScaleHistogram} = renderLayer;
    if (renderScaleHistogram !== undefined) {
      disposers.push(renderScaleHistogram.visibility.add(this.visibility));
    }
  }

  private visibleLayerDisposers = new Map<RenderLayer, Disposer[]>();

  private updateVisibleLayersNow() {
    if (this.wasDisposed) {
      return false;
    }
    if (!this.hasValidViewport) {
      return false;
    }
    let visibleLayers = this.visibleLayers;
    let rpc = this.rpc!;
    let rpcMessage: any = {'id': this.rpcId};
    let newVisibleLayers = this.newVisibleLayers;
    let changed = false;
    let visibleLayerList = this.visibleLayerList;
    const {visibleLayerDisposers} = this;
    visibleLayerList.length = 0;
    for (let renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof RenderLayer) {
        newVisibleLayers.add(renderLayer);
        visibleLayerList.push(renderLayer);
        if (!visibleLayers.has(renderLayer)) {
          visibleLayers.set(renderLayer.addRef(), []);
          const disposers: Disposer[] = [];
          visibleLayerDisposers.set(renderLayer, disposers);
          this.bindVisibleRenderLayer(renderLayer, disposers);
          rpcMessage['layerId'] = renderLayer.rpcId;
          rpc.invoke(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, rpcMessage);
          changed = true;
        }
      }
    }
    for (let renderLayer of visibleLayers.keys()) {
      if (!newVisibleLayers.has(renderLayer)) {
        visibleLayers.delete(renderLayer);
        const disposers = this.visibleLayerDisposers.get(renderLayer)!;
        this.visibleLayerDisposers.delete(renderLayer);
        invokeDisposers(disposers);
        rpcMessage['layerId'] = renderLayer.rpcId;
        rpc.invoke(SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, rpcMessage);
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
  setViewportSizeDebounced = this.registerCancellable(
      debounce((width: number, height: number) => this.setViewportSize(width, height), 0));
  setViewportSize(width: number, height: number) {
    this.setViewportSizeDebounced.cancel();
    if (super.setViewportSize(width, height)) {
      this.rpc!.invoke(
          SLICEVIEW_UPDATE_VIEW_RPC_ID, {id: this.rpcId, width: width, height: height});
      // this.chunkManager.scheduleUpdateChunkPriorities();
      return true;
    }
    return false;
  }

  onViewportToDataMatrixChanged() {
    let {viewportToData, dataToViewport} = this;
    mat4.invert(dataToViewport, viewportToData);
    rectifyTransformMatrixIfAxisAligned(dataToViewport);
    this.rpc!.invoke(
        SLICEVIEW_UPDATE_VIEW_RPC_ID, {id: this.rpcId, viewportToData: viewportToData});
  }

  onHasValidViewport() {
    this.updateVisibleLayers();
  }

  updateRendering() {
    this.setViewportSizeDebounced.flush();
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
        /*face=*/ gl.FRONT_AND_BACK, /*sfail=*/ gl.KEEP, /*dpfail=*/ gl.KEEP,
        /*dppass=*/ gl.REPLACE);

    let renderLayerNum = 0;
    for (let renderLayer of this.visibleLayerList) {
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.stencilFuncSeparate(
          /*face=*/ gl.FRONT_AND_BACK,
          /*func=*/ gl.GREATER,
          /*ref=*/ 1,
          /*mask=*/ 1);

      renderLayer.setGLBlendMode(gl, renderLayerNum);
      renderLayer.draw(this);
      ++renderLayerNum;
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    offscreenFramebuffer.unbind();
  }

  maybeUpdateVisibleChunks() {
    this.updateVisibleLayers.flush();
    if (!this.visibleChunksStale && !this.visibleSourcesStale) {
      return false;
    }
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
    let numVisibleChunks = 0;
    function addChunk(
        _chunkLayout: ChunkLayout, visibleChunks: string[], positionInChunks: vec3,
        fullyVisibleSources: SliceViewChunkSource[]) {
      let key = vec3Key(positionInChunks);
      visibleChunks[visibleChunks.length] = key;
      numVisibleChunks += fullyVisibleSources.length;
    }
    this.computeVisibleChunks(getLayoutObject, addChunk);
    this.numVisibleChunks = numVisibleChunks;
  }

  disposed() {
    for (const [renderLayer, disposers] of this.visibleLayerDisposers) {
      invokeDisposers(disposers);
      renderLayer.dispose();
    }
    this.visibleLayerDisposers.clear();
    this.visibleLayers.clear();
    this.visibleLayerList.length = 0;
  }
}

export interface SliceViewChunkSourceOptions {
  spec: SliceViewChunkSpecification;
}

export abstract class SliceViewChunkSource extends ChunkSource implements
    SliceViewChunkSourceInterface {
  chunks: Map<string, SliceViewChunk>;

  spec: SliceViewChunkSpecification;

  constructor(chunkManager: ChunkManager, options: SliceViewChunkSourceOptions) {
    super(chunkManager, options);
    this.spec = options.spec;
  }

  static encodeOptions(options: SliceViewChunkSourceOptions) {
    const encoding = super.encodeOptions(options);
    encoding.spec = options.spec.toObject();
    return encoding;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['spec'] = this.spec.toObject();
    super.initializeCounterpart(rpc, options);
  }
}

export interface SliceViewChunkSource {
  // TODO(jbms): Move this declaration to the class definition above and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(x: any): any;
}

export class SliceViewChunk extends Chunk {
  chunkGridPosition: vec3;
  source: SliceViewChunkSource;

  constructor(source: SliceViewChunkSource, x: any) {
    super(source);
    this.chunkGridPosition = x['chunkGridPosition'];
    this.state = ChunkState.SYSTEM_MEMORY;
  }
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
    builder.addInitializer(shader => {
      gl.uniform1i(shader.uniform('uSampler'), 0);
    });
    builder.addUniform('vec4', 'uColorFactor');
    builder.addUniform('vec4', 'uBackgroundColor');
    builder.addUniform('mat4', 'uProjectionMatrix');
    builder.addUniform('vec4', 'uTextureCoordinateAdjustment');
    builder.require(emitter);
    builder.setFragmentMain(`
vec4 sampledColor = texture(uSampler, vTexCoord);
if (sampledColor.a == 0.0) {
  sampledColor = uBackgroundColor;
}
emit(sampledColor * uColorFactor, 0u);
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
    this.copyVertexPositionsBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/ 2);

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

export interface MultiscaleSliceViewChunkSource {
  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  For each scale,
   * there may be alternative sources with different chunk layouts.
   */
  getSources: (options: SliceViewSourceOptions) => SliceViewChunkSource[][];

  chunkManager: ChunkManager;
}
