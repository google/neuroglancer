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

import {RefCounted} from 'neuroglancer/util/disposable';
import {NullarySignal} from 'neuroglancer/util/signal';
import {GL, initializeWebGL} from 'neuroglancer/webgl/context';
import { addInfo, addButton, removeButton, addError, } from 'neuroglancer/webvr-util'

export abstract class RenderedPanel extends RefCounted {
  gl: GL;
  displayContext: DisplayContext;
  constructor(public context: DisplayContext, public element: HTMLElement) {
    super();
    this.gl = context.gl;
    this.displayContext = context;
    this.registerEventListener(
      element, 'mouseenter', (_event: MouseEvent) => { this.context.setActivePanel(this); });
    context.addPanel(this);
  }

  scheduleRedraw() { this.context.scheduleRedraw(); }

  setGLViewport() {
    let element = this.element;
    let left = element.offsetLeft + element.clientLeft;
    let width = element.clientWidth;
    let top = element.offsetTop + element.clientTop;
    let height = element.clientHeight;
    let bottom = top + height;
    let gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    let glBottom = this.context.canvas.height - bottom;
    gl.viewport(left, glBottom, width, height);
    gl.scissor(left, glBottom, width, height);
  }

  abstract onResize(): void;

  onKeyCommand(_action: string) { return false; }

  abstract draw(): void;

  disposed() {
    this.context.removePanel(this);
    super.disposed();
  }
};

export class DisplayContext extends RefCounted {
  canvas = document.createElement('canvas');
  frameData: VRFrameData;
  animationId: number;
  gl: GL;
  vrDisplay: VRDisplay;
  vrPresentButton: any;
  vrResetPoseButton: any;
  updateStarted = new NullarySignal();
  updateFinished = new NullarySignal();
  panels = new Set<RenderedPanel>();
  activePanel: RenderedPanel | null = null;
  changed = new NullarySignal();
  private updatePending: number | null = null;
  private needsRedraw = false;

  constructor(public container: HTMLElement) {
    super();
    var that = this;
    this.setupVR(that);
    let {canvas} = this;
    canvas.className = 'gl-canvas';
    container.appendChild(canvas);
    this.gl = initializeWebGL(canvas);
    this.registerEventListener(window, 'resize', this.onResize.bind(this));
    this.registerDisposer(this.changed.add(() => { this.scheduleRedraw(); }));
  }

  setupVR(that: DisplayContext) {
    if (navigator.getVRDisplays) {
      this.frameData = new VRFrameData();
      navigator.getVRDisplays().then(function (displays: VRDisplay[]) {
        if (displays.length > 0) {
          that.vrDisplay = displays[0];

          // It's heighly reccommended that you set the near and far planes to
          // something appropriate for your scene so the projection matricies
          // WebVR produces have a well scaled depth buffer.
          //that.vrDisplay.depthNear = 0.1;
          that.vrDisplay.depthNear = 0.1;
          that.vrDisplay.depthFar = 5000.0;
          let leftEye: VREyeParameters = that.vrDisplay.getEyeParameters('left');
          let rightEye: VREyeParameters = that.vrDisplay.getEyeParameters('right');
          // The UA may kick us out of VR present mode for any reason, so to
          // ensure we always know when we begin/end presenting we need to
          // listen for vrdisplaypresentchange events.
          window.addEventListener('vrdisplaypresentchange', that.onVRPresentChange.bind(that), false);

          // These events fire when the user agent has had some indication that
          // it would be appropariate to enter or exit VR presentation mode, such
          // as the user putting on a headset and triggering a proximity sensor.
          // You can inspect the `reason` property of the event to learn why the
          // event was fired, but in this case we're going to always trust the
          // event and enter or exit VR presentation mode when asked.
          window.addEventListener('vrdisplayactivate', that.onVRRequestPresent.bind(that), false);
          window.addEventListener('vrdisplaydeactivate', that.onVRExitPresent.bind(that), false);
        } else {
          addInfo("WebVR supported, but no VRDisplays found.", 3000);
        }
      });
    } else {
      addError("Your browser does not support WebVR. See <a href='http://webvr.info'>webvr.info</a> for assistance.", 3000);
    }
  }

  onVRRequestPresent() {
    var that = this;
    this.vrDisplay.requestPresent([{ source: this.canvas }]).then(function () {
      that.animationId = window.requestAnimationFrame(that.onAnimationFrame.bind(that));
    }, function () {
      addError("requestPresent failed.", 3000);
    });
  }

  onVRPresentChange() {
    // When we begin or end presenting, the canvas should be resized to the
    // recommended dimensions for the display.
    this.onResize();

    if (this.vrDisplay.isPresenting) {
      if (this.vrDisplay.capabilities.hasExternalDisplay) {
        removeButton(this.vrPresentButton);
        this.vrPresentButton = addButton("Exit VR", "E", null, this.onVRExitPresent.bind(this));
      }
    } else {
      if (this.vrDisplay.capabilities.hasExternalDisplay) {
        removeButton(this.vrPresentButton);
        this.vrPresentButton = addButton("Enter VR<br>(Experience is not perfectly calibrated<br>and might cause user discomfort)", "E", null, this.onVRRequestPresent.bind(this));
      }
    }
  }

  onAnimationFrame() {
    if (this.animationId) {
      if (this.vrDisplay) {
        // When presenting content to the VRDisplay we want to update at its
        // refresh rate if it differs from the refresh rate of the main
        // display. Calling VRDisplay.requestAnimationFrame ensures we render
        // at the right speed for VR.
        this.vrDisplay.requestAnimationFrame(this.onAnimationFrame.bind(this));
        this.changed.dispatch();
        if (this.vrDisplay.isPresenting) {
          // If we're currently presenting to the VRDisplay we need to
          // explicitly indicate we're done rendering.
          this.update();
          this.vrDisplay.submitFrame();
        } else {
          this.update();
        }
      } else {
        window.requestAnimationFrame(this.onAnimationFrame.bind(this));
      }
    }
  }

  onVRExitPresent() {
    if (!this.vrDisplay.isPresenting)
      return;
    var that = this;
    this.vrDisplay.exitPresent().then(function () {
      window.cancelAnimationFrame(that.animationId);
      that.animationId = 0;
      return;
    }, function () {
      addError("exitPresent failed.", 2000);
    });
  }

  disposed() {
    if (this.updatePending != null) {
      cancelAnimationFrame(this.updatePending);
      this.updatePending = null;
    }
  }

  addPanel(panel: RenderedPanel) {
    this.panels.add(panel);
    if (this.activePanel == null) {
      this.setActivePanel(panel);
    }
  }

  setActivePanel(panel: RenderedPanel|null) {
    let existingPanel = this.activePanel;
    if (existingPanel != null) {
      existingPanel.element.attributes.removeNamedItem('isActivePanel');
    }
    if (panel != null) {
      panel.element.setAttribute('isActivePanel', 'true');
    }
    this.activePanel = panel;
  }

  removePanel(panel: RenderedPanel) {
    this.panels.delete(panel);
    if (panel === this.activePanel) {
      this.setActivePanel(null);
    }
    panel.dispose();
  }

  onResize() {
    this.scheduleRedraw();
    for (let panel of this.panels) {
      panel.onResize();
    }
  }

  scheduleUpdate() {
    if (this.updatePending === null) {
      this.updatePending = requestAnimationFrame(this.update.bind(this));
    }
  }

  scheduleRedraw() {
    if (!this.needsRedraw) {
      this.needsRedraw = true;
      this.scheduleUpdate();
    }
  }

  private update() {
    this.updatePending = null;
    this.updateStarted.dispatch();
    if (this.needsRedraw) {
      this.needsRedraw = false;
      let gl = this.gl;
      let canvas = this.canvas;
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      for (let panel of this.panels) {
        let {element} = panel;
        if (element.clientWidth === 0 || element.clientHeight === 0) {
          // Skip drawing if the panel has zero client area.
          continue;
        }
        panel.setGLViewport();
        panel.draw();
      }

      // Ensure the alpha buffer is set to 1.
      gl.disable(gl.SCISSOR_TEST);
      this.gl.clearColor(1.0, 1.0, 1.0, 1.0);
      this.gl.colorMask(false, false, false, true);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.gl.colorMask(true, true, true, true);
    }
    this.updateFinished.dispatch();
  }
};
