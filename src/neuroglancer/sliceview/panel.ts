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
import {MouseSelectionState, VisibleRenderLayerTracker, RenderLayer} from 'neuroglancer/layer';
import {RenderedDataPanel} from 'neuroglancer/rendered_data_panel';
import {PickIDManager} from 'neuroglancer/object_picking';
import {SliceView, SliceViewRenderHelper} from 'neuroglancer/sliceview/frontend';
import {mat4, vec3, vec4, Mat4, AXES_NAMES, identityMat4} from 'neuroglancer/util/geom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {ViewerState} from 'neuroglancer/viewer_state';
import {OffscreenFramebuffer, OffscreenCopyHelper} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {Signal} from 'signals';

const keyCommands = new Map<string, (this: SliceViewPanel) => void>();

for (let axis = 0; axis < 3; ++axis) {
  let axisName = AXES_NAMES[axis];
  for (let sign of [-1, +1]) {
    let signStr = (sign < 0) ? '-' : '+';
    keyCommands.set(`rotate-relative-${axisName}${signStr}`, function() {
      let panel: SliceViewPanel = this;
      let {sliceView} = panel;
      if (!sliceView.hasViewportToData) {
        return;
      }
      let {navigationState} = panel.viewer;
      navigationState.pose.rotateAbsolute(sliceView.viewportAxes[axis], sign * 0.1);
    });
    let tempOffset = vec3.create();
    keyCommands.set(`${axisName}${signStr}`, function() {
      let panel: SliceViewPanel = this;
      let {sliceView} = panel;
      if (!sliceView.hasViewportToData) {
        return;
      }
      let {navigationState} = panel.viewer;
      let offset = tempOffset;
      vec3.multiply(offset, navigationState.voxelSize.size, sliceView.viewportAxes[axis]);
      vec3.scale(offset, offset, sign);
      navigationState.pose.translateAbsolute(offset);
    });
  }
}
keyCommands.set('zoom-in', function() {
  let panel: SliceViewPanel = this;
  let {navigationState} = panel.viewer;
  navigationState.zoomBy(0.5);
});
keyCommands.set('zoom-out', function() {
  let panel: SliceViewPanel = this;
  let {navigationState} = panel.viewer;
  navigationState.zoomBy(2.0);
});

export enum OffscreenTextures {
  COLOR,
  PICK,
  NUM_TEXTURES
}

export function sliceViewPanelEmit(builder: ShaderBuilder) {
  builder.addFragmentExtension('GL_EXT_draw_buffers');
  builder.addFragmentCode(`
void emit(vec4 color, vec4 pickId) {
  gl_FragData[${OffscreenTextures.COLOR}] = color;
  gl_FragData[${OffscreenTextures.PICK}] = pickId;
}
`);
}

export interface SliceViewPanelRenderContext {
  dataToDevice: Mat4;
  pickIDs: PickIDManager;
}

export class SliceViewPanelRenderLayer extends RenderLayer {
  redrawNeeded = new Signal();
  draw(renderContext: SliceViewPanelRenderContext) {
    // Must be overriden by subclass.
  }
};

export class SliceViewPanel extends RenderedDataPanel {
  private axesLineHelper = AxesLineHelper.get(this.gl);
  private sliceViewRenderHelper =
      SliceViewRenderHelper.get(this.gl, 'SliceViewRenderHelper', sliceViewPanelEmit);
  private colorFactor = vec4.fromValues(1, 1, 1, 1);
  private backgroundColor = vec4.fromValues(0.5, 0.5, 0.5, 1.0);
  private pickIDs = new PickIDManager();

  private visibleLayerTracker =
      this.registerDisposer(new VisibleRenderLayerTracker<SliceViewPanelRenderLayer>(
          this.viewer.layerManager, SliceViewPanelRenderLayer,
          layer => {
            layer.redrawNeeded.add(this.scheduleRedraw, this);
            this.scheduleRedraw();
          },
          layer => {
            layer.redrawNeeded.remove(this.scheduleRedraw, this);
            this.scheduleRedraw();
          }));

  private offscreenFramebuffer =
      new OffscreenFramebuffer(this.gl, {numDataBuffers: OffscreenTextures.NUM_TEXTURES});

  private offscreenCopyHelper = OffscreenCopyHelper.get(this.gl);

  constructor(
      context: DisplayContext, element: HTMLElement, public sliceView: SliceView,
      viewer: ViewerState) {
    super(context, element, viewer);

    this.registerSignalBinding(sliceView.viewChanged.add(context.scheduleRedraw, context));
    this.registerSignalBinding(viewer.showAxisLines.changed.add(() => { this.scheduleRedraw(); }));
  }

  onKeyCommand(action: string) {
    let command = keyCommands.get(action);
    if (command) {
      command.call(this);
      return true;
    }
    return false;
  }

  draw() {
    let {sliceView} = this;
    if (!sliceView.hasValidViewport) {
      return;
    }
    sliceView.updateRendering();

    let {gl} = this;

    let {width, height, dataToDevice} = sliceView;
    this.offscreenFramebuffer.bind(width, height);
    gl.disable(gl.SCISSOR_TEST);
    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Draw axes lines.
    // FIXME: avoid use of temporary matrix
    let mat = mat4.create();

    this.sliceViewRenderHelper.draw(
        sliceView.offscreenFramebuffer.dataTextures[0], identityMat4, this.colorFactor,
        this.backgroundColor, 0, 0, 1, 1);

    let visibleLayers = this.visibleLayerTracker.getVisibleLayers();
    let {pickIDs} = this;
    pickIDs.clear();
    let renderContext = {dataToDevice: sliceView.dataToDevice, pickIDs: pickIDs};

    for (let renderLayer of visibleLayers) {
      renderLayer.draw(renderContext);
    }

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
      gl.WEBGL_draw_buffers.drawBuffersWEBGL([gl.WEBGL_draw_buffers.COLOR_ATTACHMENT0_WEBGL]);
      this.axesLineHelper.draw(mat);
    }

    this.offscreenFramebuffer.unbind();

    // Draw the texture over the whole viewport.
    this.setGLViewport();
    this.offscreenCopyHelper.draw(this.offscreenFramebuffer.dataTextures[OffscreenTextures.COLOR]);
  }

  onResize() {
    this.sliceView.setViewportSize(this.element.clientWidth, this.element.clientHeight);
  }

  updateMouseState(mouseState: MouseSelectionState) {
    mouseState.pickedRenderLayer = null;
    let sliceView = this.sliceView;
    if (!sliceView.hasValidViewport) {
      return false;
    }
    let {width, height} = sliceView;
    let {offscreenFramebuffer} = this;
    if (!offscreenFramebuffer.hasSize(width, height)) {
      return false;
    }
    let out = mouseState.position;
    let glWindowX = this.mouseX;
    let y = this.mouseY;
    vec3.set(out, glWindowX - width / 2, y - height / 2, 0);
    vec3.transformMat4(out, out, sliceView.viewportToData);

    let glWindowY = height - y;
    this.pickIDs.setMouseState(
        mouseState,
        offscreenFramebuffer.readPixelAsUint32(OffscreenTextures.PICK, glWindowX, glWindowY));
    return true;
  }

  onMousedown(e: MouseEvent) {
    if (event.target !== this.element) {
      return;
    }
    super.onMousedown(e);
    if (!this.sliceView.hasValidViewport) {
      return;
    }
    if (e.button === 0) {
      startRelativeMouseDrag(e, (event, deltaX, deltaY) => {
        let {position} = this.viewer.navigationState;
        if (event.shiftKey) {
          let {viewportAxes} = this.sliceView;
          this.viewer.navigationState.pose.rotateAbsolute(
              viewportAxes[1], deltaX / 4.0 * Math.PI / 180.0);
          this.viewer.navigationState.pose.rotateAbsolute(
              viewportAxes[0], deltaY / 4.0 * Math.PI / 180.0);
        } else {
          let pos = position.spatialCoordinates;
          vec3.set(pos, deltaX, deltaY, 0);
          vec3.transformMat4(pos, pos, this.sliceView.viewportToData);
          position.changed.dispatch();
        }
      });
    }
  }
};
