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
 *
 * @file Builds upon the Python screenshot tool to allow viewer screenshots to be taken and saved.
 */

import { throttle } from "lodash-es";
import { numChunkStatistics } from "#src/chunk_manager/base.js";
import type {
  ScreenshotActionState,
  StatisticsActionState,
  ScreenshotChunkStatistics,
} from "#src/python_integration/screenshots.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { StatusMessage } from "#src/status.js";
import {
  columnSpecifications,
  getChunkSourceIdentifier,
  getFormattedNames,
} from "#src/ui/statistics.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import {
  calculatePanelViewportBounds,
  type PanelViewport,
} from "#src/util/viewer_resolution_stats.js";
import type { Viewer } from "#src/viewer.js";

export const MAX_RENDER_AREA_PIXELS = 5100 * 5100;
const SCREENSHOT_TIMEOUT = 3000;

export interface ScreenshotLoadStatistics extends ScreenshotChunkStatistics {
  timestamp: number;
  gpuMemoryCapacity: number;
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
  viewportBounds: PanelViewport,
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

/**
 * Manages the screenshot functionality from the viewer viewer.
 *
 * Responsible for linking up the Python screenshot tool with the viewer, and handling the screenshot process.
 * The screenshot manager provides information about updates in the screenshot process, and allows for the screenshot to be taken and saved.
 * The screenshot UI menu listens to the signals emitted by the screenshot manager to update the UI.
 */
export class ScreenshotManager extends RefCounted {
  screenshotId: number = -1;
  screenshotLoadStats: ScreenshotLoadStatistics | null = null;
  screenshotStartTime = 0;
  screenshotMode: ScreenshotMode = ScreenshotMode.OFF;
  statisticsUpdated = new Signal<(state: ScreenshotLoadStatistics) => void>();
  screenshotFinished = new NullarySignal();
  zoomMaybeChanged = new NullarySignal();
  private _shouldKeepSliceViewFOVFixed: boolean = true;
  private _screenshotScale: number = 1;
  private filename: string = "";
  private lastUpdateTimestamp: number = 0;
  private gpuMemoryChangeTimestamp: number = 0;
  throttledSendStatistics = this.registerCancellable(
    throttle(async () => {
      const map = await this.viewer.chunkQueueManager.getStatistics();
      if (this.wasDisposed) return;
      const formattedNames = getFormattedNames(
        Array.from(map, (x) => getChunkSourceIdentifier(x[0])),
      );
      let i = 0;
      const rows: any[] = [];
      const sumStatistics = new Float64Array(numChunkStatistics);
      for (const [source, statistics] of map) {
        for (let i = 0; i < numChunkStatistics; ++i) {
          sumStatistics[i] += statistics[i];
        }
        const row: any = {};
        row.id = getChunkSourceIdentifier(source);
        row.distinctId = formattedNames[i];
        for (const column of columnSpecifications) {
          row[column.key] = column.getter(statistics);
        }
        ++i;
        rows.push(row);
      }
      const total: any = {};
      for (const column of columnSpecifications) {
        total[column.key] = column.getter(sumStatistics);
      }
      const screenshotLoadStats = {
        ...total,
        timestamp: Date.now(),
        gpuMemoryCapacity:
          this.viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit.value,
      };
      this.statisticsUpdated.dispatch(screenshotLoadStats);
    }, 1000),
  );

  constructor(public viewer: Viewer) {
    super();
    this.registerDisposer(
      this.viewer.screenshotHandler.sendScreenshotRequested.add(
        (actionState) => {
          this.saveScreenshot(actionState);
        },
      ),
    );
    this.registerDisposer(
      this.viewer.screenshotHandler.sendStatisticsRequested.add(
        (actionState) => {
          const newLoadStats = {
            ...actionState.screenshotStatistics.total,
            timestamp: Date.now(),
            gpuMemoryCapacity:
              this.viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit
                .value,
          };
          this.checkAndHandleStalledScreenshot(actionState, newLoadStats);
          this.screenshotLoadStats = newLoadStats;
        },
      ),
    );
    this.registerDisposer(
      this.viewer.display.updateFinished.add(() => {
        this.lastUpdateTimestamp = Date.now();
        this.throttledSendStatistics();
      }),
    );
    this.registerDisposer(
      this.viewer.display.screenshotMode.changed.add(() => {
        this.handleScreenshotModeChange();
      }),
    );
  }

  public get screenshotScale() {
    return this._screenshotScale;
  }

  public set screenshotScale(scale: number) {
    this._screenshotScale = this.handleScreenshotZoomAndResize(scale);
    this.zoomMaybeChanged.dispatch();
  }

  public get shouldKeepSliceViewFOVFixed() {
    return this._shouldKeepSliceViewFOVFixed;
  }

  public set shouldKeepSliceViewFOVFixed(enableFixedFOV: boolean) {
    const wasInFixedFOVMode = this.shouldKeepSliceViewFOVFixed;
    this._shouldKeepSliceViewFOVFixed = enableFixedFOV;
    if (!enableFixedFOV && wasInFixedFOVMode) {
      this.handleScreenshotZoomAndResize(
        this.screenshotScale,
        true /* resetZoom */,
      );
      this.zoomMaybeChanged.dispatch();
    } else if (enableFixedFOV && !wasInFixedFOVMode) {
      this.handleScreenshotZoomAndResize(
        1 / this.screenshotScale,
        true /* resetZoom */,
      );
      this.zoomMaybeChanged.dispatch();
    }
  }

  previewScreenshot() {
    this.viewer.display.screenshotMode.value = ScreenshotMode.PREVIEW;
  }

  takeScreenshot(filename: string = "") {
    this.filename = filename;
    this.viewer.display.screenshotMode.value = ScreenshotMode.ON;
  }

  forceScreenshot() {
    this.viewer.display.screenshotMode.value = ScreenshotMode.FORCE;
  }

  cancelScreenshot(shouldStayInPreview: boolean = false) {
    // Decrement the screenshot ID since the screenshot was cancelled
    if (this.screenshotMode === ScreenshotMode.ON) {
      this.screenshotId--;
    }
    const newMode = shouldStayInPreview
      ? ScreenshotMode.PREVIEW
      : ScreenshotMode.OFF;
    this.viewer.display.screenshotMode.value = newMode;
  }

  // Calculates the cropped area of the viewport panels
  calculatedClippedViewportSize(): {
    width: number;
    height: number;
  } {
    const renderingPanelArea = calculatePanelViewportBounds(
      this.viewer.display.panels,
    ).totalRenderPanelViewport;
    return {
      width: Math.round(renderingPanelArea.right - renderingPanelArea.left),
      height: Math.round(renderingPanelArea.bottom - renderingPanelArea.top),
    };
  }

  private handleScreenshotStarted() {
    this.screenshotStartTime =
      this.lastUpdateTimestamp =
      this.gpuMemoryChangeTimestamp =
        Date.now();
    this.screenshotLoadStats = null;

    // Pass a new screenshot ID to the viewer to trigger a new screenshot.
    this.screenshotId++;
    this.viewer.screenshotHandler.requestState.value =
      this.screenshotId.toString();
  }

  private resizeCanvasIfNeeded(scale: number = this.screenshotScale) {
    const shouldChangeCanvasSize = scale !== 1;
    const { viewer } = this;
    if (shouldChangeCanvasSize) {
      const oldSize = {
        width: viewer.display.canvas.width,
        height: viewer.display.canvas.height,
      };
      const newSize = {
        width: Math.round(oldSize.width * scale),
        height: Math.round(oldSize.height * scale),
      };
      viewer.display.canvas.width = newSize.width;
      viewer.display.canvas.height = newSize.height;
      viewer.display.resizeCallback();
    }
  }

  private handleScreenshotModeChange() {
    const { display } = this.viewer;
    // If moving straight from OFF to ON, need to resize the canvas to the correct size
    const mayNeedCanvasResize = this.screenshotMode === ScreenshotMode.OFF;
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
        // If moving straight from OFF to ON, may need to resize the canvas to the correct size
        // Going from PREVIEW to ON does not require a resize
        if (mayNeedCanvasResize) {
          this.resizeCanvasIfNeeded();
        }
        this.handleScreenshotStarted();
        break;
      case ScreenshotMode.PREVIEW:
        // Do nothing, included for completeness
        break;
    }
  }

  /**
   * Handles the zooming of the screenshot in fixed FOV mode.
   * This supports:
   * 1. Updating the zoom level of the viewer to match the screenshot scale.
   * 2. Resetting the zoom level of the slice views to the original level.
   * 3. Resizing the canvas to match the new scale.
   * @param scale - The scale factor to apply to the screenshot.
   * @param resetZoom - If true, the zoom resets to the original level.
   */
  private handleScreenshotZoomAndResize(
    scale: number,
    resetZoom: boolean = false,
  ) {
    const oldScale = this.screenshotScale;

    // Because the scale is applied to the canvas, we need to check if the new scale will exceed the maximum render area
    // If so, that means the scale needs to be adjusted to fit within the maximum render area
    let intendedScale = scale;
    if (!resetZoom && scale > 1) {
      const currentCanvasSize = this.calculatedClippedViewportSize();
      const numPixels =
        (currentCanvasSize.width * currentCanvasSize.height) /
        (oldScale * oldScale);
      if (numPixels * intendedScale * intendedScale > MAX_RENDER_AREA_PIXELS) {
        intendedScale = Math.sqrt(MAX_RENDER_AREA_PIXELS / numPixels);
      }
    }

    const scaleFactor = intendedScale / oldScale;
    const zoomScaleFactor = resetZoom ? scale : 1 / scaleFactor;
    const canvasScaleFactor = resetZoom ? 1 : scaleFactor;

    if (this.shouldKeepSliceViewFOVFixed || resetZoom) {
      // Scale the zoom factor of each slice view panel
      const { navigationState } = this.viewer;
      for (const panel of this.viewer.display.panels) {
        if (panel instanceof SliceViewPanel) {
          const zoom = navigationState.zoomFactor.value;
          navigationState.zoomFactor.value = zoom * zoomScaleFactor;
          break;
        }
      }
    }

    this.resizeCanvasIfNeeded(canvasScaleFactor);

    return intendedScale;
  }

  /**
   * Check if the screenshot is stuck by comparing the number of visible chunks
   * in the GPU with the previous number of visible chunks. If the number of
   * visible chunks has not changed after a certain timeout, and the display has not updated, force a screenshot.
   */
  private checkAndHandleStalledScreenshot(
    actionState: StatisticsActionState,
    fullStats: ScreenshotLoadStatistics,
  ) {
    if (this.screenshotLoadStats === null) {
      return;
    }
    const total = actionState.screenshotStatistics.total;
    const newStats = {
      visibleChunksGpuMemory: total.visibleChunksGpuMemory,
      timestamp: Date.now(),
      totalGpuMemory:
        this.viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit.value,
      numDownloadingChunks: total.visibleChunksDownloading,
    };
    const oldStats = this.screenshotLoadStats;
    if (
      oldStats.visibleChunksGpuMemory === newStats.visibleChunksGpuMemory &&
      (oldStats.gpuMemoryCapacity === newStats.totalGpuMemory ||
        newStats.numDownloadingChunks == 0)
    ) {
      if (
        newStats.timestamp - this.gpuMemoryChangeTimestamp >
          SCREENSHOT_TIMEOUT &&
        Date.now() - this.lastUpdateTimestamp > SCREENSHOT_TIMEOUT
      ) {
        this.statisticsUpdated.dispatch(fullStats);
        const message = `Forcing screenshot: screenshot is likely stuck, no change in GPU chunks after ${SCREENSHOT_TIMEOUT}ms. Last visible chunks: ${total.visibleChunksGpuMemory}/${total.visibleChunksTotal}`;
        console.warn(message);
        StatusMessage.showTemporaryMessage(message, 5000);
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
    const renderingPanelArea = calculatePanelViewportBounds(
      this.viewer.display.panels,
    ).totalRenderPanelViewport;
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
      this.viewer.display.screenshotMode.value = ScreenshotMode.OFF;
      this.screenshotFinished.dispatch();
    }
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
