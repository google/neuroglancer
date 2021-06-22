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
import {mat4} from 'neuroglancer/util/geom';
import {parseFixedLengthArray, verifyFloat01} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL, initializeWebGL} from 'neuroglancer/webgl/context';

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
  canvasRelativeClippedLeft: number = 0;

  // Offset of visible portion of panel in canvas pixels from top of canvas.
  canvasRelativeClippedTop: number = 0;

  canvasRelativeLogicalLeft: number = 0;
  canvasRelativeLogicalTop: number = 0;

  renderViewport = new RenderViewport();

  private boundsObserversRegistered = false;

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
    if (!this.boundsObserversRegistered && context.monitorPanel(element)) {
      this.boundsObserversRegistered = true;
    }
    const clientRect = element.getBoundingClientRect();
    const root = context.container;
    const canvasRect = context.canvasRect!;
    const {canvas} = context;
    const {width: canvasPixelWidth, height: canvasPixelHeight} = canvas;
    const screenToCanvasPixelScaleX = canvasPixelWidth / canvasRect.width;
    const screenToCanvasPixelScaleY = canvasPixelHeight / canvasRect.height;
    // Logical bounding rectangle in canvas/WebGL pixels (which may be a different size than screen
    // pixels when using a fixed canvas size via the Python integration).
    const canvasLeft = canvasRect.left, canvasTop = canvasRect.top;
    let logicalLeft = this.canvasRelativeLogicalLeft = Math.round(
            (clientRect.left - canvasLeft) * screenToCanvasPixelScaleX + element.clientLeft),
        logicalTop = this.canvasRelativeLogicalTop = Math.round(
            (clientRect.top - canvasTop) * screenToCanvasPixelScaleY + element.clientTop),
        logicalWidth = element.clientWidth, logicalHeight = element.clientHeight,
        logicalRight = logicalLeft + logicalWidth, logicalBottom = logicalTop + logicalHeight;
    // Clipped bounding rectangle in canvas/WebGL pixels.  The clipped bounding rectangle is the
    // portion actually visible and overlapping the canvas.
    let clippedTop = logicalTop, clippedLeft = logicalLeft, clippedRight = logicalRight,
        clippedBottom = logicalBottom;
    for (let parent = element.parentElement; parent !== null && parent !== root;
         parent = parent.parentElement) {
      const rect = parent.getBoundingClientRect();
      if (rect.x === 0 && rect.y === 0 && rect.width === 0 && rect.height === 0) {
        // Assume this is a `display: contents;` element.
        continue;
      }
      clippedLeft = Math.max(clippedLeft, (rect.left - canvasLeft) * screenToCanvasPixelScaleX);
      clippedTop = Math.max(clippedTop, (rect.top - canvasTop) * screenToCanvasPixelScaleY);
      clippedRight = Math.min(clippedRight, (rect.right - canvasLeft) * screenToCanvasPixelScaleX);
      clippedBottom =
          Math.min(clippedBottom, (rect.bottom - canvasTop) * screenToCanvasPixelScaleY);
    }
    clippedTop = this.canvasRelativeClippedTop = Math.round(Math.max(clippedTop, 0));
    clippedLeft = this.canvasRelativeClippedLeft = Math.round(Math.max(clippedLeft, 0));
    clippedRight = Math.round(Math.min(clippedRight, canvasPixelWidth));
    clippedBottom = Math.round(Math.min(clippedBottom, canvasPixelHeight));
    const viewport = this.renderViewport;
    const clippedWidth = viewport.width = Math.max(0, clippedRight - clippedLeft);
    const clippedHeight = viewport.height = Math.max(0, clippedBottom - clippedTop);
    viewport.logicalWidth = logicalWidth;
    viewport.logicalHeight = logicalHeight;
    viewport.visibleLeftFraction = (clippedLeft - logicalLeft) / logicalWidth;
    viewport.visibleTopFraction = (clippedTop - logicalTop) / logicalHeight;
    viewport.visibleWidthFraction = clippedWidth / logicalWidth;
    viewport.visibleHeightFraction = clippedHeight / logicalHeight;
  }

  // Sets the viewport to the clipped viewport.  Any drawing must take
  // `visible{Left,Top,Width,Height}Fraction` into account.  setGLClippedViewport() {
  setGLClippedViewport() {
    const {gl, canvasRelativeClippedTop, canvasRelativeClippedLeft, renderViewport: {width, height}} = this;
    const bottom = canvasRelativeClippedTop + height;
    gl.enable(WebGL2RenderingContext.SCISSOR_TEST);
    let glBottom = this.context.canvas.height - bottom;
    gl.viewport(canvasRelativeClippedLeft, glBottom, width, height);
    gl.scissor(canvasRelativeClippedLeft, glBottom, width, height);
  }

  // Sets the viewport to the logical viewport, using the scissor test to constrain drawing to the
  // clipped viewport.  Drawing does not need to take `visible{Left,Top,Width,Height}Fraction` into
  // account.
  setGLLogicalViewport() {
    const {gl, renderViewport: {width, height, logicalWidth, logicalHeight}} = this;
    const canvasHeight = this.context.canvas.height;
    gl.enable(WebGL2RenderingContext.SCISSOR_TEST);
    gl.viewport(
        this.canvasRelativeLogicalLeft,
        canvasHeight - (this.canvasRelativeLogicalTop + logicalHeight), logicalWidth,
        logicalHeight);
    gl.scissor(
        this.canvasRelativeClippedLeft, canvasHeight - (this.canvasRelativeClippedTop + height),
        width, height);
  }

  abstract draw(): void;

  disposed() {
    if (this.boundsObserversRegistered) {
      this.context.unmonitorPanel(this.element);
    }
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

  // Returns a number that determine the order in which panels are drawn. This is used by CdfPanel
  // to ensure it is drawn after other panels that update the histogram.
  //
  // A higher number -> later draw.
  get drawOrder() {
    return 0;
  }
}

export abstract class IndirectRenderedPanel extends RenderedPanel {
  canvas = document.createElement('canvas');
  canvasRenderingContext = this.canvas.getContext('2d');
  constructor(
      context: Borrowed<DisplayContext>, element: HTMLElement,
    visibility: WatchableVisibilityPriority) {
    super(context, element, visibility);
    const {canvas} = this;
    element.appendChild(canvas);
    element.style.position = 'relative';
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.right = '0';
    canvas.style.top = '0';
    canvas.style.bottom = '0';
  }

  abstract drawIndirect(): void;

  draw() {
    this.drawIndirect();
    const {renderViewport, canvas} = this;
    const {logicalWidth, logicalHeight} = renderViewport;
    canvas.width = logicalWidth;
    canvas.height = logicalHeight;
    const {canvasRenderingContext} = this;
    canvasRenderingContext?.drawImage(
      this.context.canvas, this.canvasRelativeLogicalLeft, this.canvasRelativeLogicalTop,
      logicalWidth, logicalHeight, 0, 0, logicalWidth, logicalHeight);
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
    const {value} = this;
    const [left, top, width, height] = value;
    if (left === 0 && top == 0 && width === 1 && height === 1) return undefined;
    return Array.from(value);
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

  // Panels ordered by `drawOrder`.  If length is 0, needs to be recomputed.
  private orderedPanels: RenderedPanel[] = [];

  /**
   * Unique number of the next frame.  Incremented once each time a frame is drawn.
   */
  frameNumber = 0;

  private panelAncestors = new Map<HTMLElement, {parent: HTMLElement, count: number}>();

  private resizeCallback = () => {
    ++this.resizeGeneration;
    this.scheduleRedraw();
  };

  monitorPanel(element: HTMLElement): boolean {
    const {panelAncestors, container: root} = this;
    if (!root.contains(element)) return false;
    while (element !== root) {
      let entry = panelAncestors.get(element);
      if (entry !== undefined) {
        ++entry.count;
        break;
      }
      const parent = element.parentElement!;
      entry = {parent, count: 1};
      panelAncestors.set(element, entry);
      element.addEventListener('scroll', this.resizeCallback, {capture: true});
      this.resizeObserver.observe(element);
      element = parent;
    }
    return true;
  }

  unmonitorPanel(element: HTMLElement) {
    const {panelAncestors, container: root} = this;
    while (element !== root) {
      const entry = panelAncestors.get(element)!;
      if (entry.count !== 1) {
        --entry.count;
        break;
      }
      element.removeEventListener('scroll', this.resizeCallback, {capture: true});
      this.resizeObserver.unobserve(element);
      panelAncestors.delete(element);
      element = entry.parent;
    }
  }

  private resizeObserver = new ResizeObserver(this.resizeCallback);

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
    this.orderedPanels.length = 0;
    this.resizeObserver.disconnect();
  }

  addPanel(panel: Borrowed<RenderedPanel>) {
    this.panels.add(panel);
    this.orderedPanels.length = 0;
    ++this.resizeGeneration;
    this.scheduleRedraw();
  }

  removePanel(panel: Borrowed<RenderedPanel>) {
    this.panels.delete(panel);
    this.orderedPanels.length = 0;
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
    const {orderedPanels, panels} = this;
    if (orderedPanels.length !== panels.size) {
      orderedPanels.push(...panels);
      orderedPanels.sort((a, b) => a.drawOrder - b.drawOrder);
    }
    for (const panel of orderedPanels) {
      if (!panel.shouldDraw) continue;
      panel.ensureBoundsUpdated();
      const {renderViewport} = panel;
      if (renderViewport.width === 0 || renderViewport.height === 0) continue;
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
      const {canvasRelativeClippedTop, canvasRelativeClippedLeft, renderViewport: {width, height}} = panel;
      for (let y = 0; y < height; ++y) {
        const panelDepthArrayOffset = (height - 1 - y) * width;
        depthArray.set(
            panelDepthArray.subarray(panelDepthArrayOffset, panelDepthArrayOffset + width),
            (canvasRelativeClippedTop + y) * width + canvasRelativeClippedLeft);
      }
    }
    return depthArray;
  }
}
