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

import "#src/noselect.css";
import "#src/perspective_view/panel.css";

import type { PerspectiveViewAnnotationLayer } from "#src/annotation/renderlayer.js";
import { AxesLineHelper, computeAxisLineMatrix } from "#src/axes_lines.js";
import type { DisplayContext } from "#src/display_context.js";
import { applyRenderViewportToProjectionMatrix } from "#src/display_context.js";
import type { VisibleRenderLayerTracker } from "#src/layer/index.js";
import { makeRenderedPanelVisibleLayerTracker } from "#src/layer/index.js";
import { PERSPECTIVE_VIEW_RPC_ID } from "#src/perspective_view/base.js";
import type {
  PerspectiveViewReadyRenderContext,
  PerspectiveViewRenderContext,
} from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import { updateProjectionParametersFromInverseViewAndProjection } from "#src/projection_parameters.js";
import type {
  FramePickingData,
  RenderedDataViewerState,
} from "#src/rendered_data_panel.js";
import {
  clearOutOfBoundsPickData,
  pickDiameter,
  pickOffsetSequence,
  pickRadius,
  RenderedDataPanel,
} from "#src/rendered_data_panel.js";
import {
  DerivedProjectionParameters,
  SharedProjectionParameters,
} from "#src/renderlayer.js";
import type { SliceView } from "#src/sliceview/frontend.js";
import { SliceViewRenderHelper } from "#src/sliceview/frontend.js";
import type { TrackableBoolean } from "#src/trackable_boolean.js";
import { TrackableBooleanCheckbox } from "#src/trackable_boolean.js";
import type {
  TrackableValue,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import type { TrackableRGB } from "#src/util/color.js";
import type { Owned } from "#src/util/disposable.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import { kAxes, kZeroVec4, mat4, vec3, vec4 } from "#src/util/geom.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import type {
  TouchRotateInfo,
  TouchTranslateInfo,
} from "#src/util/touch_bindings.js";
import { WatchableMap } from "#src/util/watchable_map.js";
import { withSharedVisibility } from "#src/visibility_priority/frontend.js";
import { isProjectionLayer } from "#src/volume_rendering/trackable_volume_rendering_mode.js";
import type { VolumeRenderingRenderLayer } from "#src/volume_rendering/volume_render_layer.js";
import {
  DepthStencilRenderbuffer,
  FramebufferConfiguration,
  makeTextureBuffers,
  OffscreenCopyHelper,
  TextureBuffer,
} from "#src/webgl/offscreen.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";
import type { ScaleBarOptions } from "#src/widget/scale_bar.js";
import { MultipleScaleBarTextures } from "#src/widget/scale_bar.js";
import type { RPC } from "#src/worker_rpc.js";
import { SharedObject } from "#src/worker_rpc.js";

export interface PerspectiveViewerState extends RenderedDataViewerState {
  wireFrame: WatchableValueInterface<boolean>;
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
  COLOR = 0,
  Z = 1,
  PICK = 2,
  NUM_TEXTURES = 3,
}

export const glsl_perspectivePanelEmit = `
void emit(vec4 color, highp uint pickId) {
  out_color = color;
  float zValue = 1.0 - gl_FragCoord.z;
  out_z = vec4(zValue, zValue, zValue, 1.0);
  float pickIdFloat = float(pickId);
  out_pickId = vec4(pickIdFloat, pickIdFloat, pickIdFloat, 1.0);
}
`;

/**
 * http://jcgt.org/published/0002/02/09/paper.pdf
 * http://casual-effects.blogspot.com/2015/03/implemented-weighted-blended-order.html
 */
export const glsl_computeOITWeight = `
float computeOITWeight(float alpha, float depth) {
  float a = min(1.0, alpha) * 8.0 + 0.01;
  float b = -depth * 0.95 + 1.0;
  return a * a * a * b * b * b;
}
`;

// Color must be premultiplied by alpha.
// Can use emitAccumAndRevealage() to emit a pre-weighted OIT result.
export const glsl_perspectivePanelEmitOIT = [
  glsl_computeOITWeight,
  `
void emitAccumAndRevealage(vec4 accum, float revealage, highp uint pickId) {
  v4f_fragData0 = vec4(accum.rgb, revealage);
  v4f_fragData1 = vec4(accum.a, 0.0, 0.0, 0.0);
}
void emit(vec4 color, highp uint pickId) {
  float weight = computeOITWeight(color.a, gl_FragCoord.z);
  vec4 accum = color * weight;
  emitAccumAndRevealage(accum, color.a, pickId);
}
`,
];

export function perspectivePanelEmit(builder: ShaderBuilder) {
  builder.addOutputBuffer("vec4", "out_color", OffscreenTextures.COLOR);
  builder.addOutputBuffer("highp vec4", "out_z", OffscreenTextures.Z);
  builder.addOutputBuffer("highp vec4", "out_pickId", OffscreenTextures.PICK);
  builder.addFragmentCode(glsl_perspectivePanelEmit);
}

export function perspectivePanelEmitOIT(builder: ShaderBuilder) {
  builder.addOutputBuffer("vec4", "v4f_fragData0", 0);
  builder.addOutputBuffer("vec4", "v4f_fragData1", 1);
  builder.addFragmentCode(glsl_perspectivePanelEmitOIT);
}

export function maxProjectionEmit(builder: ShaderBuilder) {
  builder.addOutputBuffer("vec4", "v4f_fragData0", 0);
  builder.addOutputBuffer("highp vec4", "v4f_fragData1", 1);
  builder.addOutputBuffer("highp vec4", "v4f_fragData2", 2);
  builder.addFragmentCode(`
void emit(vec4 color, float depth, float pick) {
  v4f_fragData0 = color;
  v4f_fragData1 = vec4(1.0 - depth, 1.0 - depth, 1.0 - depth, 1.0);
  v4f_fragData2 = vec4(pick, pick, pick, 1.0);
}`);
}

const tempVec3 = vec3.create();
const tempVec4 = vec4.create();
const tempMat4 = mat4.create();

function defineTransparencyCopyShader(builder: ShaderBuilder) {
  builder.addOutputBuffer("vec4", "v4f_fragColor", null);
  builder.setFragmentMain(`
vec4 v0 = getValue0();
vec4 v1 = getValue1();
vec4 accum = vec4(v0.rgb, v1.r);
float revealage = v0.a;

v4f_fragColor = vec4(accum.rgb / accum.a, revealage);
`);
}

function defineMaxProjectionColorCopyShader(builder: ShaderBuilder) {
  builder.addOutputBuffer("vec4", "v4f_fragColor", null);
  builder.setFragmentMain(`
v4f_fragColor = getValue0();
`);
}

function defineMaxProjectionPickCopyShader(builder: ShaderBuilder) {
  builder.addOutputBuffer("vec4", "v4f_fragData0", 0);
  builder.addOutputBuffer("highp vec4", "v4f_fragData1", 1);
  builder.addOutputBuffer("highp vec4", "v4f_fragData2", 2);
  builder.setFragmentMain(`
v4f_fragData0 = vec4(0.0);
v4f_fragData1 = getValue0();
v4f_fragData2 = getValue1();
`);
}

function defineMaxProjectionToPickCopyShader(builder: ShaderBuilder) {
  builder.addOutputBuffer("highp vec4", "v4f_fragData0", 0);
  builder.addOutputBuffer("highp vec4", "v4f_fragData1", 1);
  builder.setFragmentMain(`
v4f_fragData0 = getValue0();
v4f_fragData1 = getValue1();
gl_FragDepth = v4f_fragData1.r;
`);
}

const PerspectiveViewStateBase = withSharedVisibility(SharedObject);
class PerspectiveViewState extends PerspectiveViewStateBase {
  sharedProjectionParameters: SharedProjectionParameters;
  constructor(public panel: PerspectivePanel) {
    super();
  }

  initializeCounterpart(rpc: RPC, options: any) {
    this.sharedProjectionParameters = this.registerDisposer(
      new SharedProjectionParameters(rpc, this.panel.projectionParameters),
    );
    options.projectionParameters = this.sharedProjectionParameters.rpcId;
    super.initializeCounterpart(rpc, options);
  }
}

export class PerspectivePanel extends RenderedDataPanel {
  viewer: PerspectiveViewerState;

  projectionParameters: Owned<DerivedProjectionParameters>;

  protected visibleLayerTracker: Owned<
    VisibleRenderLayerTracker<PerspectivePanel, PerspectiveViewRenderLayer>
  >;

  get rpc() {
    return this.sharedObject.rpc!;
  }
  get rpcId() {
    return this.sharedObject.rpcId!;
  }
  get displayDimensionRenderInfo() {
    return this.navigationState.displayDimensionRenderInfo;
  }

  /**
   * If boolean value is true, sliceView is shown unconditionally, regardless of the value of
   * this.viewer.showSliceViews.value.
   */
  sliceViews = this.registerDisposer(
    new WatchableMap<SliceView, boolean>(
      (context, _unconditional, sliceView) => {
        context.registerDisposer(sliceView);
        context.registerDisposer(sliceView.visibility.add(this.visibility));
      },
    ),
  );

  private axesLineHelper = this.registerDisposer(AxesLineHelper.get(this.gl));
  sliceViewRenderHelper = this.registerDisposer(
    SliceViewRenderHelper.get(this.gl, perspectivePanelEmit),
  );

  protected offscreenFramebuffer = this.registerDisposer(
    new FramebufferConfiguration(this.gl, {
      colorBuffers: [
        new TextureBuffer(
          this.gl,
          WebGL2RenderingContext.RGBA8,
          WebGL2RenderingContext.RGBA,
          WebGL2RenderingContext.UNSIGNED_BYTE,
        ),
        new TextureBuffer(
          this.gl,
          WebGL2RenderingContext.R32F,
          WebGL2RenderingContext.RED,
          WebGL2RenderingContext.FLOAT,
        ),
        new TextureBuffer(
          this.gl,
          WebGL2RenderingContext.R32F,
          WebGL2RenderingContext.RED,
          WebGL2RenderingContext.FLOAT,
        ),
      ],
      depthBuffer: new DepthStencilRenderbuffer(this.gl),
    }),
  );

  protected transparentConfiguration_:
    | FramebufferConfiguration<TextureBuffer>
    | undefined;

  protected maxProjectionConfiguration_:
    | FramebufferConfiguration<TextureBuffer>
    | undefined;

  protected maxProjectionPickConfiguration_:
    | FramebufferConfiguration<TextureBuffer>
    | undefined;

  protected offscreenCopyHelper = this.registerDisposer(
    OffscreenCopyHelper.get(this.gl),
  );
  protected transparencyCopyHelper = this.registerDisposer(
    OffscreenCopyHelper.get(this.gl, defineTransparencyCopyShader, 2),
  );
  protected maxProjectionColorCopyHelper = this.registerDisposer(
    OffscreenCopyHelper.get(this.gl, defineMaxProjectionColorCopyShader, 1),
  );
  protected maxProjectionPickCopyHelper = this.registerDisposer(
    OffscreenCopyHelper.get(this.gl, defineMaxProjectionPickCopyShader, 2),
  );
  protected maxProjectionToPickCopyHelper = this.registerDisposer(
    OffscreenCopyHelper.get(this.gl, defineMaxProjectionToPickCopyShader, 2),
  );

  private sharedObject: PerspectiveViewState;

  private scaleBars = this.registerDisposer(
    new MultipleScaleBarTextures(this.gl),
  );

  flushBackendProjectionParameters() {
    this.sharedObject.sharedProjectionParameters.flush();
  }

  constructor(
    context: DisplayContext,
    element: HTMLElement,
    viewer: PerspectiveViewerState,
  ) {
    super(context, element, viewer);
    this.projectionParameters = this.registerDisposer(
      new DerivedProjectionParameters({
        navigationState: this.navigationState,
        update: (out: ProjectionParameters, navigationState) => {
          const { invViewMatrix, projectionMat, logicalWidth, logicalHeight } =
            out;
          const widthOverHeight = logicalWidth / logicalHeight;
          const fovy = Math.PI / 4.0;
          let { relativeDepthRange } = navigationState;
          const baseZoomFactor = navigationState.zoomFactor.value;
          let zoomFactor = baseZoomFactor / 2;
          if (this.viewer.orthographicProjection.value) {
            // Pick orthographic projection to match perspective projection at plane parallel to image
            // plane containing the center position.
            const nearBound = Math.max(0.1, 1 - relativeDepthRange);
            const farBound = 1 + relativeDepthRange;
            mat4.ortho(
              projectionMat,
              -widthOverHeight,
              widthOverHeight,
              -1,
              1,
              nearBound,
              farBound,
            );
          } else {
            const f = 1.0 / Math.tan(fovy / 2);
            relativeDepthRange /= f;
            const nearBound = Math.max(0.1, 1 - relativeDepthRange);
            const farBound = 1 + relativeDepthRange;
            zoomFactor *= f;
            mat4.perspective(
              projectionMat,
              fovy,
              widthOverHeight,
              nearBound,
              farBound,
            );
          }
          applyRenderViewportToProjectionMatrix(out, projectionMat);
          navigationState.pose.toMat4(invViewMatrix, zoomFactor);
          mat4.scale(
            invViewMatrix,
            invViewMatrix,
            vec3.set(tempVec3, 1, -1, -1),
          );
          mat4.translate(invViewMatrix, invViewMatrix, kAxes[2]);
          updateProjectionParametersFromInverseViewAndProjection(out);
        },
      }),
    );
    this.projectionParameters.changed.add(() => this.context.scheduleRedraw());

    const sharedObject = (this.sharedObject = this.registerDisposer(
      new PerspectiveViewState(this),
    ));
    sharedObject.RPC_TYPE_ID = PERSPECTIVE_VIEW_RPC_ID;
    sharedObject.initializeCounterpart(viewer.rpc, {});
    sharedObject.visibility.add(this.visibility);

    this.visibleLayerTracker = makeRenderedPanelVisibleLayerTracker(
      this.viewer.layerManager,
      PerspectiveViewRenderLayer,
      this.viewer.visibleLayerRoles,
      this,
    );

    registerActionListener(
      element,
      "rotate-via-mouse-drag",
      (e: ActionEvent<MouseEvent>) => {
        startRelativeMouseDrag(e.detail, (_event, deltaX, deltaY) => {
          this.navigationState.pose.rotateRelative(
            kAxes[1],
            ((deltaX / 4.0) * Math.PI) / 180.0,
          );
          this.navigationState.pose.rotateRelative(
            kAxes[0],
            ((-deltaY / 4.0) * Math.PI) / 180.0,
          );
        });
      },
    );

    registerActionListener(
      element,
      "rotate-in-plane-via-touchrotate",
      (e: ActionEvent<TouchRotateInfo>) => {
        const { detail } = e;
        this.navigationState.pose.rotateRelative(
          kAxes[2],
          detail.angle - detail.prevAngle,
        );
      },
    );

    registerActionListener(
      element,
      "rotate-out-of-plane-via-touchtranslate",
      (e: ActionEvent<TouchTranslateInfo>) => {
        const { detail } = e;
        this.navigationState.pose.rotateRelative(
          kAxes[1],
          ((detail.deltaX / 4.0) * Math.PI) / 180.0,
        );
        this.navigationState.pose.rotateRelative(
          kAxes[0],
          ((-detail.deltaY / 4.0) * Math.PI) / 180.0,
        );
      },
    );

    if (viewer.showSliceViewsCheckbox) {
      const showSliceViewsCheckbox = this.registerDisposer(
        new TrackableBooleanCheckbox(viewer.showSliceViews),
      );
      showSliceViewsCheckbox.element.className =
        "perspective-panel-show-slice-views neuroglancer-noselect";
      const showSliceViewsLabel = document.createElement("label");
      showSliceViewsLabel.className =
        "perspective-panel-show-slice-views neuroglancer-noselect";
      showSliceViewsLabel.appendChild(document.createTextNode("Sections"));
      showSliceViewsLabel.appendChild(showSliceViewsCheckbox.element);
      this.element.appendChild(showSliceViewsLabel);
    }
    this.registerDisposer(
      viewer.orthographicProjection.changed.add(() => {
        this.projectionParameters.update();
        this.scheduleRedraw();
      }),
    );
    this.registerDisposer(
      viewer.showScaleBar.changed.add(() => this.scheduleRedraw()),
    );
    this.registerDisposer(
      viewer.scaleBarOptions.changed.add(() => this.scheduleRedraw()),
    );
    this.registerDisposer(
      viewer.showSliceViews.changed.add(() => this.scheduleRedraw()),
    );
    this.registerDisposer(
      viewer.showAxisLines.changed.add(() => this.scheduleRedraw()),
    );
    this.registerDisposer(
      viewer.crossSectionBackgroundColor.changed.add(() =>
        this.scheduleRedraw(),
      ),
    );
    this.registerDisposer(
      viewer.perspectiveViewBackgroundColor.changed.add(() =>
        this.scheduleRedraw(),
      ),
    );
    this.registerDisposer(
      viewer.wireFrame.changed.add(() => this.scheduleRedraw()),
    );
    this.sliceViews.changed.add(() => this.scheduleRedraw());
  }

  translateByViewportPixels(deltaX: number, deltaY: number): void {
    const temp = tempVec3;
    const {
      viewProjectionMat,
      invViewProjectionMat,
      logicalWidth,
      logicalHeight,
    } = this.projectionParameters.value;
    const { pose } = this.viewer.navigationState;
    pose.updateDisplayPosition((pos) => {
      vec3.transformMat4(temp, pos, viewProjectionMat);
      temp[0] += (-2 * deltaX) / logicalWidth;
      temp[1] += (2 * deltaY) / logicalHeight;
      vec3.transformMat4(pos, temp, invViewProjectionMat);
    });
  }

  get navigationState() {
    return this.viewer.navigationState;
  }

  ensureBoundsUpdated() {
    super.ensureBoundsUpdated();
    this.projectionParameters.setViewport(this.renderViewport);
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
    this.ensureBoundsUpdated();
    const { width, height } = this.renderViewport;
    if (width === 0 || height === 0) {
      return true;
    }
    const projectionParameters = this.projectionParameters.value;
    const renderContext: PerspectiveViewReadyRenderContext = {
      projectionParameters,
    };

    const { visibleLayers } = this.visibleLayerTracker;
    for (const [renderLayer, attachment] of visibleLayers) {
      if (!renderLayer.isReady(renderContext, attachment)) {
        return false;
      }
    }
    return true;
  }

  disposed() {
    this.sliceViews.clear();
    super.disposed();
  }

  getDepthArray(): Float32Array | undefined {
    if (!this.navigationState.valid) {
      return undefined;
    }
    const {
      offscreenFramebuffer,
      renderViewport: { width, height },
    } = this;
    const numPixels = width * height;
    const depthArrayRGBA = new Float32Array(numPixels * 4);
    try {
      offscreenFramebuffer.bindSingle(OffscreenTextures.Z);
      this.gl.readPixels(
        0,
        0,
        width,
        height,
        WebGL2RenderingContext.RGBA,
        WebGL2RenderingContext.FLOAT,
        depthArrayRGBA,
      );
    } finally {
      offscreenFramebuffer.framebuffer.unbind();
    }
    const depthArray = new Float32Array(numPixels);
    for (let i = 0; i < numPixels; ++i) {
      depthArray[i] = depthArrayRGBA[i * 4];
    }
    return depthArray;
  }

  issuePickRequest(glWindowX: number, glWindowY: number) {
    const { offscreenFramebuffer } = this;
    offscreenFramebuffer.readPixelFloat32IntoBuffer(
      OffscreenTextures.Z,
      glWindowX - pickRadius,
      glWindowY - pickRadius,
      0,
      pickDiameter,
      pickDiameter,
    );
    offscreenFramebuffer.readPixelFloat32IntoBuffer(
      OffscreenTextures.PICK,
      glWindowX - pickRadius,
      glWindowY - pickRadius,
      4 * 4 * pickDiameter * pickDiameter,
      pickDiameter,
      pickDiameter,
    );
  }

  completePickRequest(
    glWindowX: number,
    glWindowY: number,
    data: Float32Array,
    pickingData: FramePickingData,
  ) {
    const { mouseState } = this.viewer;
    mouseState.pickedRenderLayer = null;
    clearOutOfBoundsPickData(
      data,
      0,
      4,
      glWindowX,
      glWindowY,
      pickingData.viewportWidth,
      pickingData.viewportHeight,
    );
    const numOffsets = pickOffsetSequence.length;
    for (let i = 0; i < numOffsets; ++i) {
      const offset = pickOffsetSequence[i];
      const zValue = data[4 * offset];
      if (zValue === 0) continue;
      const relativeX = offset % pickDiameter;
      const relativeY = (offset - relativeX) / pickDiameter;
      const glWindowZ = 1.0 - zValue;
      tempVec3[0] =
        (2.0 * (glWindowX + relativeX - pickRadius)) /
          pickingData.viewportWidth -
        1.0;
      tempVec3[1] =
        (2.0 * (glWindowY + relativeY - pickRadius)) /
          pickingData.viewportHeight -
        1.0;
      tempVec3[2] = 2.0 * glWindowZ - 1.0;
      vec3.transformMat4(tempVec3, tempVec3, pickingData.invTransform);
      let { position: mousePosition, unsnappedPosition } = mouseState;
      const { value: voxelCoordinates } = this.navigationState.position;
      const rank = voxelCoordinates.length;
      if (mousePosition.length !== rank) {
        mousePosition = mouseState.position = new Float32Array(rank);
      }
      if (unsnappedPosition.length !== rank) {
        unsnappedPosition = mouseState.unsnappedPosition = new Float32Array(
          rank,
        );
      }
      mousePosition.set(voxelCoordinates);
      mouseState.coordinateSpace = this.navigationState.coordinateSpace.value;
      const displayDimensions =
        this.navigationState.pose.displayDimensions.value;
      const { displayDimensionIndices } = displayDimensions;
      for (
        let i = 0, spatialRank = displayDimensionIndices.length;
        i < spatialRank;
        ++i
      ) {
        mousePosition[displayDimensionIndices[i]] = tempVec3[i];
      }
      unsnappedPosition.set(mousePosition);
      const pickValue = data[4 * pickDiameter * pickDiameter + 4 * offset];
      pickingData.pickIDs.setMouseState(mouseState, pickValue);
      mouseState.displayDimensions = displayDimensions;
      mouseState.setActive(true);
      return;
    }
    mouseState.setActive(false);
  }

  translateDataPointByViewportPixels(
    out: vec3,
    orig: vec3,
    deltaX: number,
    deltaY: number,
  ): vec3 {
    const temp = tempVec3;
    const { viewProjectionMat, invViewProjectionMat, width, height } =
      this.projectionParameters.value;
    vec3.transformMat4(temp, orig, viewProjectionMat);
    temp[0] += (2 * deltaX) / width;
    temp[1] += (-2 * deltaY) / height;
    return vec3.transformMat4(out, temp, invViewProjectionMat);
  }

  private get transparentConfiguration() {
    let transparentConfiguration = this.transparentConfiguration_;
    if (transparentConfiguration === undefined) {
      transparentConfiguration = this.transparentConfiguration_ =
        this.registerDisposer(
          new FramebufferConfiguration(this.gl, {
            colorBuffers: makeTextureBuffers(
              this.gl,
              2,
              this.gl.RGBA32F,
              this.gl.RGBA,
              this.gl.FLOAT,
            ),
            depthBuffer: this.offscreenFramebuffer.depthBuffer!.addRef(),
          }),
        );
    }
    return transparentConfiguration;
  }

  private get maxProjectionConfiguration() {
    let maxProjectionConfiguration = this.maxProjectionConfiguration_;
    if (maxProjectionConfiguration === undefined) {
      maxProjectionConfiguration = this.maxProjectionConfiguration_ =
        this.registerDisposer(
          new FramebufferConfiguration(this.gl, {
            colorBuffers: [
              new TextureBuffer(
                this.gl,
                WebGL2RenderingContext.RGBA8,
                WebGL2RenderingContext.RGBA,
                WebGL2RenderingContext.UNSIGNED_BYTE,
              ),
              new TextureBuffer(
                this.gl,
                WebGL2RenderingContext.R32F,
                WebGL2RenderingContext.RED,
                WebGL2RenderingContext.FLOAT,
              ),
              new TextureBuffer(
                this.gl,
                WebGL2RenderingContext.R32F,
                WebGL2RenderingContext.RED,
                WebGL2RenderingContext.FLOAT,
              ),
            ],
            depthBuffer: new DepthStencilRenderbuffer(this.gl),
          }),
        );
    }
    return maxProjectionConfiguration;
  }

  private get maxProjectionPickConfiguration() {
    let maxProjectionPickConfiguration = this.maxProjectionPickConfiguration_;
    if (maxProjectionPickConfiguration === undefined) {
      maxProjectionPickConfiguration = this.maxProjectionPickConfiguration_ =
        this.registerDisposer(
          new FramebufferConfiguration(this.gl, {
            colorBuffers: makeTextureBuffers(
              this.gl,
              2,
              WebGL2RenderingContext.R32F,
              WebGL2RenderingContext.RED,
              WebGL2RenderingContext.FLOAT,
            ),
            depthBuffer: new DepthStencilRenderbuffer(this.gl),
          }),
        );
    }
    return maxProjectionPickConfiguration;
  }

  drawWithPicking(pickingData: FramePickingData): boolean {
    if (!this.navigationState.valid) {
      return false;
    }
    const { width, height } = this.renderViewport;
    const showSliceViews = this.viewer.showSliceViews.value;
    for (const [sliceView, unconditional] of this.sliceViews) {
      if (unconditional || showSliceViews) {
        sliceView.updateRendering();
      }
    }

    const gl = this.gl;
    const disablePicking = () => {
      gl.drawBuffers(this.offscreenFramebuffer.singleAttachmentList);
    };
    const bindFramebuffer = () => {
      this.offscreenFramebuffer.bind(width, height);
    };
    bindFramebuffer();
    gl.disable(gl.SCISSOR_TEST);

    // Stencil buffer bit 0 indicates positions of framebuffer written by an opaque layer.
    //
    // Stencil buffer bit 1 indicates positions of framebuffer written by a transparent layer with
    // transparentPickEnabled=true.
    //
    // For a given xy framebuffer position, the pick id is chosen as the front-most position within
    // the highest *priority* class for which there is a fragment.  The 3 priority classes are:
    //
    // 1. Opaque layers
    // 2. Transparent layers with transparentPickEnabled==true
    // 3. Transparent layers with transparentPickEnabled==false
    //
    // For example, if a given ray passes first through an object from a transparent layer with
    // transparentPickEnabled=false, then through an object from a transparent layer with
    // transparentPickEnabled=true, the pick id will be for the object with
    // transparentPickEnabled=true, even though it is not the front-most object.
    //
    // We accomplish this priority scheme by writing to the pick buffer in 3 phases:
    //
    // 1. For opaque layers, we write to the pick buffer and depth buffer, and also set bit 0 of the
    // stencil buffer, at the same time as we render the color buffer.
    //
    // 2. For transparent layers, we write to the pick buffer as a separate rendering pass.  First,
    // we handle transparentPickEnabled=true layers: we write to the pick buffer and depth buffer,
    // and set the stencil buffer to `3`, but only at positions where the stencil buffer is unset.
    // Then, for transparentPickEnabled=false layers, we write to the pick buffer and depth buffer,
    // but only at positions where the stencil buffer is still unset.
    gl.enable(WebGL2RenderingContext.STENCIL_TEST);
    gl.stencilMask(0xffffffff);
    gl.clearStencil(0);
    gl.clear(WebGL2RenderingContext.STENCIL_BUFFER_BIT);

    // Write 1 to the stencil buffer unconditionally.  We set an always-pass stencil test in order
    // to be able to write to the stencil buffer.
    gl.stencilOp(
      /*sfail=*/ WebGL2RenderingContext.KEEP,
      /*dpfail=*/ WebGL2RenderingContext.KEEP,
      /*dppass=*/ WebGL2RenderingContext.REPLACE,
    );
    gl.stencilFunc(
      /*func=*/ WebGL2RenderingContext.ALWAYS,
      /*ref=*/ 1,
      /*mask=*/ 1,
    );
    const backgroundColor = this.viewer.perspectiveViewBackgroundColor.value;
    this.gl.clearColor(
      backgroundColor[0],
      backgroundColor[1],
      backgroundColor[2],
      0.0,
    );
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.clearBufferfv(WebGL2RenderingContext.COLOR, OffscreenTextures.COLOR, [
      backgroundColor[0],
      backgroundColor[1],
      backgroundColor[2],
      0.0,
    ]);
    gl.clearBufferfv(
      WebGL2RenderingContext.COLOR,
      OffscreenTextures.Z,
      kZeroVec4,
    );
    gl.clearBufferfv(
      WebGL2RenderingContext.COLOR,
      OffscreenTextures.PICK,
      kZeroVec4,
    );

    gl.enable(gl.DEPTH_TEST);
    const projectionParameters = this.projectionParameters.value;

    // FIXME; avoid temporaries
    const lightingDirection = vec3.create();
    vec3.transformQuat(
      lightingDirection,
      kAxes[2],
      this.navigationState.pose.orientation.orientation,
    );
    vec3.scale(lightingDirection, lightingDirection, -1);

    const ambient = 0.2;
    const directional = 1 - ambient;

    const renderContext: PerspectiveViewRenderContext = {
      wireFrame: this.viewer.wireFrame.value,
      projectionParameters,
      lightDirection: lightingDirection,
      ambientLighting: ambient,
      directionalLighting: directional,
      pickIDs: pickingData.pickIDs,
      emitter: perspectivePanelEmit,
      emitColor: true,
      emitPickID: true,
      alreadyEmittedPickID: false,
      bindFramebuffer,
      frameNumber: this.context.frameNumber,
    };

    mat4.copy(
      pickingData.invTransform,
      projectionParameters.invViewProjectionMat,
    );

    const { visibleLayers } = this.visibleLayerTracker;

    let hasTransparent = false;
    let hasMaxProjection = false;

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
        if (renderLayer.isVolumeRendering) {
          hasMaxProjection =
            hasMaxProjection ||
            isProjectionLayer(renderLayer as VolumeRenderingRenderLayer);
        }
      }
    }
    this.drawSliceViews(renderContext);

    if (hasAnnotation) {
      // Render annotations with blending enabled.

      gl.enable(WebGL2RenderingContext.BLEND);
      gl.depthFunc(WebGL2RenderingContext.LEQUAL);
      gl.blendFunc(
        WebGL2RenderingContext.SRC_ALPHA,
        WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
      );
      for (const [renderLayer, attachment] of visibleLayers) {
        if (renderLayer.isAnnotation) {
          const annotationRenderLayer =
            renderLayer as PerspectiveViewAnnotationLayer;
          if (
            annotationRenderLayer.base.state.displayState.disablePicking.value
          ) {
            disablePicking();
            annotationRenderLayer.draw(renderContext, attachment);
            renderContext.bindFramebuffer();
          } else {
            annotationRenderLayer.draw(renderContext, attachment);
          }
        }
      }
      gl.depthFunc(WebGL2RenderingContext.LESS);
      gl.disable(WebGL2RenderingContext.BLEND);
    }

    if (this.viewer.showAxisLines.value) {
      this.drawAxisLines();
    }

    // Disable stencil operations.
    gl.stencilOp(
      /*sfail=*/ WebGL2RenderingContext.KEEP,
      /*dpfail=*/ WebGL2RenderingContext.KEEP,
      /*dppass=*/ WebGL2RenderingContext.KEEP,
    );

    if (hasTransparent) {
      //Draw transparent objects.

      // Create max projection buffer if needed.
      let bindMaxProjectionBuffer: () => void = () => {};
      let bindMaxProjectionPickingBuffer: () => void = () => {};
      if (hasMaxProjection) {
        const { maxProjectionConfiguration } = this;
        bindMaxProjectionBuffer = () => {
          maxProjectionConfiguration.bind(width, height);
        };
        gl.depthMask(true);
        bindMaxProjectionBuffer();
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clearDepth(0.0);
        gl.clear(
          WebGL2RenderingContext.COLOR_BUFFER_BIT |
            WebGL2RenderingContext.DEPTH_BUFFER_BIT,
        );

        const { maxProjectionPickConfiguration } = this;
        bindMaxProjectionPickingBuffer = () => {
          maxProjectionPickConfiguration.bind(width, height);
        };
        bindMaxProjectionPickingBuffer();
        gl.clear(
          WebGL2RenderingContext.COLOR_BUFFER_BIT |
            WebGL2RenderingContext.DEPTH_BUFFER_BIT,
        );
      }

      // Compute accumulate and revealage textures.
      gl.depthMask(false);
      gl.enable(WebGL2RenderingContext.BLEND);
      const { transparentConfiguration } = this;
      renderContext.bindFramebuffer = () => {
        transparentConfiguration.bind(width, height);
      };
      renderContext.bindFramebuffer();
      gl.clearDepth(1.0);
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
      renderContext.emitter = perspectivePanelEmitOIT;
      gl.blendFuncSeparate(
        WebGL2RenderingContext.ONE,
        WebGL2RenderingContext.ONE,
        WebGL2RenderingContext.ZERO,
        WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
      );
      renderContext.emitPickID = false;
      for (const [renderLayer, attachment] of visibleLayers) {
        if (renderLayer.isTransparent) {
          renderContext.depthBufferTexture =
            this.offscreenFramebuffer.colorBuffers[OffscreenTextures.Z].texture;
        }
        if (
          renderLayer.isVolumeRendering &&
          isProjectionLayer(renderLayer as VolumeRenderingRenderLayer)
        ) {
          // Set state for max projection mode and draw
          gl.depthMask(true);
          gl.disable(WebGL2RenderingContext.BLEND);
          gl.depthFunc(WebGL2RenderingContext.GREATER);
          renderContext.emitter = maxProjectionEmit;
          bindMaxProjectionBuffer();
          renderLayer.draw(renderContext, attachment);

          // Copy max projection result to picking buffer
          // Depth testing on to combine max layers into one pick buffer via depth
          bindMaxProjectionPickingBuffer();
          this.maxProjectionToPickCopyHelper.draw(
            this.maxProjectionConfiguration.colorBuffers[1 /*depth*/].texture,
            this.maxProjectionConfiguration.colorBuffers[2 /*pick*/].texture,
          );

          // Copy max projection color result to color only buffer
          // Depth testing off to combine max layers into one color via blend
          this.offscreenFramebuffer.bindSingle(OffscreenTextures.COLOR);
          gl.depthMask(false);
          gl.disable(WebGL2RenderingContext.DEPTH_TEST);
          gl.enable(WebGL2RenderingContext.BLEND);
          gl.blendFunc(
            WebGL2RenderingContext.ONE,
            WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
          );
          this.maxProjectionColorCopyHelper.draw(
            this.maxProjectionConfiguration.colorBuffers[0 /*color*/].texture,
          );

          // Reset the max projection buffer
          bindMaxProjectionBuffer();
          gl.depthMask(true);
          gl.clearColor(0.0, 0.0, 0.0, 0.0);
          gl.clearDepth(0.0);
          gl.clear(
            WebGL2RenderingContext.COLOR_BUFFER_BIT |
              WebGL2RenderingContext.DEPTH_BUFFER_BIT,
          );

          // Set back to non-max projection state
          gl.clearDepth(1.0);
          gl.clearColor(0.0, 0.0, 0.0, 1.0);
          gl.depthMask(false);
          gl.blendFuncSeparate(
            WebGL2RenderingContext.ONE,
            WebGL2RenderingContext.ONE,
            WebGL2RenderingContext.ZERO,
            WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
          );
          gl.enable(WebGL2RenderingContext.DEPTH_TEST);
          gl.depthFunc(WebGL2RenderingContext.LESS);
          renderContext.emitter = perspectivePanelEmitOIT;
          renderContext.bindFramebuffer();
          continue;
        }
        renderLayer.draw(renderContext, attachment);
      }
      // Copy transparent rendering result back to primary buffer.
      gl.disable(WebGL2RenderingContext.DEPTH_TEST);
      this.offscreenFramebuffer.bindSingle(OffscreenTextures.COLOR);
      gl.blendFunc(
        WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
        WebGL2RenderingContext.SRC_ALPHA,
      );
      this.transparencyCopyHelper.draw(
        transparentConfiguration.colorBuffers[0].texture,
        transparentConfiguration.colorBuffers[1].texture,
      );

      gl.depthMask(true);
      gl.disable(WebGL2RenderingContext.BLEND);
      gl.enable(WebGL2RenderingContext.DEPTH_TEST);

      // Restore framebuffer attachments.
      renderContext.bindFramebuffer = bindFramebuffer;
      bindFramebuffer();

      // Do picking only rendering pass for transparent layers.
      gl.enable(WebGL2RenderingContext.STENCIL_TEST);
      gl.drawBuffers([gl.NONE, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      renderContext.emitter = perspectivePanelEmit;
      renderContext.emitPickID = true;
      renderContext.emitColor = false;

      // First, render `transparentPickEnabled=true` layers.

      // Only write to positions where the stencil buffer bit 0 is unset (i.e. the ray does not
      // intersect any opaque object), since opaque objects take precedence.  Set the stencil buffer
      // bit 1 to ensure those positions take precedence over `transparentPickEnabled=false` layers.
      gl.stencilFunc(
        /*func=*/ WebGL2RenderingContext.NOTEQUAL,
        /*ref=*/ 3,
        /*mask=*/ 1,
      );
      gl.stencilOp(
        /*sfail=*/ WebGL2RenderingContext.KEEP,
        /*dpfail=*/ WebGL2RenderingContext.KEEP,
        /*dppass=*/ WebGL2RenderingContext.REPLACE,
      );
      gl.stencilMask(2);
      for (const [renderLayer, attachment] of visibleLayers) {
        if (!renderLayer.isTransparent || !renderLayer.transparentPickEnabled) {
          continue;
        }
        // For max projection layers, can copy over the pick buffer directly.
        if (renderLayer.isVolumeRendering) {
          if (isProjectionLayer(renderLayer as VolumeRenderingRenderLayer)) {
            this.maxProjectionPickCopyHelper.draw(
              this.maxProjectionPickConfiguration.colorBuffers[0]
                .texture /*depth*/,
              this.maxProjectionPickConfiguration.colorBuffers[1]
                .texture /*pick*/,
            );
          }
          // Draw picking for non min/max volume rendering layers
          else {
            // Currently volume rendering layers have no picking support
            // Outside of min/max mode
            continue;
          }
          // other transparent layers are drawn as usual
        } else {
          renderLayer.draw(renderContext, attachment);
        }
      }

      gl.stencilFunc(
        /*func=*/ WebGL2RenderingContext.EQUAL,
        /*ref=*/ 0,
        /*mask=*/ 3,
      );
      gl.stencilOp(
        /*sfail=*/ WebGL2RenderingContext.KEEP,
        /*dpfail=*/ WebGL2RenderingContext.KEEP,
        /*dppass=*/ WebGL2RenderingContext.KEEP,
      );
      gl.stencilMask(0);
      for (const [renderLayer, attachment] of visibleLayers) {
        if (!renderLayer.isTransparent || renderLayer.transparentPickEnabled) {
          continue;
        }
        renderLayer.draw(renderContext, attachment);
      }
    }
    gl.stencilMask(0xffffffff);
    gl.disable(WebGL2RenderingContext.STENCIL_TEST);

    if (
      this.viewer.showScaleBar.value &&
      this.viewer.orthographicProjection.value
    ) {
      // Only modify color buffer.
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

      gl.disable(WebGL2RenderingContext.DEPTH_TEST);
      gl.enable(WebGL2RenderingContext.BLEND);
      gl.blendFunc(
        WebGL2RenderingContext.SRC_ALPHA,
        WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
      );
      const { scaleBars } = this;
      const options = this.viewer.scaleBarOptions.value;
      scaleBars.draw(
        this.renderViewport,
        this.navigationState.displayDimensionRenderInfo.value,
        this.navigationState.relativeDisplayScales.value,
        this.navigationState.zoomFactor.value /
          this.renderViewport.logicalHeight,
        options,
      );
      gl.disable(WebGL2RenderingContext.BLEND);
    }
    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLClippedViewport();
    this.offscreenCopyHelper.draw(
      this.offscreenFramebuffer.colorBuffers[OffscreenTextures.COLOR].texture,
    );
    return true;
  }

  protected drawSliceViews(renderContext: PerspectiveViewRenderContext) {
    const { sliceViewRenderHelper } = this;
    const {
      lightDirection,
      ambientLighting,
      directionalLighting,
      projectionParameters: { viewProjectionMat },
    } = renderContext;

    const showSliceViews = this.viewer.showSliceViews.value;
    for (const [sliceView, unconditional] of this.sliceViews) {
      if (!unconditional && !showSliceViews) {
        continue;
      }
      const {
        width: sliceViewWidth,
        height: sliceViewHeight,
        invViewMatrix: sliceViewInvViewMatrix,
        viewportNormalInCanonicalCoordinates,
      } = sliceView.projectionParameters.value;
      if (sliceViewWidth === 0 || sliceViewHeight === 0 || !sliceView.valid) {
        continue;
      }
      const scalar = Math.abs(
        vec3.dot(lightDirection, viewportNormalInCanonicalCoordinates),
      );
      const factor = ambientLighting + scalar * directionalLighting;
      const mat = tempMat4;
      // Need a matrix that maps (+1, +1, 0) to projectionMat * (width, height, 0)
      mat4.identity(mat);
      mat[0] = sliceViewWidth / 2.0;
      mat[5] = -sliceViewHeight / 2.0;
      mat4.multiply(mat, sliceViewInvViewMatrix, mat);
      mat4.multiply(mat, viewProjectionMat, mat);
      const backgroundColor = tempVec4;
      const crossSectionBackgroundColor =
        this.viewer.crossSectionBackgroundColor.value;
      backgroundColor[0] = crossSectionBackgroundColor[0];
      backgroundColor[1] = crossSectionBackgroundColor[1];
      backgroundColor[2] = crossSectionBackgroundColor[2];
      backgroundColor[3] = 1;
      sliceViewRenderHelper.draw(
        sliceView.offscreenFramebuffer.colorBuffers[0].texture,
        mat,
        vec4.fromValues(factor, factor, factor, 1),
        tempVec4,
        0,
        0,
        1,
        1,
      );
    }
  }

  protected drawAxisLines() {
    const {
      zoomFactor: { value: zoom },
    } = this.viewer.navigationState;
    const projectionParameters = this.projectionParameters.value;
    const axisRatio =
      Math.min(
        projectionParameters.logicalWidth,
        projectionParameters.logicalHeight,
      ) /
      this.renderViewport.logicalHeight /
      4;
    const axisLength = zoom * axisRatio;
    const { gl } = this;
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this.axesLineHelper.draw(
      computeAxisLineMatrix(projectionParameters, axisLength),
      /*blend=*/ false,
    );
  }

  zoomByMouse(factor: number) {
    this.navigationState.zoomBy(factor);
  }
}
