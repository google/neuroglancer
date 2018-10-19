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
import {makeRenderedPanelVisibleLayerTracker, MouseSelectionState, VisibleRenderLayerTracker} from 'neuroglancer/layer';
import {PickIDManager} from 'neuroglancer/object_picking';
import {PERSPECTIVE_VIEW_ADD_LAYER_RPC_ID, PERSPECTIVE_VIEW_REMOVE_LAYER_RPC_ID, PERSPECTIVE_VIEW_RPC_ID} from 'neuroglancer/perspective_view/base';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {RenderedDataPanel, RenderedDataViewerState} from 'neuroglancer/rendered_data_panel';
import {SliceView, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Owned} from 'neuroglancer/util/disposable';
import {ActionEvent, registerActionListener} from 'neuroglancer/util/event_action_map';
import {kAxes, mat4, transformVectorByMat4, vec3, vec4} from 'neuroglancer/util/geom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {WatchableMap} from 'neuroglancer/util/watchable_map';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {DepthBuffer, FramebufferConfiguration, makeTextureBuffers, OffscreenCopyHelper, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {glsl_packFloat01ToFixedPoint, unpackFloat01FromFixedPoint} from 'neuroglancer/webgl/shader_lib';
import {ScaleBarOptions, ScaleBarTexture} from 'neuroglancer/widget/scale_bar';
import {RPC, SharedObject} from 'neuroglancer/worker_rpc';

require('neuroglancer/noselect.css');
require('./panel.css');

export interface PerspectiveViewerState extends RenderedDataViewerState {
  orthographicProjection: TrackableBoolean;
  showSliceViews: TrackableBoolean;
  showScaleBar: TrackableBoolean;
  scaleBarOptions: TrackableValue<ScaleBarOptions>;
  showSliceViewsCheckbox?: boolean;
  crossSectionBackgroundColor: TrackableRGB;
  rpc: RPC;
}

export enum OffscreenTextures {
  COLOR,
  Z,
  PICK,
  NUM_TEXTURES
}

export const glsl_perspectivePanelEmit = [
  glsl_packFloat01ToFixedPoint, `
void emit(vec4 color, vec4 pickId) {
  v4f_fragData${OffscreenTextures.COLOR} = color;
  v4f_fragData${OffscreenTextures.Z} = packFloat01ToFixedPoint(1.0 - gl_FragCoord.z);
  v4f_fragData${OffscreenTextures.PICK} = pickId;
}
`
];

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
void emit(vec4 color, vec4 pickId) {
  float weight = computeOITWeight(color.a);
  vec4 accum = color * weight;
  v4f_fragData0 = vec4(accum.rgb, color.a);
  v4f_fragData1 = vec4(accum.a, 0.0, 0.0, 0.0);
}
`
];

export function perspectivePanelEmit(builder: ShaderBuilder) {
  builder.addOutputBuffer(
      'vec4', `v4f_fragData${OffscreenTextures.COLOR}`, OffscreenTextures.COLOR);
  builder.addOutputBuffer('vec4', `v4f_fragData${OffscreenTextures.Z}`, OffscreenTextures.Z);
  builder.addOutputBuffer('vec4', `v4f_fragData${OffscreenTextures.PICK}`, OffscreenTextures.PICK);
  builder.addFragmentCode(glsl_perspectivePanelEmit);
}

export function perspectivePanelEmitOIT(builder: ShaderBuilder) {
  builder.addOutputBuffer('vec4', 'v4f_fragData0', 0);
  builder.addOutputBuffer('vec4', 'v4f_fragData1', 1);
  builder.addFragmentCode(glsl_perspectivePanelEmitOIT);
}

const tempVec3 = vec3.create();
const tempVec3b = vec3.create();
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
class PerspectiveViewState extends PerspectiveViewStateBase {}

// The following three variables are for cursor state.
const ReceptiveField = { 
  width: 23, // must pick odd numbers so a center pixel exists
  height: 23,
};
const RFSpiral = spiralSequence(ReceptiveField.width, ReceptiveField.height);
const zData = new Uint8Array(ReceptiveField.width * ReceptiveField.height * 4);


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
  projectionMat = mat4.create();
  inverseProjectionMat = mat4.create();
  modelViewMat = mat4.create();
  width = 0;
  height = 0;
  protected pickIDs = new PickIDManager();
  private axesLineHelper = this.registerDisposer(AxesLineHelper.get(this.gl));
  sliceViewRenderHelper =
      this.registerDisposer(SliceViewRenderHelper.get(this.gl, perspectivePanelEmit));

  protected offscreenFramebuffer = this.registerDisposer(new FramebufferConfiguration(this.gl, {
    colorBuffers: makeTextureBuffers(this.gl, OffscreenTextures.NUM_TEXTURES),
    depthBuffer: new DepthBuffer(this.gl)
  }));

  protected transparentConfiguration_: FramebufferConfiguration<TextureBuffer>|undefined;

  protected offscreenCopyHelper = this.registerDisposer(OffscreenCopyHelper.get(this.gl));
  protected transparencyCopyHelper =
      this.registerDisposer(OffscreenCopyHelper.get(this.gl, defineTransparencyCopyShader, 2));

  private sharedObject: PerspectiveViewState;

  private scaleBarCopyHelper = this.registerDisposer(OffscreenCopyHelper.get(this.gl));
  private scaleBarTexture = this.registerDisposer(new ScaleBarTexture(this.gl));

  private nanometersPerPixel = 1;


  constructor(context: DisplayContext, element: HTMLElement, viewer: PerspectiveViewerState) {
    super(context, element, viewer);
    this.registerDisposer(this.navigationState.changed.add(() => {
      this.viewportChanged();
    }));

    const sharedObject = this.sharedObject = this.registerDisposer(new PerspectiveViewState());
    sharedObject.RPC_TYPE_ID = PERSPECTIVE_VIEW_RPC_ID;
    sharedObject.initializeCounterpart(viewer.rpc, {});
    sharedObject.visibility.add(this.visibility);

    this.visibleLayerTracker = makeRenderedPanelVisibleLayerTracker(
        this.viewer.layerManager, PerspectiveViewRenderLayer, this.viewer.visibleLayerRoles, this,
        layer => {
          const {backend} = layer;
          if (backend) {
            backend.rpc!.invoke(
                PERSPECTIVE_VIEW_ADD_LAYER_RPC_ID,
                {layer: backend.rpcId, view: this.sharedObject.rpcId});
            return () => {
              backend.rpc!.invoke(
                  PERSPECTIVE_VIEW_REMOVE_LAYER_RPC_ID,
                  {layer: backend.rpcId, view: this.sharedObject.rpcId});
            };
          }
          return undefined;
        });

    registerActionListener(element, 'translate-via-mouse-drag', (e: ActionEvent<MouseEvent>) => {
      startRelativeMouseDrag(e.detail, (_event, deltaX, deltaY) => {
        const temp = tempVec3;
        const {projectionMat} = this;
        const {width, height} = this;
        const {position} = this.viewer.navigationState;
        const pos = position.spatialCoordinates;
        vec3.transformMat4(temp, pos, projectionMat);
        temp[0] = 2 * deltaX / width;
        temp[1] = -2 * deltaY / height;
        vec3.transformMat4(pos, temp, this.inverseProjectionMat);
        position.changed.dispatch();
      });
    });

    registerActionListener(element, 'rotate-via-mouse-drag', (e: ActionEvent<MouseEvent>) => {
      startRelativeMouseDrag(e.detail, (_event, deltaX, deltaY) => {
        this.navigationState.pose.rotateRelative(kAxes[1], -deltaX / 4.0 * Math.PI / 180.0);
        this.navigationState.pose.rotateRelative(kAxes[0], deltaY / 4.0 * Math.PI / 180.0);
        this.viewer.navigationState.changed.dispatch();
      });
    });

    if (viewer.showSliceViewsCheckbox) {
      let showSliceViewsCheckbox =
          this.registerDisposer(new TrackableBooleanCheckbox(viewer.showSliceViews));
      showSliceViewsCheckbox.element.className =
          'perspective-panel-show-slice-views neuroglancer-noselect';
      let showSliceViewsLabel = document.createElement('label');
      showSliceViewsLabel.className = 'perspective-panel-show-slice-views neuroglancer-noselect';
      showSliceViewsLabel.appendChild(document.createTextNode('Slices'));
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
  }

  get navigationState() {
    return this.viewer.navigationState;
  }

  isReady() {
    if (!this.visible) {
      return false;
    }
    for (const [sliceView, unconditional] of this.sliceViews) {
      if (unconditional || this.viewer.showSliceViews.value) {
        if (!sliceView.isReady()) {
          return false;
        }
      }
    }
    let visibleLayers = this.visibleLayerTracker.getVisibleLayers();
    for (let renderLayer of visibleLayers) {
      if (!renderLayer.isReady()) {
        return false;
      }
    }
    return true;
  }

  updateProjectionMatrix() {
    let projectionMat = this.projectionMat;
    const zOffsetAmount = 100;
    const widthOverHeight = this.width / this.height;
    const fovy = Math.PI / 4.0;
    const nearBound = 10, farBound = 5000;
    if (this.viewer.orthographicProjection.value) {
      // Pick orthographic projection to match perspective projection at plane parallel to image
      // plane containing the center position.
      const f = 1.0 / Math.tan(fovy / 2);
      // We need -2 / (left - right) == f / widthOverHeight.
      // left - right = - 2 * widthOverHeight * orthoScalar
      // -2 / (left - right) = 1 / (widthOverHeight * orthoScalar).
      // 1 / orthoScalar == f.
      // orthoScalar = 1 / f
      const orthoScalar = zOffsetAmount / f;
      mat4.ortho(
          projectionMat, -widthOverHeight * orthoScalar, widthOverHeight * orthoScalar,
          -orthoScalar, orthoScalar, nearBound, farBound);
      this.nanometersPerPixel = 1 / (2 * projectionMat[0]) * this.navigationState.zoomFactor.value;
      this.nanometersPerPixel =
          2 * widthOverHeight * orthoScalar / this.width * this.navigationState.zoomFactor.value;
    } else {
      mat4.perspective(projectionMat, fovy, widthOverHeight, nearBound, farBound);
    }

    let modelViewMat = this.modelViewMat;
    this.navigationState.toMat4(modelViewMat);
    vec3.set(tempVec3, 1, -1, -1);
    mat4.scale(modelViewMat, modelViewMat, tempVec3);

    let viewOffset = vec3.set(tempVec3, 0, 0, zOffsetAmount);
    mat4.translate(modelViewMat, modelViewMat, viewOffset);

    let modelViewMatInv = tempMat4;
    mat4.invert(modelViewMatInv, modelViewMat);

    mat4.multiply(projectionMat, projectionMat, modelViewMatInv);
    mat4.invert(this.inverseProjectionMat, projectionMat);
  }

  viewportChanged() {
    // FIXME: update viewport information on backend
    this.context.scheduleRedraw();
  }

  onResize() {
    const {clientWidth, clientHeight} = this.element;
    if (clientWidth !== this.width || clientHeight !== this.height) {
      this.width = this.element.clientWidth;
      this.height = this.element.clientHeight;
      this.viewportChanged();
    }
  }

  disposed() {
    for (let sliceView of this.sliceViews.keys()) {
      sliceView.dispose();
    }
    this.sliceViews.clear();
    super.disposed();
  }

  updateMouseState(mouseState: MouseSelectionState): boolean {
    mouseState.pickedRenderLayer = null;
    if (!this.navigationState.valid) {
      return false;
    }
    let out = mouseState.position;
    let {offscreenFramebuffer, width, height} = this;
    if (!offscreenFramebuffer.hasSize(width, height)) {
      return false;
    }
    let glWindowX = this.mouseX;
    let glWindowY = height - this.mouseY;

    if (isNaN(glWindowX) || isNaN(glWindowY)) {
      return false;
    }

    const field_width = ReceptiveField.width;
    const field_height = ReceptiveField.height;
    const pixels = field_width * field_height;

    offscreenFramebuffer.readPixels(
      OffscreenTextures.Z, glWindowX, glWindowY,
      field_width, field_height, zData
    );

    let zDatum = 0;
    let rfindex = 0;
    for (let i = 0; i < pixels; i++) {
      rfindex = RFSpiral[i];
      zDatum = unpackFloat01FromFixedPoint(
        zData.slice(rfindex * 4, (rfindex + 1) * 4)
      );

      if (zDatum) {
        break;
      }
    }

    let glWindowZ = 1.0 - zDatum;
    if (glWindowZ === 1.0) {
      return false;
    }

    glWindowX += (rfindex % field_width) - (field_width >> 1);
    glWindowY += Math.floor(rfindex / field_height) - (field_height >> 1);

    out[0] = 2.0 * glWindowX / width - 1.0;
    out[1] = 2.0 * glWindowY / height - 1.0;
    out[2] = 2.0 * glWindowZ - 1.0;
    vec3.transformMat4(out, out, this.inverseProjectionMat);
    this.pickIDs.setMouseState(
        mouseState,
        offscreenFramebuffer.readPixelAsUint32(OffscreenTextures.PICK, glWindowX, glWindowY));
    return true;
  }

  translateDataPointByViewportPixels(out: vec3, orig: vec3, deltaX: number, deltaY: number): vec3 {
    const temp = tempVec3;
    const {projectionMat} = this;
    const {width, height} = this;
    vec3.transformMat4(temp, orig, projectionMat);
    temp[0] -= 2 * deltaX / width;
    temp[1] -= -2 * deltaY / height;
    return vec3.transformMat4(out, temp, this.inverseProjectionMat);
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

  draw() {
    if (!this.navigationState.valid) {
      return;
    }
    this.onResize();
    let {width, height} = this;
    if (width === 0 || height === 0) {
      return;
    }

    const showSliceViews = this.viewer.showSliceViews.value;
    for (const [sliceView, unconditional] of this.sliceViews) {
      if (unconditional || showSliceViews) {
        sliceView.updateRendering();
      }
    }

    let gl = this.gl;
    this.offscreenFramebuffer.bind(width, height);

    gl.disable(gl.SCISSOR_TEST);
    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    let {projectionMat} = this;
    this.updateProjectionMatrix();

    // FIXME; avoid temporaries
    let lightingDirection = vec3.create();
    transformVectorByMat4(lightingDirection, kAxes[2], this.modelViewMat);
    vec3.normalize(lightingDirection, lightingDirection);

    let ambient = 0.2;
    let directional = 1 - ambient;

    let pickIDs = this.pickIDs;
    pickIDs.clear();
    let renderContext: PerspectiveViewRenderContext = {
      dataToDevice: projectionMat,
      lightDirection: lightingDirection,
      ambientLighting: ambient,
      directionalLighting: directional,
      pickIDs: pickIDs,
      emitter: perspectivePanelEmit,
      emitColor: true,
      emitPickID: true,
      alreadyEmittedPickID: false,
      viewportWidth: width,
      viewportHeight: height,
    };

    let visibleLayers = this.visibleLayerTracker.getVisibleLayers();

    let hasTransparent = false;

    let hasAnnotation = false;

    // Draw fully-opaque layers first.
    for (let renderLayer of visibleLayers) {
      if (!renderLayer.isTransparent) {
        if (!renderLayer.isAnnotation) {
          renderLayer.draw(renderContext);
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

      for (let renderLayer of visibleLayers) {
        if (renderLayer.isAnnotation) {
          renderLayer.draw(renderContext);
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
      for (let renderLayer of visibleLayers) {
        if (renderLayer.isTransparent) {
          renderLayer.draw(renderContext);
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
    for (let renderLayer of visibleLayers) {
      renderContext.alreadyEmittedPickID = !renderLayer.isTransparent && !renderLayer.isAnnotation;
      renderLayer.draw(renderContext);
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
      const {scaleBarTexture} = this;
      const options = this.viewer.scaleBarOptions.value;
      const {dimensions} = scaleBarTexture;
      dimensions.targetLengthInPixels = Math.min(
          options.maxWidthFraction * width, options.maxWidthInPixels * options.scaleFactor);
      dimensions.nanometersPerPixel = this.nanometersPerPixel;
      scaleBarTexture.update(options);
      gl.viewport(
          options.leftPixelOffset * options.scaleFactor,
          options.bottomPixelOffset * options.scaleFactor, scaleBarTexture.width,
          scaleBarTexture.height);
      this.scaleBarCopyHelper.draw(scaleBarTexture.texture);
      gl.disable(WebGL2RenderingContext.BLEND);
    }
    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLViewport();
    this.offscreenCopyHelper.draw(
        this.offscreenFramebuffer.colorBuffers[OffscreenTextures.COLOR].texture);
  }

  protected drawSliceViews(renderContext: PerspectiveViewRenderContext) {
    let {sliceViewRenderHelper} = this;
    let {lightDirection, ambientLighting, directionalLighting, dataToDevice} = renderContext;

    const showSliceViews = this.viewer.showSliceViews.value;
    for (const [sliceView, unconditional] of this.sliceViews) {
      if (!unconditional && !showSliceViews) {
        continue;
      }
      if (sliceView.width === 0 || sliceView.height === 0 || !sliceView.hasValidViewport) {
        continue;
      }
      let scalar = Math.abs(vec3.dot(lightDirection, sliceView.viewportAxes[2]));
      let factor = ambientLighting + scalar * directionalLighting;
      let mat = tempMat4;
      // Need a matrix that maps (+1, +1, 0) to projectionMat * (width, height, 0)
      mat4.identity(mat);
      mat[0] = sliceView.width / 2.0;
      mat[5] = -sliceView.height / 2.0;
      mat4.multiply(mat, sliceView.viewportToData, mat);
      mat4.multiply(mat, dataToDevice, mat);
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
    const temp = tempVec3;
    const temp2 = tempVec3b;
    const {projectionMat} = this;
    const {position} = this.viewer.navigationState;
    const pos = position.spatialCoordinates;
    vec3.transformMat4(temp, pos, projectionMat);
    temp[0] = 0.5;
    vec3.transformMat4(temp2, temp, this.inverseProjectionMat);
    const length0 = vec3.distance(temp2, pos);
    temp[0] = 0;
    temp[1] = 0.5;
    vec3.transformMat4(temp2, temp, this.inverseProjectionMat);
    const length1 = vec3.distance(temp2, pos);

    let {gl} = this;
    let mat = tempMat4;
    mat4.identity(mat);
    // Draw axes lines.
    let axisLength = Math.min(length0, length1);

    // Construct matrix that maps [-1, +1] x/y range to the full viewport data
    // coordinates.
    mat[0] = axisLength;
    mat[5] = axisLength;
    mat[10] = axisLength;
    let center = this.navigationState.position.spatialCoordinates;
    mat[12] = center[0];
    mat[13] = center[1];
    mat[14] = center[2];
    mat[15] = 1;
    mat4.multiply(mat, this.projectionMat, mat);

    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    this.axesLineHelper.draw(mat, false);
  }

  zoomByMouse(factor: number) {
    this.navigationState.zoomBy(factor);
  }
}

/*  Generate a clockwise spiral around a 2D rectangular grid.
    Outputs Vec3s, but only x and y are used. Used for spiraling
    out of the center of the cursor to look for objects within the
    receptive field.

      3x3 pattern    3x3 unraveled array
      | 8, 7, 6 |    | 0, 1, 2 |
      | 1, 0, 5 |    | 3, 4, 5 |
      | 2, 3, 4 |    | 6, 7, 8 |

    Renders as [4,3,6,7,8,5,2,1,0] to show how to access the
    right hand side array in a spiral pattern.

    width: width of array in pixels
    height: height of array in pixels

    Note: width and height must be odd numbers

    We also apply a circularizing operator to filter out elements of
    the spiral that are outside a given radius from the center,
    otherwise the cursor will be more sensitive along diagonals.
*/
function spiralSequence(width: number, height: number) : Uint32Array {
  const pixels = width * height;
  let sequence = new Uint32Array(pixels);

  if (width === 0 || height === 0) {
    return sequence;
  }
  else if (width === 1) {
    for (let i = 0; i < height; i++) {
      sequence[i] = i * width;
    }
    return sequence;
  }
  else if (height === 1) {
    for (let i = 0; i < width; i++) {
      sequence[i] = i;
    }
    return sequence;
  }

  function clockwise_spiral(sequence: Uint32Array) {
    let bounds = [ width, height - 1 ];
    let direction = [ 1, 0 ];
    let pt = [ 0, 0 ];
    let bound_idx = 0;
    let steps = 1;

    for (let covered = 0; covered < pixels; covered++) {
      sequence[covered] = pt[0] + width * pt[1];

      pt[0] += direction[0];
      pt[1] += direction[1];
      steps += 1;

      if (steps === bounds[bound_idx]) {
        steps = 0;
        bounds[bound_idx] -= 1;
        bound_idx = (bound_idx + 1) % 2;
        direction = [ -direction[1], direction[0] ];
      }
    }

    return sequence;
  }

  sequence = clockwise_spiral(sequence).reverse();

  // Circularize
  let r2 = Math.min(width, height) / 2;
  r2 *= r2;

  return sequence.filter( (idx) => {
    let x = (idx % width) - (width >> 1);
    let y = Math.floor(idx / height) - (height >> 1);

    let dist2 = x*x + y*y;

    return dist2 <= r2;
  });
}
