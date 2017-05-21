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
import {makeRenderedPanelVisibleLayerTracker, MouseSelectionState} from 'neuroglancer/layer';
import {PickIDManager} from 'neuroglancer/object_picking';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {RenderedDataPanel} from 'neuroglancer/rendered_data_panel';
import {SliceView, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {kAxes, mat4, transformVectorByMat4, vec3, vec4} from 'neuroglancer/util/geom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {ViewerState} from 'neuroglancer/viewer_state';
import {DepthBuffer, FramebufferConfiguration, makeTextureBuffers, OffscreenCopyHelper, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {glsl_packFloat01ToFixedPoint, unpackFloat01FromFixedPoint} from 'neuroglancer/webgl/shader_lib';

require('neuroglancer/noselect.css');
require('./panel.css');

export interface PerspectiveViewerState extends ViewerState {
  showSliceViews: TrackableBoolean;
  showSliceViewsCheckbox?: boolean;
}

export enum OffscreenTextures {
  COLOR,
  Z,
  PICK,
  NUM_TEXTURES
}

export const glsl_perspectivePanelEmit = [
  glsl_packFloat01ToFixedPoint,
  `
void emit(vec4 color, vec4 pickId) {
  gl_FragData[${OffscreenTextures.COLOR}] = color;
  gl_FragData[${OffscreenTextures.Z}] = packFloat01ToFixedPoint(1.0 - gl_FragCoord.z);
  gl_FragData[${OffscreenTextures.PICK}] = pickId;
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
  gl_FragData[0] = vec4(accum.rgb, color.a);
  gl_FragData[1] = vec4(accum.a, 0.0, 0.0, 0.0);
}
`
];

export function perspectivePanelEmit(builder: ShaderBuilder) {
  builder.addFragmentExtension('GL_EXT_draw_buffers');
  builder.addFragmentCode(glsl_perspectivePanelEmit);
}

export function perspectivePanelEmitOIT(builder: ShaderBuilder) {
  builder.addFragmentExtension('GL_EXT_draw_buffers');
  builder.addFragmentCode(glsl_perspectivePanelEmitOIT);
}

const tempVec3 = vec3.create();
const tempMat4 = mat4.create();

function defineTransparencyCopyShader(builder: ShaderBuilder) {
  builder.setFragmentMain(`
vec4 v0 = getValue0();
vec4 v1 = getValue1();
vec4 accum = vec4(v0.rgb, v1.r);
float revealage = v0.a;

gl_FragColor = vec4(accum.rgb / accum.a, revealage);
`);
}

export class PerspectivePanel extends RenderedDataPanel {
  viewer: PerspectiveViewerState;

  private visibleLayerTracker = makeRenderedPanelVisibleLayerTracker(
      this.viewer.layerManager, PerspectiveViewRenderLayer, this);

  sliceViews = new Set<SliceView>();
  projectionMat = mat4.create();
  inverseProjectionMat = mat4.create();
  modelViewMat = mat4.create();
  width = 0;
  height = 0;
  private pickIDs = new PickIDManager();
  private axesLineHelper = this.registerDisposer(AxesLineHelper.get(this.gl));
  sliceViewRenderHelper =
      this.registerDisposer(SliceViewRenderHelper.get(this.gl, perspectivePanelEmit));

  private offscreenFramebuffer = this.registerDisposer(new FramebufferConfiguration(this.gl, {
    colorBuffers: makeTextureBuffers(this.gl, OffscreenTextures.NUM_TEXTURES),
    depthBuffer: new DepthBuffer(this.gl)
  }));

  private transparentConfiguration_: FramebufferConfiguration<TextureBuffer>|undefined;

  private offscreenCopyHelper = this.registerDisposer(OffscreenCopyHelper.get(this.gl));
  private transparencyCopyHelper =
      this.registerDisposer(OffscreenCopyHelper.get(this.gl, defineTransparencyCopyShader, 2));

  constructor(context: DisplayContext, element: HTMLElement, viewer: PerspectiveViewerState) {
    super(context, element, viewer);
    this.registerDisposer(this.navigationState.changed.add(() => {
      this.viewportChanged();
    }));

    if (viewer.showSliceViewsCheckbox) {
      let showSliceViewsCheckbox =
          this.registerDisposer(new TrackableBooleanCheckbox(viewer.showSliceViews));
      showSliceViewsCheckbox.element.className = 'perspective-panel-show-slice-views noselect';
      let showSliceViewsLabel = document.createElement('label');
      showSliceViewsLabel.className = 'perspective-panel-show-slice-views noselect';
      showSliceViewsLabel.appendChild(document.createTextNode('Slices'));
      showSliceViewsLabel.appendChild(showSliceViewsCheckbox.element);
      this.element.appendChild(showSliceViewsLabel);
    }
    this.registerDisposer(viewer.showSliceViews.changed.add(() => {
      this.scheduleRedraw();
    }));
    this.registerDisposer(viewer.showAxisLines.changed.add(() => {
      this.scheduleRedraw();
    }));
  }
  get navigationState() {
    return this.viewer.navigationState;
  }

  updateProjectionMatrix() {
    let projectionMat = this.projectionMat;
    mat4.perspective(projectionMat, Math.PI / 4.0, this.width / this.height, 10, 5000);
    let modelViewMat = this.modelViewMat;
    this.navigationState.toMat4(modelViewMat);
    vec3.set(tempVec3, 1, -1, -1);
    mat4.scale(modelViewMat, modelViewMat, tempVec3);

    let viewOffset = vec3.set(tempVec3, 0, 0, 100);
    mat4.translate(modelViewMat, modelViewMat, viewOffset);

    let modelViewMatInv = tempMat4;
    mat4.invert(modelViewMatInv, modelViewMat);

    mat4.multiply(projectionMat, projectionMat, modelViewMatInv);
    mat4.invert(this.inverseProjectionMat, projectionMat);
  }

  viewportChanged() {
    this.context.scheduleRedraw();
  }

  onResize() {
    this.width = this.element.clientWidth;
    this.height = this.element.clientHeight;
    this.viewportChanged();
  }

  disposed() {
    for (let sliceView of this.sliceViews) {
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
    let zData = offscreenFramebuffer.readPixel(OffscreenTextures.Z, glWindowX, glWindowY);
    let glWindowZ = 1.0 - unpackFloat01FromFixedPoint(zData);
    if (glWindowZ === 1.0) {
      return false;
    }
    out[0] = 2.0 * glWindowX / width - 1.0;
    out[1] = 2.0 * glWindowY / height - 1.0;
    out[2] = 2.0 * glWindowZ - 1.0;
    vec3.transformMat4(out, out, this.inverseProjectionMat);
    this.pickIDs.setMouseState(
        mouseState,
        offscreenFramebuffer.readPixelAsUint32(OffscreenTextures.PICK, glWindowX, glWindowY));
    return true;
  }

  startDragViewport(e: MouseEvent) {
    startRelativeMouseDrag(e, (event, deltaX, deltaY) => {
      if (event.shiftKey) {
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
      } else {
        this.navigationState.pose.rotateRelative(kAxes[1], -deltaX / 4.0 * Math.PI / 180.0);
        this.navigationState.pose.rotateRelative(kAxes[0], deltaY / 4.0 * Math.PI / 180.0);
        this.viewer.navigationState.changed.dispatch();
      }
    });
  }

  private get transparentConfiguration() {
    let transparentConfiguration = this.transparentConfiguration_;
    if (transparentConfiguration === undefined) {
      transparentConfiguration = this.transparentConfiguration_ =
          this.registerDisposer(new FramebufferConfiguration(this.gl, {
            colorBuffers: makeTextureBuffers(this.gl, 2, this.gl.RGBA, this.gl.FLOAT),
          }));
    }
    return transparentConfiguration;
  }

  draw() {
    let {width, height} = this;
    if (!this.navigationState.valid || width === 0 || height === 0) {
      return;
    }

    if (this.viewer.showSliceViews.value) {
      for (let sliceView of this.sliceViews) {
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

    // Draw fully-opaque layers first.
    for (let renderLayer of visibleLayers) {
      if (!renderLayer.isTransparent) {
        renderLayer.draw(renderContext);
      } else {
        hasTransparent = true;
      }
    }

    if (this.viewer.showSliceViews.value) {
      this.drawSliceViews(renderContext);
    }

    if (this.viewer.showAxisLines.value) {
      this.drawAxisLines();
    }


    if (hasTransparent) {
      // Draw transparent objects.
      gl.depthMask(false);
      gl.enable(gl.BLEND);

      // Compute accumulate and revealage textures.
      const {transparentConfiguration} = this;
      transparentConfiguration.bind(width, height);
      this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderContext.emitter = perspectivePanelEmitOIT;
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      renderContext.emitPickID = false;
      for (let renderLayer of visibleLayers) {
        if (renderLayer.isTransparent) {
          renderLayer.draw(renderContext);
        }
      }

      // Copy transparent rendering result back to primary buffer.
      gl.disable(gl.DEPTH_TEST);
      this.offscreenFramebuffer.bindSingle(OffscreenTextures.COLOR);
      gl.blendFunc(gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA);
      this.transparencyCopyHelper.draw(
          transparentConfiguration.colorBuffers[0].texture,
          transparentConfiguration.colorBuffers[1].texture);

      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);

      // Restore framebuffer attachments.
      this.offscreenFramebuffer.bind(width, height);
    }

    // Do picking only rendering pass.
    gl.WEBGL_draw_buffers.drawBuffersWEBGL([
      gl.NONE, gl.WEBGL_draw_buffers.COLOR_ATTACHMENT1_WEBGL,
      gl.WEBGL_draw_buffers.COLOR_ATTACHMENT2_WEBGL
    ]);
    renderContext.emitter = perspectivePanelEmit;
    renderContext.emitPickID = true;
    renderContext.emitColor = false;
    for (let renderLayer of visibleLayers) {
      renderContext.alreadyEmittedPickID = !renderLayer.isTransparent;
      renderLayer.draw(renderContext);
    }

    gl.disable(gl.DEPTH_TEST);
    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLViewport();
    this.offscreenCopyHelper.draw(
        this.offscreenFramebuffer.colorBuffers[OffscreenTextures.COLOR].texture);
  }

  private drawSliceViews(renderContext: PerspectiveViewRenderContext) {
    let {sliceViewRenderHelper} = this;
    let {lightDirection, ambientLighting, directionalLighting, dataToDevice} = renderContext;

    for (let sliceView of this.sliceViews) {
      let scalar = Math.abs(vec3.dot(lightDirection, sliceView.viewportAxes[2]));
      let factor = ambientLighting + scalar * directionalLighting;
      let mat = tempMat4;
      // Need a matrix that maps (+1, +1, 0) to projectionMat * (width, height, 0)
      mat4.identity(mat);
      mat[0] = sliceView.width / 2.0;
      mat[5] = -sliceView.height / 2.0;
      mat4.multiply(mat, sliceView.viewportToData, mat);
      mat4.multiply(mat, dataToDevice, mat);

      sliceViewRenderHelper.draw(
          sliceView.offscreenFramebuffer.colorBuffers[0].texture, mat,
          vec4.fromValues(factor, factor, factor, 1), vec4.fromValues(0.5, 0.5, 0.5, 1), 0, 0, 1,
          1);
    }
  }

  private drawAxisLines() {
    let {gl} = this;
    let mat = tempMat4;
    mat4.identity(mat);
    // Draw axes lines.
    let axisLength = 200 * 8;

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

    gl.WEBGL_draw_buffers.drawBuffersWEBGL([gl.WEBGL_draw_buffers.COLOR_ATTACHMENT0_WEBGL]);
    this.axesLineHelper.draw(mat, false);
  }

  zoomByMouse(factor: number) {
    this.navigationState.zoomBy(factor);
  }
}
