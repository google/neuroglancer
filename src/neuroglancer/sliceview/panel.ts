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

import {AxesLineHelper} from 'neuroglancer/axes_lines';
import {DisplayContext} from 'neuroglancer/display_context';
import {makeRenderedPanelVisibleLayerTracker, VisibilityTrackedRenderLayer} from 'neuroglancer/layer';
import {PickIDManager} from 'neuroglancer/object_picking';
import {FramePickingData, RenderedDataPanel, RenderedDataViewerState} from 'neuroglancer/rendered_data_panel';
import {SliceView, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableRGB} from 'neuroglancer/util/color';
import {ActionEvent, registerActionListener} from 'neuroglancer/util/event_action_map';
import {identityMat4, mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {TouchRotateInfo} from 'neuroglancer/util/touch_bindings';
import {FramebufferConfiguration, OffscreenCopyHelper, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderModule} from 'neuroglancer/webgl/shader';
import {ScaleBarTexture, TrackableScaleBarOptions} from 'neuroglancer/widget/scale_bar';

export interface SliceViewerState extends RenderedDataViewerState {
  showScaleBar: TrackableBoolean;
  scaleBarOptions: TrackableScaleBarOptions;
  crossSectionBackgroundColor: TrackableRGB;
}

export enum OffscreenTextures {
  COLOR,
  PICK,
  NUM_TEXTURES
}

function sliceViewPanelEmitColor(builder: ShaderBuilder) {
  builder.addOutputBuffer('vec4', 'out_fragColor', null);
  builder.addFragmentCode(`
void emit(vec4 color, highp uint pickId) {
  out_fragColor = color;
}
`);
}

function sliceViewPanelEmitPickID(builder: ShaderBuilder) {
  builder.addOutputBuffer('highp float', 'out_pickId', null);
  builder.addFragmentCode(`
void emit(vec4 color, highp uint pickId) {
  out_pickId = float(pickId);
}
`);
}


export interface SliceViewPanelRenderContext {
  dataToDevice: mat4;
  pickIDs: PickIDManager;
  emitter: ShaderModule;

  /**
   * Specifies whether the emitted color value will be used.
   */
  emitColor: boolean;

  /**
   * Specifies whether the emitted pick ID will be used.
   */
  emitPickID: boolean;

  /**
   * Width of GL viewport in pixels.
   */
  viewportWidth: number;

  /**
   * Height of GL viewport in pixels.
   */
  viewportHeight: number;

  sliceView: SliceView;
}

export class SliceViewPanelRenderLayer extends VisibilityTrackedRenderLayer {
  draw(_renderContext: SliceViewPanelRenderContext) {
    // Must be overridden by subclasses.
  }

  isReady() {
    return true;
  }
}

const tempVec4 = vec4.create();

export class SliceViewPanel extends RenderedDataPanel {
  viewer: SliceViewerState;

  private axesLineHelper = this.registerDisposer(AxesLineHelper.get(this.gl));
  private sliceViewRenderHelper =
      this.registerDisposer(SliceViewRenderHelper.get(this.gl, sliceViewPanelEmitColor));
  private colorFactor = vec4.fromValues(1, 1, 1, 1);
  private pickIDs = new PickIDManager();

  private visibleLayerTracker = makeRenderedPanelVisibleLayerTracker(
      this.viewer.layerManager, SliceViewPanelRenderLayer, this.viewer.visibleLayerRoles, this);

  private offscreenFramebuffer = this.registerDisposer(new FramebufferConfiguration(this.gl, {
    colorBuffers: [
      new TextureBuffer(
          this.gl, WebGL2RenderingContext.RGBA8, WebGL2RenderingContext.RGBA,
          WebGL2RenderingContext.UNSIGNED_BYTE),
      new TextureBuffer(
          this.gl, WebGL2RenderingContext.R32F, WebGL2RenderingContext.RED,
          WebGL2RenderingContext.FLOAT),
    ]
  }));

  private offscreenCopyHelper = this.registerDisposer(OffscreenCopyHelper.get(this.gl));
  private scaleBarCopyHelper = this.registerDisposer(OffscreenCopyHelper.get(this.gl));

  private scaleBarTexture = this.registerDisposer(new ScaleBarTexture(this.gl));

  get navigationState() {
    return this.sliceView.navigationState;
  }

  constructor(
      context: DisplayContext, element: HTMLElement, public sliceView: SliceView,
      viewer: SliceViewerState) {
    super(context, element, viewer);

    registerActionListener(element, 'rotate-via-mouse-drag', (e: ActionEvent<MouseEvent>) => {
      const {mouseState} = this.viewer;
      if (mouseState.updateUnconditionally()) {
        const initialPosition = vec3.clone(mouseState.position);
        startRelativeMouseDrag(e.detail, (_event, deltaX, deltaY) => {
          let {viewportAxes} = this.sliceView;
          this.viewer.navigationState.pose.rotateAbsolute(
              viewportAxes[1], -deltaX / 4.0 * Math.PI / 180.0, initialPosition);
          this.viewer.navigationState.pose.rotateAbsolute(
              viewportAxes[0], -deltaY / 4.0 * Math.PI / 180.0, initialPosition);
        });
      }
    });

    registerActionListener(
        element, 'rotate-in-plane-via-touchrotate', (e: ActionEvent<TouchRotateInfo>) => {
          const {detail} = e;
          const {mouseState} = this.viewer;
          this.handleMouseMove(detail.centerX, detail.centerY);
          if (mouseState.updateUnconditionally()) {
            const {viewportAxes} = this.sliceView;
            this.navigationState.pose.rotateAbsolute(
                viewportAxes[2], detail.angle - detail.prevAngle, mouseState.position);
          }
        });

    this.registerDisposer(sliceView);
    this.registerDisposer(
        viewer.crossSectionBackgroundColor.changed.add(() => this.scheduleRedraw()));
    this.registerDisposer(sliceView.visibility.add(this.visibility));
    this.registerDisposer(sliceView.viewChanged.add(() => {
      if (this.visible) {
        context.scheduleRedraw();
      }
    }));
    this.registerDisposer(viewer.showAxisLines.changed.add(() => {
      if (this.visible) {
        this.scheduleRedraw();
      }
    }));

    this.registerDisposer(viewer.showScaleBar.changed.add(() => {
      if (this.visible) {
        this.context.scheduleRedraw();
      }
    }));
    this.registerDisposer(viewer.scaleBarOptions.changed.add(() => {
      if (this.visible) {
        this.context.scheduleRedraw();
      }
    }));
  }

  translateByViewportPixels(deltaX: number, deltaY: number): void {
    const {position} = this.viewer.navigationState;
    const pos = position.spatialCoordinates;
    vec3.set(pos, -deltaX, -deltaY, 0);
    vec3.transformMat4(pos, pos, this.sliceView.viewportToData);
    position.changed.dispatch();
  }

  translateDataPointByViewportPixels(out: vec3, orig: vec3, deltaX: number, deltaY: number): vec3 {
    vec3.transformMat4(out, orig, this.sliceView.dataToViewport);
    vec3.set(out, out[0] + deltaX, out[1] + deltaY, out[2]);
    vec3.transformMat4(out, out, this.sliceView.viewportToData);
    return out;
  }

  isReady() {
    if (!this.visible) {
      return false;
    }

    if (!this.sliceView.isReady()) {
      return false;
    }

    let visibleLayers = this.visibleLayerTracker.getVisibleLayers();
    for (let renderLayer of visibleLayers) {
      if (!renderLayer.isReady()) {
        return false;
      }
    }
    return true;
  }

  drawWithPicking(pickingData: FramePickingData): boolean {
    let {sliceView} = this;
    sliceView.setViewportSize(this.width, this.height);
    sliceView.updateRendering();
    if (!sliceView.hasValidViewport) {
      return false;
    }
    mat4.copy(pickingData.invTransform, sliceView.viewportToData);
    const {gl} = this;

    const {width, height, dataToDevice} = sliceView;
    this.offscreenFramebuffer.bind(width, height);
    gl.disable(WebGL2RenderingContext.SCISSOR_TEST);
    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);

    // Draw axes lines.
    // FIXME: avoid use of temporary matrix
    let mat = mat4.create();

    const backgroundColor = tempVec4;
    const crossSectionBackgroundColor = this.viewer.crossSectionBackgroundColor.value;
    backgroundColor[0] = crossSectionBackgroundColor[0];
    backgroundColor[1] = crossSectionBackgroundColor[1];
    backgroundColor[2] = crossSectionBackgroundColor[2];
    backgroundColor[3] = 1;

    this.sliceViewRenderHelper.draw(
        sliceView.offscreenFramebuffer.colorBuffers[0].texture, identityMat4, this.colorFactor,
        backgroundColor, 0, 0, 1, 1);

    let visibleLayers = this.visibleLayerTracker.getVisibleLayers();
    let {pickIDs} = this;
    pickIDs.clear();
    this.offscreenFramebuffer.bindSingle(OffscreenTextures.COLOR);
    let renderContext: SliceViewPanelRenderContext = {
      dataToDevice: sliceView.dataToDevice,
      pickIDs: pickIDs,
      emitter: sliceViewPanelEmitColor,
      emitColor: true,
      emitPickID: false,
      viewportWidth: width,
      viewportHeight: height,
      sliceView,
    };
    gl.enable(WebGL2RenderingContext.BLEND);
    gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
    for (let renderLayer of visibleLayers) {
      renderLayer.draw(renderContext);
    }
    gl.disable(WebGL2RenderingContext.BLEND);
    this.offscreenFramebuffer.bindSingle(OffscreenTextures.PICK);
    renderContext.emitColor = false;
    renderContext.emitPickID = true;
    renderContext.emitter = sliceViewPanelEmitPickID;

    for (let renderLayer of visibleLayers) {
      renderLayer.draw(renderContext);
    }

    if (this.viewer.showAxisLines.value || this.viewer.showScaleBar.value) {
      if (this.viewer.showAxisLines.value) {
        // Construct matrix that maps [-1, +1] x/y range to the full viewport data
        // coordinates.
        mat4.copy(mat, dataToDevice);
        for (let i = 0; i < 3; ++i) {
          mat[12 + i] = 0;
        }

        for (let i = 0; i < 4; ++i) {
          mat[2 + 4 * i] = 0;
        }


        let axisLength = Math.min(width, height) / 4 * 1.5;
        let pixelSize = sliceView.pixelSize;
        for (let i = 0; i < 12; ++i) {
          // pixelSize is nm / pixel
          //
          mat[i] *= axisLength * pixelSize;
        }
      }
      this.offscreenFramebuffer.bindSingle(OffscreenTextures.COLOR);
      if (this.viewer.showAxisLines.value) {
        this.axesLineHelper.draw(mat);
      }
      if (this.viewer.showScaleBar.value) {
        gl.enable(WebGL2RenderingContext.BLEND);
        gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
        const options = this.viewer.scaleBarOptions.value;
        const {scaleBarTexture} = this;
        const {dimensions} = scaleBarTexture;
        dimensions.targetLengthInPixels = Math.min(
            options.maxWidthFraction * width, options.maxWidthInPixels * options.scaleFactor);
        dimensions.nanometersPerPixel = sliceView.pixelSize;
        scaleBarTexture.update(options);
        gl.viewport(
            options.leftPixelOffset * options.scaleFactor,
            options.bottomPixelOffset * options.scaleFactor, scaleBarTexture.width,
            scaleBarTexture.height);
        this.scaleBarCopyHelper.draw(scaleBarTexture.texture);
        gl.disable(WebGL2RenderingContext.BLEND);
      }
    }

    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLViewport();
    this.offscreenCopyHelper.draw(
        this.offscreenFramebuffer.colorBuffers[OffscreenTextures.COLOR].texture);
    return true;
  }

  panelSizeChanged() {
    this.sliceView.setViewportSizeDebounced(this.width, this.height);
  }

  issuePickRequest(glWindowX: number, glWindowY: number) {
    const {offscreenFramebuffer} = this;
    offscreenFramebuffer.readPixelFloat32IntoBuffer(
        OffscreenTextures.PICK, glWindowX, glWindowY, 0);
  }

  completePickRequest(
      glWindowX: number, glWindowY: number, data: Float32Array, pickingData: FramePickingData) {
    const {mouseState} = this.viewer;
    mouseState.pickedRenderLayer = null;
    const out = mouseState.position;
    const {viewportWidth, viewportHeight} = pickingData;
    const y = pickingData.viewportHeight - glWindowY;
    vec3.set(out, glWindowX - viewportWidth / 2, y - viewportHeight / 2, 0);
    vec3.transformMat4(out, out, pickingData.invTransform);
    this.pickIDs.setMouseState(mouseState, data[0]);
    mouseState.setActive(true);
  }

  /**
   * Zooms by the specified factor, maintaining the data position that projects to the current mouse
   * position.
   */
  zoomByMouse(factor: number) {
    let {navigationState} = this;
    if (!navigationState.valid) {
      return;
    }
    let {sliceView} = this;
    let {width, height} = sliceView;
    let {mouseX, mouseY} = this;
    mouseX -= width / 2;
    mouseY -= height / 2;
    let oldZoom = this.navigationState.zoomFactor.value;
    // oldPosition + (mouseX * viewportAxes[0] + mouseY * viewportAxes[1]) * oldZoom
    //     === newPosition + (mouseX * viewportAxes[0] + mouseY * viewportAxes[1]) * newZoom

    // Therefore, we compute newPosition by:
    // newPosition = oldPosition + (viewportAxes[0] * mouseX +
    //                              viewportAxes[1] * mouseY) * (oldZoom - newZoom).
    navigationState.zoomBy(factor);
    let newZoom = navigationState.zoomFactor.value;

    let {spatialCoordinates} = navigationState.position;
    vec3.scaleAndAdd(
        spatialCoordinates, spatialCoordinates, sliceView.viewportAxes[0],
        mouseX * (oldZoom - newZoom));
    vec3.scaleAndAdd(
        spatialCoordinates, spatialCoordinates, sliceView.viewportAxes[1],
        mouseY * (oldZoom - newZoom));
    navigationState.position.changed.dispatch();
  }
}
