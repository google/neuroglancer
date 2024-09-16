/**
 * @license
 * Copyright 2024 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use viewer file except in compliance with the License.
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

import type { RenderedPanel } from "#src/display_context.js";
import type {
  ScreenshotActionState,
  StatisticsActionState,
  ScreenshotChunkStatistics,
} from "#src/python_integration/screenshots.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import type { Viewer } from "#src/viewer.js";

const SCREENSHOT_TIMEOUT = 5000;

export interface ScreenshotLoadStatistics extends ScreenshotChunkStatistics {
  timestamp: number;
  gpuMemoryCapacity: number;
}

interface ViewportBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function saveBlobToFile(blob: Blob, filename: string) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  try {
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function setExtension(filename: string, extension: string = ".png"): string {
  function replaceExtension(filename: string): string {
    const lastDot = filename.lastIndexOf(".");
    if (lastDot === -1) {
      return filename + extension;
    }
    return `${filename.substring(0, lastDot)}${extension}`;
  }

  return filename.endsWith(extension) ? filename : replaceExtension(filename);
}

function calculateViewportBounds(
  panels: ReadonlySet<RenderedPanel>,
): ViewportBounds {
  const viewportBounds = {
    left: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
  for (const panel of panels) {
    if (!(panel instanceof RenderedDataPanel)) continue;
    const viewport = panel.renderViewport;
    const { width, height } = viewport;
    const panelLeft = panel.canvasRelativeClippedLeft;
    const panelTop = panel.canvasRelativeClippedTop;
    const panelRight = panelLeft + width;
    const panelBottom = panelTop + height;
    viewportBounds.left = Math.min(viewportBounds.left, panelLeft);
    viewportBounds.right = Math.max(viewportBounds.right, panelRight);
    viewportBounds.top = Math.min(viewportBounds.top, panelTop);
    viewportBounds.bottom = Math.max(viewportBounds.bottom, panelBottom);
  }
  return viewportBounds;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Canvas toBlob failed"));
      }
    }, type);
  });
}

async function extractViewportScreenshot(
  viewer: Viewer,
  viewportBounds: ViewportBounds,
): Promise<Blob> {
  const cropWidth = viewportBounds.right - viewportBounds.left;
  const cropHeight = viewportBounds.bottom - viewportBounds.top;
  const img = await createImageBitmap(
    viewer.display.canvas,
    viewportBounds.left,
    viewportBounds.top,
    cropWidth,
    cropHeight,
  );

  const screenshotCanvas = document.createElement("canvas");
  screenshotCanvas.width = cropWidth;
  screenshotCanvas.height = cropHeight;
  const ctx = screenshotCanvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas context");
  ctx.drawImage(img, 0, 0);

  const croppedBlob = await canvasToBlob(screenshotCanvas, "image/png");
  return croppedBlob;
}

export class ScreenshotManager extends RefCounted {
  private filename: string = "";
  private lastUpdateTimestamp: number = 0;
  private gpuMemoryChangeTimestamp: number = 0;
  screenshotId: number = -1;
  screenshotScale: number = 1;
  screenshotLoadStats: ScreenshotLoadStatistics | null = null;
  screenshotStartTime = 0;
  screenshotMode: ScreenshotMode = ScreenshotMode.OFF;
  statisticsUpdated = new Signal<(state: ScreenshotLoadStatistics) => void>();
  screenshotFinished = new NullarySignal();

  constructor(public viewer: Viewer) {
    super();
    this.viewer = viewer;
    this.registerDisposer(
      this.viewer.screenshotHandler.sendScreenshotRequested.add(
        (actionState) => {
          this.screenshotFinished.dispatch();
          this.saveScreenshot(actionState);
        },
      ),
    );
    this.registerDisposer(
      this.viewer.screenshotHandler.sendStatisticsRequested.add(
        (actionState) => {
          this.checkAndHandleStalledScreenshot(actionState);
          this.screenshotLoadStats = {
            ...actionState.screenshotStatistics.total,
            timestamp: Date.now(),
            gpuMemoryCapacity:
              this.viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit
                .value,
          };
          this.statisticsUpdated.dispatch(this.screenshotLoadStats);
        },
      ),
    );
    this.registerDisposer(
      this.viewer.display.updateFinished.add(() => {
        this.lastUpdateTimestamp = Date.now();
      }),
    );
    this.registerDisposer(
      this.viewer.display.screenshotMode.changed.add(() => {
        this.handleScreenshotModeChange();
      }),
    );
  }

  takeScreenshot(filename: string = "") {
    this.filename = filename;
    this.viewer.display.screenshotMode.value = ScreenshotMode.ON;
  }

  forceScreenshot() {
    this.viewer.display.screenshotMode.value = ScreenshotMode.FORCE;
  }

  cancelScreenshot() {
    // Decrement the screenshot ID since the screenshot was cancelled
    if (this.screenshotMode === ScreenshotMode.ON) {
      this.screenshotId--;
    }
    this.viewer.display.screenshotMode.value = ScreenshotMode.OFF;
  }

  // Scales the screenshot by the given factor, and calculates the cropped area
  calculatedScaledAndClippedSize() {
    const renderingPanelArea = calculateViewportBounds(
      this.viewer.display.panels,
    );
    return {
      width:
        Math.round(renderingPanelArea.right - renderingPanelArea.left) *
        this.screenshotScale,
      height:
        Math.round(renderingPanelArea.bottom - renderingPanelArea.top) *
        this.screenshotScale,
    };
  }

  private handleScreenshotStarted() {
    const { viewer } = this;
    const shouldIncreaseCanvasSize = this.screenshotScale !== 1;

    this.screenshotStartTime =
      this.lastUpdateTimestamp =
      this.gpuMemoryChangeTimestamp =
        Date.now();
    this.screenshotLoadStats = null;

    if (shouldIncreaseCanvasSize) {
      const oldSize = {
        width: viewer.display.canvas.width,
        height: viewer.display.canvas.height,
      };
      const newSize = {
        width: Math.round(oldSize.width * this.screenshotScale),
        height: Math.round(oldSize.height * this.screenshotScale),
      };
      viewer.display.canvas.width = newSize.width;
      viewer.display.canvas.height = newSize.height;
    }

    // Pass a new screenshot ID to the viewer to trigger a new screenshot.
    this.screenshotId++;
    this.viewer.screenshotHandler.requestState.value =
      this.screenshotId.toString();

    // Force handling the canvas size change
    if (shouldIncreaseCanvasSize) {
      ++viewer.display.resizeGeneration;
      viewer.display.resizeCallback();
    }
  }

  private handleScreenshotModeChange() {
    const { display } = this.viewer;
    this.screenshotMode = display.screenshotMode.value;
    switch (this.screenshotMode) {
      case ScreenshotMode.OFF:
        this.resetCanvasSize();
        this.resetStatistics();
        this.viewer.screenshotHandler.requestState.value = undefined;
        break;
      case ScreenshotMode.FORCE:
        display.scheduleRedraw();
        break;
      case ScreenshotMode.ON:
        this.handleScreenshotStarted();
        break;
    }
  }

  /**
   * Check if the screenshot is stuck by comparing the number of visible chunks
   * in the GPU with the previous number of visible chunks. If the number of
   * visible chunks has not changed after a certain timeout, and the display has not updated, force a screenshot.
   */
  private checkAndHandleStalledScreenshot(actionState: StatisticsActionState) {
    if (this.screenshotLoadStats === null) {
      return;
    }
    const total = actionState.screenshotStatistics.total;
    const newStats = {
      visibleChunksGpuMemory: total.visibleChunksGpuMemory,
      timestamp: Date.now(),
      totalGpuMemory:
        this.viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit.value,
    };
    const oldStats = this.screenshotLoadStats;
    if (
      oldStats.visibleChunksGpuMemory === newStats.visibleChunksGpuMemory &&
      oldStats.gpuMemoryCapacity === newStats.totalGpuMemory
    ) {
      if (
        newStats.timestamp - this.gpuMemoryChangeTimestamp >
          SCREENSHOT_TIMEOUT &&
        Date.now() - this.lastUpdateTimestamp > SCREENSHOT_TIMEOUT
      ) {
        console.warn(
          `Forcing screenshot: screenshot is likely stuck, no change in GPU chunks after ${SCREENSHOT_TIMEOUT}ms. Last visible chunks: ${total.visibleChunksGpuMemory}/${total.visibleChunksTotal}`,
        );
        this.forceScreenshot();
      }
    } else {
      this.gpuMemoryChangeTimestamp = newStats.timestamp;
    }
  }

  private async saveScreenshot(actionState: ScreenshotActionState) {
    const { screenshot } = actionState;
    const { imageType } = screenshot;
    if (imageType !== "image/png") {
      console.error("Image type is not PNG");
      this.viewer.display.screenshotMode.value = ScreenshotMode.OFF;
      return;
    }
    const renderingPanelArea = calculateViewportBounds(
      this.viewer.display.panels,
    );
    try {
      const croppedImage = await extractViewportScreenshot(
        this.viewer,
        renderingPanelArea,
      );
      this.generateFilename(
        renderingPanelArea.right - renderingPanelArea.left,
        renderingPanelArea.bottom - renderingPanelArea.top,
      );
      saveBlobToFile(croppedImage, this.filename);
    } catch (error) {
      console.error("Failed to save screenshot:", error);
    } finally {
      this.saveScreenshotLog(actionState);
      this.viewer.display.screenshotMode.value = ScreenshotMode.OFF;
    }
  }

  private saveScreenshotLog(actionState: ScreenshotActionState) {
    const { viewerState } = actionState;
    const stateString = JSON.stringify(viewerState);
    this.downloadState(stateString);
  }

  private downloadState(state: string) {
    const blob = new Blob([state], { type: "text/json" });
    saveBlobToFile(blob, setExtension(this.filename, "_state.json"));
  }

  private resetCanvasSize() {
    // Reset the canvas size to the original size
    // No need to manually pass the correct sizes, the viewer will handle it
    const { viewer } = this;
    ++viewer.display.resizeGeneration;
    viewer.display.resizeCallback();
  }

  private resetStatistics() {
    this.screenshotLoadStats = null;
  }

  private generateFilename(width: number, height: number): string {
    if (!this.filename) {
      const nowtime = new Date().toLocaleString().replace(", ", "-");
      this.filename = `neuroglancer-screenshot-w${width}px-h${height}px-at-${nowtime}`;
    }
    this.filename = setExtension(this.filename);
    return this.filename;
  }
}
