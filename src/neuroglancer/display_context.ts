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
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL, initializeWebGL} from 'neuroglancer/webgl/context';

export abstract class RenderedPanel extends RefCounted {
  gl: GL;
  constructor(
      public context: DisplayContext, public element: HTMLElement,
      public visibility: WatchableVisibilityPriority) {
    super();
    this.gl = context.gl;
    this.registerEventListener(element, 'mouseenter', (_event: MouseEvent) => {
      this.context.setActivePanel(this);
    });
    context.addPanel(this);
  }

  scheduleRedraw() {
    this.context.scheduleRedraw();
  }

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

  onKeyCommand(_action: string) {
    return false;
  }

  abstract draw(): void;

  disposed() {
    this.context.removePanel(this);
    super.disposed();
  }

  get visible() {
    return this.visibility.visible;
  }
}

export class DisplayContext extends RefCounted {
  canvas = document.createElement('canvas');
  gl: GL;
  updateStarted = new NullarySignal();
  updateFinished = new NullarySignal();
  panels = new Set<RenderedPanel>();
  activePanel: RenderedPanel|null = null;
  private updatePending: number|null = null;
  private needsRedraw = false;

  constructor(public container: HTMLElement) {
    super();
    let {canvas} = this;
    canvas.className = 'gl-canvas';
    container.appendChild(canvas);
    this.gl = initializeWebGL(canvas);
    this.registerEventListener(window, 'resize', this.onResize.bind(this));
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
        if (!panel.visible || element.clientWidth === 0 || element.clientHeight === 0 ||
            element.offsetWidth === 0 || element.offsetHeight === 0) {
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
}
