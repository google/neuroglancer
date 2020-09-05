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

import {FrameNumberCounter} from 'neuroglancer/chunk_manager/frontend';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {vec3, mat4} from 'neuroglancer/util/geom';
import {parseFixedLengthArray, verifyFloat01} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL, initializeWebGL} from 'neuroglancer/webgl/context';
import ResizeObserver from 'resize-observer-polyfill';

export class RenderViewport {
  // Width of visible portion of panel in canvas pixels.
  width: number = 0;

  // Height of visible portion of panel in canvas pixels.
  height: number = 0;

  // Width in canvas pixels, including portions outside of the canvas (i.e. outside the "viewport"
  // window).
  logicalWidth: number = 0;

  // Height in canvas pixels, including portions outside of the canvas (i.e. outside the "viewport"
  // window).
  logicalHeight: number = 0;

  // Left edge of visible region within full (logical) panel, as fraction in [0, 1].
  visibleLeftFraction: number = 0;

  // Top edge of visible region within full (logical) panel, as fraction in [0, 1].
  visibleTopFraction: number = 0;

  // Fraction of logical width that is visible, equal to `widthInCanvasPixels / logicalWidth`.
  visibleWidthFraction: number = 0;

  // Fraction of logical height that is visible, equal to `heightInCanvasPixels / logicalHeight`.
  visibleHeightFraction: number = 0;
}

export function applyRenderViewportToProjectionMatrix(
    viewport: RenderViewport, projectionMatrix: mat4) {
  const xScale = 1 / viewport.visibleWidthFraction;
  const yScale = 1 / viewport.visibleHeightFraction;
  const xOffset = -1 - (-1 + 2 * viewport.visibleLeftFraction) * xScale;
  let yOffset = -1 - (-1 + 2 * viewport.visibleTopFraction) * yScale;
  yOffset = -yOffset;
  projectionMatrix[0] = projectionMatrix[0] * xScale + projectionMatrix[3] * xOffset;
  projectionMatrix[4] = projectionMatrix[4] * xScale + projectionMatrix[7] * xOffset;
  projectionMatrix[8] = projectionMatrix[8] * xScale + projectionMatrix[11] * xOffset;
  projectionMatrix[12] = projectionMatrix[12] * xScale + projectionMatrix[15] * xOffset;

  projectionMatrix[1] = projectionMatrix[1] * yScale + projectionMatrix[3] * yOffset;
  projectionMatrix[5] = projectionMatrix[5] * yScale + projectionMatrix[7] * yOffset;
  projectionMatrix[9] = projectionMatrix[9] * yScale + projectionMatrix[11] * yOffset;
  projectionMatrix[13] = projectionMatrix[13] * yScale + projectionMatrix[15] * yOffset;
}

export function renderViewportsEqual(a: RenderViewport, b: RenderViewport) {
  return a.width === b.width &&
      a.height === b.height && a.logicalWidth === b.logicalWidth &&
      a.logicalHeight === b.logicalHeight && a.visibleLeftFraction === b.visibleLeftFraction &&
      a.visibleTopFraction === b.visibleTopFraction;
}

export abstract class RenderedPanel extends RefCounted {
  gl: GL;

  // Generation used to check whether the following bounds-related fields are up to date.
  boundsGeneration = -1;

  // Offset of visible portion of panel in canvas pixels from left side of canvas.
  canvasRelativeLeft: number = 0;

  // Offset of visible portion of panel in canvas pixels from top of canvas.
  canvasRelativeTop: number = 0;

  renderViewport = new RenderViewport();

  constructor(
      public context: Borrowed<DisplayContext>, public element: HTMLElement,
      public visibility: WatchableVisibilityPriority) {
    super();
    this.gl = context.gl;
    context.addPanel(this);
  }

  scheduleRedraw() {
    if (this.visible) {
      this.context.scheduleRedraw();
    }
  }

  abstract isReady(): boolean;

  ensureBoundsUpdated() {
    const {context} = this;
    context.ensureBoundsUpdated();
    const {boundsGeneration} = context;
    if (boundsGeneration === this.boundsGeneration) return;
    this.boundsGeneration = boundsGeneration;
    const {element} = this;
    const clientRect = element.getBoundingClientRect();
    const canvasRect = context.canvasRect!;
    const {canvas} = context;
    const {width: canvasPixelWidth, height: canvasPixelHeight} = canvas;
    const screenToCanvasPixelScaleX = canvasPixelWidth / canvasRect.width;
    const screenToCanvasPixelScaleY = canvasPixelHeight / canvasRect.height;
    let leftInScreenPixels = element.clientLeft + clientRect.left - canvasRect.left;
    let leftInCanvasPixels = Math.round(leftInScreenPixels * screenToCanvasPixelScaleX);
    let logicalWidthInCanvasPixels = element.clientWidth;
    let topInScreenPixels = clientRect.top - canvasRect.top + element.clientTop;
    let topInCanvasPixels = Math.round(topInScreenPixels * screenToCanvasPixelScaleY);
    let logicalHeightInCanvasPixels = element.clientHeight;
    const canvasRelativeTop = this.canvasRelativeTop = Math.max(0, topInCanvasPixels);
    const canvasRelativeLeft = this.canvasRelativeLeft = Math.max(0, leftInCanvasPixels);
    const viewport = this.renderViewport;
    viewport.logicalWidth = logicalWidthInCanvasPixels;
    viewport.logicalHeight = logicalHeightInCanvasPixels;
    const canvasRelativeWidth = viewport.width = Math.max(
        0,
        Math.min(leftInCanvasPixels + logicalWidthInCanvasPixels, canvasPixelWidth) -
            canvasRelativeLeft);
    const canvasRelativeHeight = viewport.height = Math.max(
        0,
        Math.min(topInCanvasPixels + logicalHeightInCanvasPixels, canvasPixelHeight) -
            canvasRelativeTop);
    viewport.visibleLeftFraction =
        (canvasRelativeLeft - leftInCanvasPixels) / logicalWidthInCanvasPixels;
    viewport.visibleTopFraction =
        (canvasRelativeTop - topInCanvasPixels) / logicalHeightInCanvasPixels;
    viewport.visibleWidthFraction = canvasRelativeWidth / logicalWidthInCanvasPixels;
    viewport.visibleHeightFraction = canvasRelativeHeight / logicalHeightInCanvasPixels;
  }

  setGLViewport() {
    const {
      gl,
      canvasRelativeTop,
      canvasRelativeLeft,
      renderViewport: {width, height}
    } = this;
    const bottom = canvasRelativeTop + height;
    gl.enable(WebGL2RenderingContext.SCISSOR_TEST);
    let glBottom = this.context.canvas.height - bottom;
    gl.viewport(canvasRelativeLeft, glBottom, width, height);
    gl.scissor(canvasRelativeLeft, glBottom, width, height);
  }

  abstract draw(): void;

  abstract translateDataPointByViewportPixels(
      out: vec3, orig: vec3, deltaX: number, deltaY: number): vec3;

  disposed() {
    this.context.removePanel(this);
    super.disposed();
  }

  get visible() {
    return this.visibility.visible;
  }

  getDepthArray(): Float32Array|undefined {
    return undefined;
  }

  get shouldDraw() {
    if (!this.visible) return false;
    const {element} = this;
    if (element.clientWidth === 0 || element.clientHeight === 0 || element.offsetWidth === 0 ||
        element.offsetHeight === 0) {
      // Skip drawing if the panel has zero client area.
      return false;
    }
    return true;
  }
}

// Specifies a rectangular sub-region of the full viewer area to actually be rendered on the canvas.
// This is used by the Python integration to produce large screenshots by tiling multiple
// screenshots.
//
// The value is: `[left, top, width, height]` where all values are in [0, 1].
export class TrackableWindowedViewport extends TrackableValue<Float64Array> {
  constructor() {
    super(
        Float64Array.of(0, 0, 1, 1),
        obj => parseFixedLengthArray(new Float64Array(4), obj, verifyFloat01));
  }
  toJSON() {
    return Array.from(this.value);
  }
}

export class DisplayContext extends RefCounted implements FrameNumberCounter {
  canvas = document.createElement('canvas');
  gl: GL;
  updateStarted = new NullarySignal();
  updateFinished = new NullarySignal();
  changed = this.updateFinished;
  panels = new Set<RenderedPanel>();
  canvasRect: ClientRect|undefined;
  resizeGeneration = 0;
  boundsGeneration = -1;

  /**
   * Unique number of the next frame.  Incremented once each time a frame is drawn.
   */
  frameNumber = 0;

  private resizeObserver = new ResizeObserver(() => {
    ++this.resizeGeneration;
    this.scheduleRedraw();
  });

  constructor(public container: HTMLElement) {
    super();
    const {canvas, resizeObserver} = this;
    container.style.position = 'relative';
    canvas.style.position = 'absolute';
    canvas.style.top = '0px';
    canvas.style.left = '0px';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '0';
    resizeObserver.observe(canvas);
    container.appendChild(canvas);
    this.registerEventListener(canvas, 'webglcontextlost', (event: WebGLContextEvent) => {
      console.log(`Lost WebGL context: ${event.statusMessage}`);
      // Wait for context to be regained.
      event.preventDefault();
    });
    this.registerEventListener(canvas, 'webglcontextrestored', () => {
      console.log('WebGL context restored');
      // Simply reload Neuroglancer.
      window.location.reload();
    });
    this.gl = initializeWebGL(canvas);
  }

  applyWindowedViewportToElement(element: HTMLElement, value: Float64Array) {
    // These values specify the position of the canvas relative to the viewer.  However, we will
    // actually leave the canvas in place (such that it still fills the browser window) and move
    // the viewer.
    const [left, top, width, height] = value;
    const totalWidth = 1 / width;
    const totalHeight = 1 / height;
    element.style.position = 'absolute';
    element.style.top = `${- totalHeight * top * 100}%`;
    element.style.left = `${- totalWidth * left * 100}%`;
    element.style.width = `${totalWidth * 100}%`;
    element.style.height = `${totalHeight * 100}%`;
    ++this.resizeGeneration;
    this.scheduleRedraw();
  }

  isReady() {
    for (const panel of this.panels) {
      if (!panel.visible) {
        continue;
      }
      if (!panel.isReady()) {
        return false;
      }
    }
    return true;
  }

  /**
   * Returns a child element that overlays the canvas.
   */
  makeCanvasOverlayElement() {
    const element = document.createElement('div');
    element.style.position = 'absolute';
    element.style.top = '0px';
    element.style.left = '0px';
    element.style.width = '100%';
    element.style.height = '100%';
    element.style.zIndex = '2';
    this.container.appendChild(element);
    return element;
  }

  disposed() {
    this.resizeObserver.disconnect();
  }

  addPanel(panel: Borrowed<RenderedPanel>) {
    this.panels.add(panel);
    this.resizeObserver.observe(panel.element);
    ++this.resizeGeneration;
    this.scheduleRedraw();
  }

  removePanel(panel: Borrowed<RenderedPanel>) {
    this.resizeObserver.unobserve(panel.element);
    this.panels.delete(panel);
    ++this.resizeGeneration;
    this.scheduleRedraw();
  }

  readonly scheduleRedraw = this.registerCancellable(animationFrameDebounce(() => this.draw()));

  ensureBoundsUpdated() {
    const {resizeGeneration} = this;
    if (this.boundsGeneration === resizeGeneration) return;
    const {canvas} = this;
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    this.canvasRect = canvas.getBoundingClientRect();
    this.boundsGeneration = resizeGeneration;
  }

  draw() {
    ++this.frameNumber;
    this.updateStarted.dispatch();
    let gl = this.gl;
    this.ensureBoundsUpdated();
    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (let panel of this.panels) {
      if (!panel.shouldDraw) continue;
      panel.ensureBoundsUpdated();
      panel.setGLViewport();
      panel.draw();
    }

    // Ensure the alpha buffer is set to 1.
    gl.disable(gl.SCISSOR_TEST);
    this.gl.clearColor(1.0, 1.0, 1.0, 1.0);
    this.gl.colorMask(false, false, false, true);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.gl.colorMask(true, true, true, true);
    this.updateFinished.dispatch();
  }

  getDepthArray(): Float32Array {
    const {width, height} = this.canvas;
    const depthArray = new Float32Array(width * height);
    for (const panel of this.panels) {
      if (!panel.shouldDraw) continue;
      const panelDepthArray = panel.getDepthArray();
      if (panelDepthArray === undefined) continue;
      const {canvasRelativeTop, canvasRelativeLeft, renderViewport: {width, height}} = panel;
      for (let y = 0; y < height; ++y) {
        const panelDepthArrayOffset = (height - 1 - y) * width;
        depthArray.set(
            panelDepthArray.subarray(panelDepthArrayOffset, panelDepthArrayOffset + width),
            (canvasRelativeTop + y) * width + canvasRelativeLeft);
      }
    }
    return depthArray;
  }
}
