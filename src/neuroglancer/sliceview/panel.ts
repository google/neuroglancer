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

import {AxesLineHelper, computeAxisLineMatrix} from 'neuroglancer/axes_lines';
import {DisplayContext} from 'neuroglancer/display_context';
import {makeRenderedPanelVisibleLayerTracker, VisibleRenderLayerTracker} from 'neuroglancer/layer';
import {PickIDManager} from 'neuroglancer/object_picking';
import {clearOutOfBoundsPickData, FramePickingData, pickDiameter, pickOffsetSequence, pickRadius, RenderedDataPanel, RenderedDataViewerState} from 'neuroglancer/rendered_data_panel';
import {SliceView, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {SliceViewPanelReadyRenderContext, SliceViewPanelRenderContext, SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {ActionEvent, registerActionListener} from 'neuroglancer/util/event_action_map';
import {disableZProjection, identityMat4, kAxes, mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {TouchRotateInfo} from 'neuroglancer/util/touch_bindings';
import {FramebufferConfiguration, OffscreenCopyHelper, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {MultipleScaleBarTextures, TrackableScaleBarOptions} from 'neuroglancer/widget/scale_bar';

export interface SliceViewerState extends RenderedDataViewerState {
  showScaleBar: TrackableBoolean;
  wireFrame: TrackableBoolean;
  scaleBarOptions: TrackableScaleBarOptions;
  crossSectionBackgroundColor: TrackableRGB;
}

export enum OffscreenTextures {
  COLOR,
  PICK,
  NUM_TEXTURES
}

function sliceViewPanelEmitColorAndPickID(builder: ShaderBuilder) {
  builder.addOutputBuffer('vec4', 'out_fragColor', 0);
  builder.addOutputBuffer('highp vec4', 'out_pickId', 1);
  builder.addFragmentCode(`
void emit(vec4 color, highp uint pickId) {
  out_fragColor = color;
  float pickIdFloat = float(pickId);
  out_pickId = vec4(pickIdFloat, pickIdFloat, pickIdFloat, 1.0);
}
`);
}


function sliceViewPanelEmitColor(builder: ShaderBuilder) {
  builder.addOutputBuffer('vec4', 'out_fragColor', null);
  builder.addFragmentCode(`
void emit(vec4 color, highp uint pickId) {
  out_fragColor = color;
}
`);
}

const tempVec3 = vec3.create();
const tempVec3b = vec3.create();
const tempVec4 = vec4.create();

export class SliceViewPanel extends RenderedDataPanel {
  viewer: SliceViewerState;

  private axesLineHelper = this.registerDisposer(AxesLineHelper.get(this.gl));
  private sliceViewRenderHelper =
      this.registerDisposer(SliceViewRenderHelper.get(this.gl, sliceViewPanelEmitColor));
  private colorFactor = vec4.fromValues(1, 1, 1, 1);
  private pickIDs = new PickIDManager();

  flushBackendProjectionParameters() {
    this.sliceView.flushBackendProjectionParameters();
  }

  private visibleLayerTracker: VisibleRenderLayerTracker<SliceViewPanel, SliceViewPanelRenderLayer>;

  get displayDimensionRenderInfo() {
    return this.navigationState.displayDimensionRenderInfo;
  }

  // FIXME: use separate backend object for the panel
  get rpc() {
    return this.sliceView.rpc!;
  }
  get rpcId() {
    return this.sliceView.rpcId!;
  }

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
  private scaleBars = this.registerDisposer(new MultipleScaleBarTextures(this.gl));

  get navigationState() {
    return this.sliceView.navigationState;
  }

  constructor(
      context: Borrowed<DisplayContext>, element: HTMLElement, public sliceView: Owned<SliceView>,
      viewer: SliceViewerState) {
    super(context, element, viewer);
    viewer.wireFrame.changed.add(() => this.scheduleRedraw());
    registerActionListener(element, 'rotate-via-mouse-drag', (e: ActionEvent<MouseEvent>) => {
      const {mouseState} = this.viewer;
      if (mouseState.updateUnconditionally()) {
        const initialPosition = Float32Array.from(mouseState.position);
        startRelativeMouseDrag(e.detail, (_event, deltaX, deltaY) => {
          const {pose} = this.navigationState;
          const xAxis = vec3.transformQuat(tempVec3, kAxes[0], pose.orientation.orientation);
          const yAxis = vec3.transformQuat(tempVec3b, kAxes[1], pose.orientation.orientation);
          this.viewer.navigationState.pose.rotateAbsolute(
              yAxis, -deltaX / 4.0 * Math.PI / 180.0, initialPosition);
          this.viewer.navigationState.pose.rotateAbsolute(
              xAxis, -deltaY / 4.0 * Math.PI / 180.0, initialPosition);
        });
      }
    });

    registerActionListener(
        element, 'rotate-in-plane-via-touchrotate', (e: ActionEvent<TouchRotateInfo>) => {
          const {detail} = e;
          const {mouseState} = this.viewer;
          this.handleMouseMove(detail.centerX, detail.centerY);
          if (mouseState.updateUnconditionally()) {
            this.navigationState.pose.rotateAbsolute(
                this.sliceView.projectionParameters.value.viewportNormalInCanonicalCoordinates,
                detail.angle - detail.prevAngle, mouseState.position);
          }
        });

    this.registerDisposer(sliceView);
    // Create visible layer tracker after registering SliceView, to ensure it is destroyed before
    // SliceView backend is destroyed.
    this.visibleLayerTracker = makeRenderedPanelVisibleLayerTracker(
        this.viewer.layerManager, SliceViewPanelRenderLayer, this.viewer.visibleLayerRoles, this);

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
    const {pose} = this.viewer.navigationState;
    pose.updateDisplayPosition(pos => {
      vec3.set(pos, -deltaX, -deltaY, 0);
      vec3.transformMat4(pos, pos, this.sliceView.projectionParameters.value.invViewMatrix);
    });
  }

  translateDataPointByViewportPixels(out: vec3, orig: vec3, deltaX: number, deltaY: number): vec3 {
    const projectionParameters = this.sliceView.projectionParameters.value;
    vec3.transformMat4(out, orig, projectionParameters.viewMatrix);
    vec3.set(out, out[0] + deltaX, out[1] + deltaY, out[2]);
    vec3.transformMat4(out, out, projectionParameters.invViewMatrix);
    return out;
  }

  isReady() {
    if (!this.visible) {
      return false;
    }

    const {sliceView} = this;

    this.ensureBoundsUpdated();

    if (!sliceView.isReady()) {
      return false;
    }

    const renderContext: SliceViewPanelReadyRenderContext = {
      projectionParameters: sliceView.projectionParameters.value,
      sliceView,
    };

    for (const [renderLayer, attachment] of this.visibleLayerTracker.visibleLayers) {
      if (!renderLayer.isReady(renderContext, attachment)) {
        return false;
      }
    }
    return true;
  }

  drawWithPicking(pickingData: FramePickingData): boolean {
    const {sliceView} = this;
    if (!sliceView.valid) {
      return false;
    }
    sliceView.updateRendering();
    const projectionParameters = sliceView.projectionParameters.value;
    const {width, height, invViewProjectionMat} = projectionParameters;
    mat4.copy(pickingData.invTransform, invViewProjectionMat);
    const {gl} = this;

    this.offscreenFramebuffer.bind(width, height);
    gl.disable(WebGL2RenderingContext.SCISSOR_TEST);
    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);

    const backgroundColor = tempVec4;
    const crossSectionBackgroundColor = this.viewer.crossSectionBackgroundColor.value;
    backgroundColor[0] = crossSectionBackgroundColor[0];
    backgroundColor[1] = crossSectionBackgroundColor[1];
    backgroundColor[2] = crossSectionBackgroundColor[2];
    backgroundColor[3] = 1;

    this.offscreenFramebuffer.bindSingle(OffscreenTextures.COLOR);
    this.sliceViewRenderHelper.draw(
        sliceView.offscreenFramebuffer.colorBuffers[0].texture, identityMat4, this.colorFactor,
        backgroundColor, 0, 0, 1, 1);

    const {visibleLayers} = this.visibleLayerTracker;
    let {pickIDs} = this;
    pickIDs.clear();

    const renderContext: SliceViewPanelRenderContext = {
      wireFrame: this.viewer.wireFrame.value,
      projectionParameters,
      pickIDs: pickIDs,
      emitter: sliceViewPanelEmitColorAndPickID,
      emitColor: true,
      emitPickID: true,
      sliceView,
    };
    this.offscreenFramebuffer.bind(width, height);
    gl.enable(WebGL2RenderingContext.BLEND);
    gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
    for (const [renderLayer, attachment] of visibleLayers) {
      renderLayer.draw(renderContext, attachment);
    }
    gl.disable(WebGL2RenderingContext.BLEND);
    if (this.viewer.showAxisLines.value || this.viewer.showScaleBar.value) {
      this.offscreenFramebuffer.bindSingle(OffscreenTextures.COLOR);
      if (this.viewer.showAxisLines.value) {
        const axisLength =
            Math.min(projectionParameters.logicalWidth, projectionParameters.logicalHeight) / 4 *
            1.5;
        const {
          zoomFactor: {value: zoom},
        } = this.viewer.navigationState;
        this.axesLineHelper.draw(
            disableZProjection(computeAxisLineMatrix(projectionParameters, axisLength * zoom)));
      }
      if (this.viewer.showScaleBar.value) {
        gl.enable(WebGL2RenderingContext.BLEND);
        gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
        this.scaleBars.draw(
            projectionParameters, this.navigationState.displayDimensionRenderInfo.value,
            this.navigationState.relativeDisplayScales.value, this.navigationState.zoomFactor.value,
            this.viewer.scaleBarOptions.value);
        gl.disable(WebGL2RenderingContext.BLEND);
      }
    }

    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLClippedViewport();
    this.offscreenCopyHelper.draw(
        this.offscreenFramebuffer.colorBuffers[OffscreenTextures.COLOR].texture);
    return true;
  }

  ensureBoundsUpdated() {
    super.ensureBoundsUpdated();
    this.sliceView.projectionParameters.setViewport(this.renderViewport);
  }

  issuePickRequest(glWindowX: number, glWindowY: number) {
    const {offscreenFramebuffer} = this;
    offscreenFramebuffer.readPixelFloat32IntoBuffer(
        OffscreenTextures.PICK, glWindowX - pickRadius, glWindowY - pickRadius, 0, pickDiameter,
        pickDiameter);
  }

  completePickRequest(
      glWindowX: number, glWindowY: number, data: Float32Array, pickingData: FramePickingData) {
    const {mouseState} = this.viewer;
    mouseState.pickedRenderLayer = null;
    clearOutOfBoundsPickData(
        data, 0, 4, glWindowX, glWindowY, pickingData.viewportWidth, pickingData.viewportHeight);
    const {viewportWidth, viewportHeight} = pickingData;
    const numOffsets = pickOffsetSequence.length;
    const {value: voxelCoordinates} = this.navigationState.position;
    const rank = voxelCoordinates.length;
    const displayDimensions = this.navigationState.pose.displayDimensions.value;
    const {displayRank, displayDimensionIndices} = displayDimensions;

    const setPosition = (xOffset: number, yOffset: number, position: Float32Array) => {
      const x = glWindowX + xOffset;
      const y = glWindowY + yOffset;
      tempVec3[0] = 2.0 * x / viewportWidth - 1.0;
      tempVec3[1] = 2.0 * y / viewportHeight - 1.0;
      tempVec3[2] = 0;
      vec3.transformMat4(tempVec3, tempVec3, pickingData.invTransform);
      position.set(voxelCoordinates);
      for (let i = 0; i < displayRank; ++i) {
        position[displayDimensionIndices[i]] = tempVec3[i];
      }
    };

    let {unsnappedPosition} = mouseState;
    if (unsnappedPosition.length !== rank) {
      unsnappedPosition = mouseState.unsnappedPosition = new Float32Array(rank);
    }
    mouseState.coordinateSpace = this.navigationState.coordinateSpace.value;
    mouseState.displayDimensions = displayDimensions;

    setPosition(0, 0, unsnappedPosition);

    const setStateFromRelative = (relativeX: number, relativeY: number, pickId: number) => {
      let {position: mousePosition} = mouseState;
      if (mousePosition.length !== rank) {
        mousePosition = mouseState.position = new Float32Array(rank);
      }
      setPosition(relativeX - pickRadius, relativeY - pickRadius, mousePosition);
      this.pickIDs.setMouseState(mouseState, pickId);
      mouseState.setActive(true);
    };
    for (let i = 0; i < numOffsets; ++i) {
      const offset = pickOffsetSequence[i];
      const pickId = data[4 * i];
      if (pickId === 0) continue;
      const relativeX = offset % pickDiameter;
      const relativeY = (offset - relativeX) / pickDiameter;
      setStateFromRelative(relativeX, relativeY, pickId);
      return;
    }
    setStateFromRelative(pickRadius, pickRadius, 0);
  }

  /**
   * Zooms by the specified factor, maintaining the data position that projects to the current mouse
   * position.
   */
  zoomByMouse(factor: number) {
    const {navigationState} = this;
    if (!navigationState.valid) {
      return;
    }
    const {sliceView} = this;
    const {
      width,
      height,
      invViewMatrix,
      displayDimensionRenderInfo: {displayDimensionIndices, displayRank}
    } = sliceView.projectionParameters.value;
    let {mouseX, mouseY} = this;
    mouseX -= width / 2;
    mouseY -= height / 2;
    // Desired invariance:
    //
    // invViewMatrixLinear * [mouseX, mouseY, 0]^T + [oldX, oldY, oldZ]^T =
    // invViewMatrixLinear * factor * [mouseX, mouseY, 0]^T + [newX, newY, newZ]^T

    const position = this.navigationState.position.value;
    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      const f = invViewMatrix[i] * mouseX + invViewMatrix[4 + i] * mouseY;
      position[dim] += f * (1 - factor);
    }
    this.navigationState.position.changed.dispatch();
    navigationState.zoomBy(factor);
  }
}
