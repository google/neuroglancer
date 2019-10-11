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

import 'neuroglancer/noselect.css';
import './panel.css';

import throttle from 'lodash/throttle';
import {AxesLineHelper} from 'neuroglancer/axes_lines';
import {DisplayContext} from 'neuroglancer/display_context';
import {makeRenderedPanelVisibleLayerTracker, VisibleRenderLayerTracker} from 'neuroglancer/layer';
import {DisplayDimensions} from 'neuroglancer/navigation_state';
import {PERSPECTIVE_VIEW_ADD_LAYER_RPC_ID, PERSPECTIVE_VIEW_REMOVE_LAYER_RPC_ID, PERSPECTIVE_VIEW_RPC_ID, PERSPECTIVE_VIEW_UPDATE_VIEWPORT_RPC_ID} from 'neuroglancer/perspective_view/base';
import {PerspectiveViewReadyRenderContext, PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {clearOutOfBoundsPickData, FramePickingData, pickDiameter, pickOffsetSequence, pickRadius, RenderedDataPanel, RenderedDataViewerState} from 'neuroglancer/rendered_data_panel';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {SliceView, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {TrackableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Owned} from 'neuroglancer/util/disposable';
import {ActionEvent, registerActionListener} from 'neuroglancer/util/event_action_map';
import {kAxes, mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {TouchRotateInfo, TouchTranslateInfo} from 'neuroglancer/util/touch_bindings';
import {WatchableMap} from 'neuroglancer/util/watchable_map';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {DepthBuffer, FramebufferConfiguration, makeTextureBuffers, OffscreenCopyHelper, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {MultipleScaleBarTextures, ScaleBarOptions} from 'neuroglancer/widget/scale_bar';
import {RPC, SharedObject} from 'neuroglancer/worker_rpc';

export interface PerspectiveViewerState extends RenderedDataViewerState {
  orthographicProjection: TrackableBoolean;
  showSliceViews: TrackableBoolean;
  showScaleBar: TrackableBoolean;
  scaleBarOptions: TrackableValue<ScaleBarOptions>;
  showSliceViewsCheckbox?: boolean;
  crossSectionBackgroundColor: TrackableRGB;
  perspectiveViewBackgroundColor: TrackableRGB;
  rpc: RPC;
}

export enum OffscreenTextures {
  COLOR,
  Z,
  PICK,
  NUM_TEXTURES
}

export const glsl_perspectivePanelEmit = `
void emit(vec4 color, highp uint pickId) {
  out_color = color;
  out_z = 1.0 - gl_FragCoord.z;
  out_pickId = float(pickId);
}
`;

/**
 * http://jcgt.org/published/0002/02/09/paper.pdf
 * http://casual-effects.blogspot.com/2015/03/implemented-weighted-blended-order.html
 */
export const glsl_computeOITWeight = `
float computeOITWeight(float alpha) {
  float a = min(1.0, alpha) * 8.0 + 0.01;
  float b = -gl_FragCoord.z * 0.95 + 1.0;
  return a * a * a * b * b * b;
}
`;

// Color must be premultiplied by alpha.
export const glsl_perspectivePanelEmitOIT = [
  glsl_computeOITWeight, `
void emit(vec4 color, highp uint pickId) {
  float weight = computeOITWeight(color.a);
  vec4 accum = color * weight;
  v4f_fragData0 = vec4(accum.rgb, color.a);
  v4f_fragData1 = vec4(accum.a, 0.0, 0.0, 0.0);
}
`
];

export function perspectivePanelEmit(builder: ShaderBuilder) {
  builder.addOutputBuffer('vec4', `out_color`, OffscreenTextures.COLOR);
  builder.addOutputBuffer('highp float', `out_z`, OffscreenTextures.Z);
  builder.addOutputBuffer('highp float', `out_pickId`, OffscreenTextures.PICK);
  builder.addFragmentCode(glsl_perspectivePanelEmit);
}

export function perspectivePanelEmitOIT(builder: ShaderBuilder) {
  builder.addOutputBuffer('vec4', 'v4f_fragData0', 0);
  builder.addOutputBuffer('vec4', 'v4f_fragData1', 1);
  builder.addFragmentCode(glsl_perspectivePanelEmitOIT);
}

const tempVec3 = vec3.create();
const tempVec4 = vec4.create();
const tempMat4 = mat4.create();

function defineTransparencyCopyShader(builder: ShaderBuilder) {
  builder.addOutputBuffer('vec4', 'v4f_fragColor', null);
  builder.setFragmentMain(`
vec4 v0 = getValue0();
vec4 v1 = getValue1();
vec4 accum = vec4(v0.rgb, v1.r);
float revealage = v0.a;

v4f_fragColor = vec4(accum.rgb / accum.a, revealage);
`);
}

const PerspectiveViewStateBase = withSharedVisibility(SharedObject);
class PerspectiveViewState extends PerspectiveViewStateBase {
  constructor(public displayDimensions: WatchableValueInterface<DisplayDimensions>) {
    super();
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.displayDimensions =
        this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, this.displayDimensions))
            .rpcId;
    super.initializeCounterpart(rpc, options);
  }
}

export class PerspectivePanel extends RenderedDataPanel {
  viewer: PerspectiveViewerState;

  protected visibleLayerTracker: Owned<VisibleRenderLayerTracker<PerspectiveViewRenderLayer>>;

  /**
   * If boolean value is true, sliceView is shown unconditionally, regardless of the value of
   * this.viewer.showSliceViews.value.
   */
  sliceViews = (() => {
    const sliceViewDisposers = new Map<SliceView, () => void>();
    return this.registerDisposer(new WatchableMap<SliceView, boolean>(
        (_unconditional, sliceView) => {
          const disposer = sliceView.visibility.add(this.visibility);
          sliceViewDisposers.set(sliceView, disposer);
          this.scheduleRedraw();
        },
        (_unconditional, sliceView) => {
          const disposer = sliceViewDisposers.get(sliceView)!;
          sliceViewDisposers.delete(sliceView);
          disposer();
          sliceView.dispose();
          this.scheduleRedraw();
        }));
  })();

  /**
   * Transform from camera space to OpenGL clip space.
   */
  projectionMat = mat4.create();

  /**
   * Transform from world space to camera space.
   */
  viewMat = mat4.create();

  /**
   * Inverse of `viewMat`.
   */
  viewMatInverse = mat4.create();

  /**
   * Transform from world space to OpenGL clip space.  Equal to `projectionMat * viewMat`.
   */
  viewProjectionMat = mat4.create();

  /**
   * Inverse of `viewProjectionMat`.
   */
  viewProjectionMatInverse = mat4.create();

  /**
   * Width of panel viewport in pixels.
   */
  width = 0;

  /**
   * Height of panel viewport in pixels.
   */
  height = 0;

  private axesLineHelper = this.registerDisposer(AxesLineHelper.get(this.gl));
  sliceViewRenderHelper =
      this.registerDisposer(SliceViewRenderHelper.get(this.gl, perspectivePanelEmit));

  protected offscreenFramebuffer = this.registerDisposer(new FramebufferConfiguration(this.gl, {
    colorBuffers: [
      new TextureBuffer(
          this.gl, WebGL2RenderingContext.RGBA8, WebGL2RenderingContext.RGBA,
          WebGL2RenderingContext.UNSIGNED_BYTE),
      new TextureBuffer(
          this.gl, WebGL2RenderingContext.R32F, WebGL2RenderingContext.RED,
          WebGL2RenderingContext.FLOAT),
      new TextureBuffer(
          this.gl, WebGL2RenderingContext.R32F, WebGL2RenderingContext.RED,
          WebGL2RenderingContext.FLOAT),
    ],
    depthBuffer: new DepthBuffer(this.gl)
  }));

  protected transparentConfiguration_: FramebufferConfiguration<TextureBuffer>|undefined;

  protected offscreenCopyHelper = this.registerDisposer(OffscreenCopyHelper.get(this.gl));
  protected transparencyCopyHelper =
      this.registerDisposer(OffscreenCopyHelper.get(this.gl, defineTransparencyCopyShader, 2));

  private sharedObject: PerspectiveViewState;

  private scaleBars = this.registerDisposer(new MultipleScaleBarTextures(this.gl));

  constructor(context: DisplayContext, element: HTMLElement, viewer: PerspectiveViewerState) {
    super(context, element, viewer);
    this.registerDisposer(this.navigationState.changed.add(() => {
      this.throttledSendViewportUpdate();
      this.context.scheduleRedraw();
    }));

    const sharedObject = this.sharedObject =
        this.registerDisposer(new PerspectiveViewState(this.navigationState.pose.displayDimensions));
    sharedObject.RPC_TYPE_ID = PERSPECTIVE_VIEW_RPC_ID;
    sharedObject.initializeCounterpart(viewer.rpc, {});
    sharedObject.visibility.add(this.visibility);

    this.visibleLayerTracker = makeRenderedPanelVisibleLayerTracker(
        this.viewer.layerManager, PerspectiveViewRenderLayer, this.viewer.visibleLayerRoles, this,
        (layer, info) => {
          const {backend} = layer;
          if (backend) {
            backend.rpc!.invoke(
                PERSPECTIVE_VIEW_ADD_LAYER_RPC_ID,
                {layer: backend.rpcId, view: this.sharedObject.rpcId});
            info.registerDisposer(
                () => backend.rpc!.invoke(
                    PERSPECTIVE_VIEW_REMOVE_LAYER_RPC_ID,
                    {layer: backend.rpcId, view: this.sharedObject.rpcId}));
          }
        });

    registerActionListener(element, 'rotate-via-mouse-drag', (e: ActionEvent<MouseEvent>) => {
      startRelativeMouseDrag(e.detail, (_event, deltaX, deltaY) => {
        this.navigationState.pose.rotateRelative(kAxes[1], deltaX / 4.0 * Math.PI / 180.0);
        this.navigationState.pose.rotateRelative(kAxes[0], -deltaY / 4.0 * Math.PI / 180.0);
      });
    });

    registerActionListener(
        element, 'rotate-in-plane-via-touchrotate', (e: ActionEvent<TouchRotateInfo>) => {
          const {detail} = e;
          this.navigationState.pose.rotateRelative(kAxes[2], detail.angle - detail.prevAngle);
        });

    registerActionListener(
        element, 'rotate-out-of-plane-via-touchtranslate', (e: ActionEvent<TouchTranslateInfo>) => {
          const {detail} = e;
          this.navigationState.pose.rotateRelative(kAxes[1], detail.deltaX / 4.0 * Math.PI / 180.0);
          this.navigationState.pose.rotateRelative(
              kAxes[0], -detail.deltaY / 4.0 * Math.PI / 180.0);
        });

    if (viewer.showSliceViewsCheckbox) {
      let showSliceViewsCheckbox =
          this.registerDisposer(new TrackableBooleanCheckbox(viewer.showSliceViews));
      showSliceViewsCheckbox.element.className =
          'perspective-panel-show-slice-views neuroglancer-noselect';
      let showSliceViewsLabel = document.createElement('label');
      showSliceViewsLabel.className = 'perspective-panel-show-slice-views neuroglancer-noselect';
      showSliceViewsLabel.appendChild(document.createTextNode('Sections'));
      showSliceViewsLabel.appendChild(showSliceViewsCheckbox.element);
      this.element.appendChild(showSliceViewsLabel);
    }
    this.registerDisposer(viewer.orthographicProjection.changed.add(() => this.scheduleRedraw()));
    this.registerDisposer(viewer.showScaleBar.changed.add(() => this.scheduleRedraw()));
    this.registerDisposer(viewer.scaleBarOptions.changed.add(() => this.scheduleRedraw()));
    this.registerDisposer(viewer.showSliceViews.changed.add(() => this.scheduleRedraw()));
    this.registerDisposer(viewer.showAxisLines.changed.add(() => this.scheduleRedraw()));
    this.registerDisposer(
        viewer.crossSectionBackgroundColor.changed.add(() => this.scheduleRedraw()));
    this.registerDisposer(
        viewer.perspectiveViewBackgroundColor.changed.add(() => this.scheduleRedraw()));
    this.throttledSendViewportUpdate();
    this.throttledSendViewportUpdate.flush();
  }

  translateByViewportPixels(deltaX: number, deltaY: number): void {
    const temp = tempVec3;
    const {viewProjectionMat} = this;
    const {width, height} = this;
    const {pose} = this.viewer.navigationState;
    pose.updateDisplayPosition(pos => {
      vec3.transformMat4(temp, pos, viewProjectionMat);
      temp[0] = -2 * deltaX / width;
      temp[1] = 2 * deltaY / height;
      vec3.transformMat4(pos, temp, this.viewProjectionMatInverse);
    });
  }

  get navigationState() {
    return this.viewer.navigationState;
  }

  isReady() {
    if (!this.visible) {
      return true;
    }
    for (const [sliceView, unconditional] of this.sliceViews) {
      if (unconditional || this.viewer.showSliceViews.value) {
        if (!sliceView.isReady()) {
          return false;
        }
      }
    }
    this.checkForResize();
    const {width, height} = this;
    if (width === 0 || height === 0) {
      return true;
    }
    const {viewProjectionMat} = this;
    this.updateProjectionMatrix();

    const {
      navigationState:
          {pose: {displayDimensions: {value: displayDimensions}, position: {value: globalPosition}}}
    } = this;

    const renderContext: PerspectiveViewReadyRenderContext = {
      viewportWidth: width,
      viewportHeight: height,
      viewProjectionMat: viewProjectionMat,
      globalPosition,
      displayDimensions,
    };

    const {visibleLayers} = this.visibleLayerTracker;
    for (const [renderLayer, attachment] of visibleLayers) {
      if (!renderLayer.isReady(renderContext, attachment)) {
        return false;
      }
    }
    return true;
  }

  updateProjectionMatrix() {
    const {projectionMat, viewProjectionMat} = this;
    const widthOverHeight = this.width / this.height;
    const fovy = Math.PI / 4.0;
    const nearBound = 0.1, farBound = 50;
    const {navigationState} = this;
    const baseZoomFactor = navigationState.zoomFactor.value;
    let zoomFactor = baseZoomFactor / 2;
    if (this.viewer.orthographicProjection.value) {
      // Pick orthographic projection to match perspective projection at plane parallel to image
      // plane containing the center position.
      mat4.ortho(projectionMat, -widthOverHeight, widthOverHeight, -1, 1, nearBound, farBound);
    } else {
      const f = 1.0 / Math.tan(fovy / 2);
      mat4.perspective(projectionMat, fovy, widthOverHeight, nearBound, farBound);
      zoomFactor *= f;
    }
    const {viewMatInverse, viewMat} = this;
    navigationState.pose.toMat4(viewMatInverse, zoomFactor);
    mat4.scale(viewMatInverse, viewMatInverse, vec3.set(tempVec3, 1, -1, -1));
    mat4.translate(viewMatInverse, viewMatInverse, kAxes[2]);
    mat4.invert(viewMat, viewMatInverse);
    mat4.multiply(viewProjectionMat, projectionMat, viewMat);
    mat4.invert(this.viewProjectionMatInverse, viewProjectionMat);
  }

  private throttledSendViewportUpdate = this.registerCancellable(throttle(() => {
    const {sharedObject} = this;
    const {valid} = this.navigationState;
    if (valid) {
      this.updateProjectionMatrix();
    }
    sharedObject.rpc!.invoke(PERSPECTIVE_VIEW_UPDATE_VIEWPORT_RPC_ID, {
      view: sharedObject.rpcId,
      viewport: {
        width: valid ? this.width : 0,
        height: valid ? this.height : 0,
        viewMat: this.viewMat,
        projectionMat: this.projectionMat,
        viewProjectionMat: this.viewProjectionMat,
      },
    });
  }, 10));

  panelSizeChanged() {
    this.throttledSendViewportUpdate();
  }

  disposed() {
    for (let sliceView of this.sliceViews.keys()) {
      sliceView.dispose();
    }
    this.sliceViews.clear();
    super.disposed();
  }

  issuePickRequest(glWindowX: number, glWindowY: number) {
    const {offscreenFramebuffer} = this;
    offscreenFramebuffer.readPixelFloat32IntoBuffer(
        OffscreenTextures.Z, glWindowX - pickRadius, glWindowY - pickRadius, 0, pickDiameter,
        pickDiameter);
    offscreenFramebuffer.readPixelFloat32IntoBuffer(
        OffscreenTextures.PICK, glWindowX - pickRadius, glWindowY - pickRadius,
        4 * 4 * pickDiameter * pickDiameter, pickDiameter, pickDiameter);
  }

  completePickRequest(
      glWindowX: number, glWindowY: number, data: Float32Array, pickingData: FramePickingData) {
    const {mouseState} = this.viewer;
    mouseState.pickedRenderLayer = null;
    clearOutOfBoundsPickData(
        data, 0, 4, glWindowX, glWindowY, pickingData.viewportWidth, pickingData.viewportHeight);
    const numOffsets = pickOffsetSequence.length;
    for (let i = 0; i < numOffsets; ++i) {
      const offset = pickOffsetSequence[i];
      let zValue = data[4 * offset];
      if (zValue === 0) continue;
      const relativeX = offset % pickDiameter;
      const relativeY = (offset - relativeX) / pickDiameter;
      let glWindowZ = 1.0 - zValue;
      tempVec3[0] = 2.0 * (glWindowX + relativeX - pickRadius) / pickingData.viewportWidth - 1.0;
      tempVec3[1] = 2.0 * (glWindowY + relativeY - pickRadius) / pickingData.viewportHeight - 1.0;
      tempVec3[2] = 2.0 * glWindowZ - 1.0;
      vec3.transformMat4(tempVec3, tempVec3, pickingData.invTransform);
      let {position: mousePosition} = mouseState;
      const {value: voxelCoordinates} = this.navigationState.position;
      const rank = voxelCoordinates.length;
      if (mousePosition.length !== rank) {
        mousePosition = mouseState.position = new Float32Array(rank);
      }
      mousePosition.set(voxelCoordinates);
      const displayDimensions = this.navigationState.pose.displayDimensions.value;
      const {dimensionIndices} = displayDimensions;
      for (let i = 0, spatialRank = dimensionIndices.length; i < spatialRank; ++i) {
        mousePosition[dimensionIndices[i]] = tempVec3[i];
      }
      const pickValue = data[4 * pickDiameter * pickDiameter + 4 * offset];
      pickingData.pickIDs.setMouseState(mouseState, pickValue);
      mouseState.displayDimensions = displayDimensions;
      mouseState.setActive(true);
      return;
    }
    mouseState.setActive(false);
  }

  translateDataPointByViewportPixels(out: vec3, orig: vec3, deltaX: number, deltaY: number): vec3 {
    const temp = tempVec3;
    const {viewProjectionMat} = this;
    const {width, height} = this;
    vec3.transformMat4(temp, orig, viewProjectionMat);
    temp[0] += 2 * deltaX / width;
    temp[1] += -2 * deltaY / height;
    return vec3.transformMat4(out, temp, this.viewProjectionMatInverse);
  }

  private get transparentConfiguration() {
    let transparentConfiguration = this.transparentConfiguration_;
    if (transparentConfiguration === undefined) {
      transparentConfiguration = this.transparentConfiguration_ =
          this.registerDisposer(new FramebufferConfiguration(this.gl, {
            colorBuffers:
                makeTextureBuffers(this.gl, 2, this.gl.RGBA32F, this.gl.RGBA, this.gl.FLOAT),
            depthBuffer: this.offscreenFramebuffer.depthBuffer!.addRef(),
          }));
    }
    return transparentConfiguration;
  }

  drawWithPicking(pickingData: FramePickingData): boolean {
    if (!this.navigationState.valid) {
      return false;
    }
    const {width, height} = this;

    const showSliceViews = this.viewer.showSliceViews.value;
    for (const [sliceView, unconditional] of this.sliceViews) {
      if (unconditional || showSliceViews) {
        sliceView.updateRendering();
      }
    }

    let gl = this.gl;
    this.offscreenFramebuffer.bind(width, height);

    gl.disable(gl.SCISSOR_TEST);
    const backgroundColor = this.viewer.perspectiveViewBackgroundColor.value;
    this.gl.clearColor(backgroundColor[0], backgroundColor[1], backgroundColor[2], 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    let {viewProjectionMat} = this;
    this.updateProjectionMatrix();

    // FIXME; avoid temporaries
    let lightingDirection = vec3.create();
    vec3.transformQuat(
        lightingDirection, kAxes[2], this.navigationState.pose.orientation.orientation);
    vec3.scale(lightingDirection, lightingDirection, -1);

    let ambient = 0.2;
    let directional = 1 - ambient;

    const {
      navigationState:
          {pose: {displayDimensions: {value: displayDimensions}, position: {value: globalPosition}}}
    } = this;

    const renderContext: PerspectiveViewRenderContext = {
      viewProjectionMat: viewProjectionMat,
      lightDirection: lightingDirection,
      ambientLighting: ambient,
      directionalLighting: directional,
      pickIDs: pickingData.pickIDs,
      emitter: perspectivePanelEmit,
      emitColor: true,
      emitPickID: true,
      alreadyEmittedPickID: false,
      viewportWidth: width,
      viewportHeight: height,
      displayDimensions,
      globalPosition,
    };

    mat4.copy(pickingData.invTransform, this.viewProjectionMatInverse);

    const {visibleLayers} = this.visibleLayerTracker;

    let hasTransparent = false;

    let hasAnnotation = false;

    // Draw fully-opaque layers first.
    for (const [renderLayer, attachment] of visibleLayers) {
      if (!renderLayer.isTransparent) {
        if (!renderLayer.isAnnotation) {
          renderLayer.draw(renderContext, attachment);
        } else {
          hasAnnotation = true;
        }
      } else {
        hasTransparent = true;
      }
    }
    this.drawSliceViews(renderContext);

    if (hasAnnotation) {
      gl.enable(WebGL2RenderingContext.BLEND);
      gl.depthFunc(WebGL2RenderingContext.LEQUAL);
      gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
      // Render only to the color buffer, but not the pick or z buffer.  With blending enabled, the
      // z and color values would be corrupted.
      gl.drawBuffers([
        gl.COLOR_ATTACHMENT0,
        gl.NONE,
        gl.NONE,
      ]);
      renderContext.emitPickID = false;

      for (const [renderLayer, attachment] of visibleLayers) {
        if (renderLayer.isAnnotation) {
          renderLayer.draw(renderContext, attachment);
        }
      }
      gl.depthFunc(WebGL2RenderingContext.LESS);
      gl.disable(WebGL2RenderingContext.BLEND);
      gl.drawBuffers([
        gl.COLOR_ATTACHMENT0,
        gl.COLOR_ATTACHMENT1,
        gl.COLOR_ATTACHMENT2,
      ]);
      renderContext.emitPickID = true;
    }

    if (this.viewer.showAxisLines.value) {
      this.drawAxisLines();
    }

    if (hasTransparent) {
      // Draw transparent objects.
      gl.depthMask(false);
      gl.enable(WebGL2RenderingContext.BLEND);

      // Compute accumulate and revealage textures.
      const {transparentConfiguration} = this;
      transparentConfiguration.bind(width, height);
      this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
      renderContext.emitter = perspectivePanelEmitOIT;
      gl.blendFuncSeparate(
          WebGL2RenderingContext.ONE, WebGL2RenderingContext.ONE, WebGL2RenderingContext.ZERO,
          WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
      renderContext.emitPickID = false;
      for (const [renderLayer, attachment] of visibleLayers) {
        if (renderLayer.isTransparent) {
          renderLayer.draw(renderContext, attachment);
        }
      }

      // Copy transparent rendering result back to primary buffer.
      gl.disable(WebGL2RenderingContext.DEPTH_TEST);
      this.offscreenFramebuffer.bindSingle(OffscreenTextures.COLOR);
      gl.blendFunc(WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA, WebGL2RenderingContext.SRC_ALPHA);
      this.transparencyCopyHelper.draw(
          transparentConfiguration.colorBuffers[0].texture,
          transparentConfiguration.colorBuffers[1].texture);

      gl.depthMask(true);
      gl.disable(WebGL2RenderingContext.BLEND);
      gl.enable(WebGL2RenderingContext.DEPTH_TEST);

      // Restore framebuffer attachments.
      this.offscreenFramebuffer.bind(width, height);
    }

    // Do picking only rendering pass.
    gl.drawBuffers([gl.NONE, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    renderContext.emitter = perspectivePanelEmit;
    renderContext.emitPickID = true;
    renderContext.emitColor = false;

    // Offset z values forward so that we reliably write pick IDs and depth information even though
    // we've already done one drawing pass.
    gl.enable(WebGL2RenderingContext.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    for (const [renderLayer, attachment] of visibleLayers) {
      renderContext.alreadyEmittedPickID = !renderLayer.isTransparent && !renderLayer.isAnnotation;
      renderLayer.draw(renderContext, attachment);
    }
    gl.disable(WebGL2RenderingContext.POLYGON_OFFSET_FILL);

    if (this.viewer.showScaleBar.value && this.viewer.orthographicProjection.value) {
      // Only modify color buffer.
      gl.drawBuffers([
        gl.COLOR_ATTACHMENT0,
      ]);

      gl.disable(WebGL2RenderingContext.DEPTH_TEST);
      gl.enable(WebGL2RenderingContext.BLEND);
      gl.blendFunc(WebGL2RenderingContext.SRC_ALPHA, WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA);
      const {scaleBars} = this;
      const options = this.viewer.scaleBarOptions.value;
      scaleBars.draw(
          width, this.navigationState.pose.displayDimensions.value,
          this.navigationState.zoomFactor.value / this.height, options);
      gl.disable(WebGL2RenderingContext.BLEND);
    }
    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLViewport();
    this.offscreenCopyHelper.draw(
        this.offscreenFramebuffer.colorBuffers[OffscreenTextures.COLOR].texture);
    return true;
  }

  protected drawSliceViews(renderContext: PerspectiveViewRenderContext) {
    let {sliceViewRenderHelper} = this;
    let {lightDirection, ambientLighting, directionalLighting, viewProjectionMat} = renderContext;

    const showSliceViews = this.viewer.showSliceViews.value;
    for (const [sliceView, unconditional] of this.sliceViews) {
      if (!unconditional && !showSliceViews) {
        continue;
      }
      if (sliceView.width === 0 || sliceView.height === 0 || !sliceView.valid) {
        continue;
      }
      let scalar =
          Math.abs(vec3.dot(lightDirection, sliceView.viewportNormalInCanonicalCoordinates));
      let factor = ambientLighting + scalar * directionalLighting;
      let mat = tempMat4;
      // Need a matrix that maps (+1, +1, 0) to projectionMat * (width, height, 0)
      mat4.identity(mat);
      mat[0] = sliceView.width / 2.0;
      mat[5] = -sliceView.height / 2.0;
      mat4.multiply(mat, sliceView.invViewMatrix, mat);
      mat4.multiply(mat, viewProjectionMat, mat);
      const backgroundColor = tempVec4;
      const crossSectionBackgroundColor = this.viewer.crossSectionBackgroundColor.value;
      backgroundColor[0] = crossSectionBackgroundColor[0];
      backgroundColor[1] = crossSectionBackgroundColor[1];
      backgroundColor[2] = crossSectionBackgroundColor[2];
      backgroundColor[3] = 1;
      sliceViewRenderHelper.draw(
          sliceView.offscreenFramebuffer.colorBuffers[0].texture, mat,
          vec4.fromValues(factor, factor, factor, 1), tempVec4, 0, 0, 1, 1);
    }
  }

  protected drawAxisLines() {
    const {
      position: {value: position},
      zoomFactor: {value: zoom},
      displayDimensions: {value: {canonicalVoxelFactors, dimensionIndices: displayDimensionIndices}}
    } = this.viewer.navigationState;
    const axisRatio = Math.min(this.width, this.height) / this.height / 4;
    const axisLength = zoom * axisRatio;
    const mat = tempMat4;
    // Construct matrix that maps [-1, +1] x/y range to the full viewport data
    // coordinates.
    mat4.identity(mat);
    for (let i = 0; i < 3; ++i) {
      const globalDim = displayDimensionIndices[i];
      mat[12 + i] = globalDim === -1 ? 0 : position[globalDim];
      mat[5 * i] = axisLength / canonicalVoxelFactors[i];
    }
    mat4.multiply(mat, this.viewProjectionMat, mat);
    const {gl} = this;
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this.axesLineHelper.draw(mat, false);
  }

  zoomByMouse(factor: number) {
    this.navigationState.zoomBy(factor);
  }
}
