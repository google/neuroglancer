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
import {RenderLayer} from 'neuroglancer/layer';
import {MouseSelectionState, VisibleRenderLayerTracker} from 'neuroglancer/layer';
import {PickIDManager} from 'neuroglancer/object_picking';
import {RenderedDataPanel} from 'neuroglancer/rendered_data_panel';
import {SliceView, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {Mat4, Vec3, kAxes, mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {ViewerState} from 'neuroglancer/viewer_state';
import {OffscreenCopyHelper, OffscreenFramebuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {glsl_packFloat01ToFixedPoint, unpackFloat01FromFixedPoint} from 'neuroglancer/webgl/shader_lib';

require('neuroglancer/noselect.css');
require('./perspective_panel.css');

export interface PerspectiveViewRenderContext {
  dataToDevice: Mat4;
  lightDirection: Vec3;
  ambientLighting: number;
  directionalLighting: number;
  pickIDs: PickIDManager;
}

export class PerspectiveViewRenderLayer extends RenderLayer {
  draw(renderContext: PerspectiveViewRenderContext) {
    // Must be overridden by subclasses.
  }

  drawPicking(renderContext: PerspectiveViewRenderContext) {
    // Do nothing by default.
  }
};

export interface PerspectiveViewerState extends ViewerState { showSliceViews: TrackableBoolean; }

export enum OffscreenTextures {
  COLOR,
  Z,
  PICK,
  NUM_TEXTURES
}

export const glsl_perspectivePanelEmit = [
  glsl_packFloat01ToFixedPoint, `
void emit(vec4 color, vec4 pickId) {
  gl_FragData[${OffscreenTextures.COLOR}] = color;
  gl_FragData[${OffscreenTextures.Z}] = packFloat01ToFixedPoint(1.0 - gl_FragCoord.z);
  gl_FragData[${OffscreenTextures.PICK}] = pickId;
}
`
];

export function perspectivePanelEmit(builder: ShaderBuilder) {
  builder.addFragmentExtension('GL_EXT_draw_buffers');
  builder.addFragmentCode(glsl_perspectivePanelEmit);
}

const tempVec3 = vec3.create();
const tempMat4 = mat4.create();

export class PerspectivePanel extends RenderedDataPanel {
  private visibleLayerTracker =
      this.registerDisposer(new VisibleRenderLayerTracker<PerspectiveViewRenderLayer>(
          this.viewer.layerManager, PerspectiveViewRenderLayer,
          layer => {
            layer.redrawNeeded.add(this.scheduleRedraw, this);
            this.scheduleRedraw();
          },
          layer => {
            layer.redrawNeeded.remove(this.scheduleRedraw, this);
            this.scheduleRedraw();
          }));

  sliceViews = new Set<SliceView>();
  projectionMat = mat4.create();
  viewer: PerspectiveViewerState;
  inverseProjectionMat = mat4.create();
  modelViewMat = mat4.create();
  width = 0;
  height = 0;
  private pickIDs = new PickIDManager();
  private axesLineHelper = this.registerDisposer(AxesLineHelper.get(this.gl));
  sliceViewRenderHelper = this.registerDisposer(SliceViewRenderHelper.get(
      this.gl, 'SliceViewRenderHelper:PerspectivePanel', perspectivePanelEmit));

  private offscreenFramebuffer = new OffscreenFramebuffer(
      this.gl,
      {numDataBuffers: OffscreenTextures.NUM_TEXTURES, depthBuffer: true, stencilBuffer: true});

  private offscreenCopyHelper = OffscreenCopyHelper.get(this.gl);

  constructor(context: DisplayContext, element: HTMLElement, viewer: PerspectiveViewerState) {
    super(context, element, viewer);
    this.registerSignalBinding(this.navigationState.changed.add(() => { this.viewportChanged(); }));

    let showSliceViewsCheckbox =
        this.registerDisposer(new TrackableBooleanCheckbox(viewer.showSliceViews));
    showSliceViewsCheckbox.element.className = 'perspective-panel-show-slice-views noselect';
    let showSliceViewsLabel = document.createElement('label');
    showSliceViewsLabel.className = 'perspective-panel-show-slice-views noselect';
    showSliceViewsLabel.appendChild(document.createTextNode('Slices'));
    showSliceViewsLabel.appendChild(showSliceViewsCheckbox.element);
    this.element.appendChild(showSliceViewsLabel);
    this.registerSignalBinding(viewer.showSliceViews.changed.add(() => { this.scheduleRedraw(); }));
    this.registerSignalBinding(viewer.showAxisLines.changed.add(() => { this.scheduleRedraw(); }));
  }
  get navigationState() { return this.viewer.navigationState; }

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

  viewportChanged() { this.context.scheduleRedraw(); }

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

  onMousedown(e: MouseEvent) {
    if (e.target !== this.element) {
      return;
    }
    super.onMousedown(e);
    if (!this.navigationState.valid) {
      return;
    }
    if (e.button === 0) {
      startRelativeMouseDrag(e, (event, deltaX, deltaY) => {
        this.navigationState.pose.rotateRelative(kAxes[1], -deltaX / 4.0 * Math.PI / 180.0);
        this.navigationState.pose.rotateRelative(kAxes[0], deltaY / 4.0 * Math.PI / 180.0);
        this.viewer.navigationState.changed.dispatch();
      });
    }
  }
  draw() {
    let {width, height} = this;
    if (!this.navigationState.valid || width === 0 || height === 0) {
      return;
    }

    for (let sliceView of this.sliceViews) {
      sliceView.updateRendering();
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
    let lightingDirection = vec4.create();
    vec4.transformMat4(lightingDirection, kAxes[2], this.modelViewMat);
    vec4.normalize(lightingDirection, lightingDirection);

    let ambient = 0.2;
    let directional = 1 - ambient;

    let pickIDs = this.pickIDs;
    pickIDs.clear();
    let renderContext = {
      dataToDevice: projectionMat,
      lightDirection: lightingDirection.subarray(0, 3),
      ambientLighting: ambient,
      directionalLighting: directional,
      pickIDs: pickIDs
    };

    let visibleLayers = this.visibleLayerTracker.getVisibleLayers();

    for (let renderLayer of visibleLayers) {
      renderLayer.draw(renderContext);
    }

    if (this.viewer.showSliceViews.value) {
      let {sliceViewRenderHelper} = this;

      for (let sliceView of this.sliceViews) {
        let scalar = Math.abs(vec3.dot(lightingDirection, sliceView.viewportAxes[2]));
        let factor = ambient + scalar * directional;
        let mat = tempMat4;
        // Need a matrix that maps (+1, +1, 0) to projectionMat * (width, height, 0)
        mat4.identity(mat);
        mat[0] = sliceView.width / 2.0;
        mat[5] = -sliceView.height / 2.0;
        mat4.multiply(mat, sliceView.viewportToData, mat);
        mat4.multiply(mat, projectionMat, mat);

        sliceViewRenderHelper.draw(
            sliceView.offscreenFramebuffer.dataTextures[0], mat,
            vec4.fromValues(factor, factor, factor, 1), vec4.fromValues(0.5, 0.5, 0.5, 1), 0, 0, 1,
            1);
      }
    }

    if (this.viewer.showAxisLines.value) {
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
      mat4.multiply(mat, projectionMat, mat);

      gl.WEBGL_draw_buffers.drawBuffersWEBGL([gl.WEBGL_draw_buffers.COLOR_ATTACHMENT0_WEBGL]);
      this.axesLineHelper.draw(mat, false);
    }

    // Do picking only rendering pass.
    gl.WEBGL_draw_buffers.drawBuffersWEBGL([
      gl.NONE, gl.WEBGL_draw_buffers.COLOR_ATTACHMENT1_WEBGL,
      gl.WEBGL_draw_buffers.COLOR_ATTACHMENT2_WEBGL
    ]);

    for (let renderLayer of visibleLayers) {
      renderLayer.drawPicking(renderContext);
    }

    gl.disable(gl.DEPTH_TEST);
    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLViewport();
    this.offscreenCopyHelper.draw(this.offscreenFramebuffer.dataTextures[OffscreenTextures.COLOR]);
  }

  zoomByMouse(factor: number) { this.navigationState.zoomBy(factor); }
};
