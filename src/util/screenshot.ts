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
import { RefCounted } from "#src/util/disposable.js";
import { ScreenshotModes } from "#src/util/trackable_screenshot_mode.js";
import type { Viewer } from "#src/viewer.js";

const SCREENSHOT_TIMEOUT = 5000;

interface ScreenshotLoadStatistics {
  numGpuLoadedVisibleChunks: number;
  timestamp: number;
}

interface ScreenshotActionState {
  viewerState: any;
  selectedValues: any;
  screenshot: {
    id: string;
    image: string;
    imageType: string;
    depthData: string | undefined;
    width: number;
    height: number;
  };
}

export interface StatisticsActionState {
  viewerState: any;
  selectedValues: any;
  screenshotStatistics: {
    id: string;
    chunkSources: any[];
    total: {
      downloadLatency: number;
      visibleChunksDownloading: number;
      visibleChunksFailed: number;
      visibleChunksGpuMemory: number;
      visibleChunksSystemMemory: number;
      visibleChunksTotal: number;
      visibleGpuMemory: number;
    };
  };
}

interface UIScreenshotStatistics {
  timeElapsedString: string | null;
  chunkUsageDescription: string;
  gpuMemoryUsageDescription: string;
  downloadSpeedDescription: string;
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
    if (!panel.isDataPanel) continue;
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

export class ScreenshotFromViewer extends RefCounted {
  public screenshotId: number = -1;
  public screenshotScale: number = 1;
  private filename: string = "";
  private screenshotLoadStats: ScreenshotLoadStatistics = {
    numGpuLoadedVisibleChunks: 0,
    timestamp: 0,
  };
  private lastUpdateTimestamp = 0;
  private screenshotStartTime = 0;
  private lastSavedStatistics: UIScreenshotStatistics = {
    timeElapsedString: null,
    chunkUsageDescription: "",
    gpuMemoryUsageDescription: "",
    downloadSpeedDescription: "",
  };

  constructor(public viewer: Viewer) {
    super();
    this.viewer = viewer;
    this.registerDisposer(
      this.viewer.screenshotActionHandler.sendScreenshotRequested.add(
        (actionState) => {
          this.saveScreenshot(actionState);
        },
      ),
    );
    this.registerDisposer(
      this.viewer.screenshotActionHandler.sendStatisticsRequested.add(
        (actionState) => {
          this.persistStatisticsData(actionState);
          this.checkAndHandleStalledScreenshot(actionState);
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
    this.viewer.display.screenshotMode.value = ScreenshotModes.ON;
  }

  forceScreenshot() {
    this.viewer.display.screenshotMode.value = ScreenshotModes.FORCE;
  }

  get screenshotStatistics(): UIScreenshotStatistics {
    return this.lastSavedStatistics;
  }

  private handleScreenshotStarted() {
    const { viewer } = this;
    const shouldIncreaseCanvasSize = this.screenshotScale !== 1;

    this.screenshotStartTime = this.lastUpdateTimestamp = Date.now();
    this.screenshotLoadStats = {
      numGpuLoadedVisibleChunks: 0,
      timestamp: 0,
    };

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
    this.viewer.screenshotActionHandler.requestState.value =
      this.screenshotId.toString();

    // Force handling the canvas size change
    if (shouldIncreaseCanvasSize) {
      ++viewer.display.resizeGeneration;
      viewer.display.resizeCallback();
    }
  }

  private handleScreenshotModeChange() {
    const { display } = this.viewer;
    switch (display.screenshotMode.value) {
      case ScreenshotModes.OFF:
        this.resetCanvasSize();
        this.resetStatistics();
        break;
      case ScreenshotModes.FORCE:
        display.scheduleRedraw();
        break;
      case ScreenshotModes.ON:
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
    const total = actionState.screenshotStatistics.total;
    const newStats: ScreenshotLoadStatistics = {
      numGpuLoadedVisibleChunks: total.visibleChunksGpuMemory,
      timestamp: Date.now(),
    };
    if (this.screenshotLoadStats.timestamp === 0) {
      this.screenshotLoadStats = newStats;
      return;
    }
    const oldStats = this.screenshotLoadStats;
    if (
      oldStats.numGpuLoadedVisibleChunks === newStats.numGpuLoadedVisibleChunks
    ) {
      if (
        newStats.timestamp - oldStats.timestamp > SCREENSHOT_TIMEOUT &&
        Date.now() - this.lastUpdateTimestamp > SCREENSHOT_TIMEOUT
      ) {
        const totalChunks = total.visibleChunksTotal;
        console.warn(
          `Forcing screenshot: screenshot is likely stuck, no change in GPU chunks after ${SCREENSHOT_TIMEOUT}ms. Last visible chunks: ${newStats.numGpuLoadedVisibleChunks}/${totalChunks}`,
        );
        this.forceScreenshot();
      }
    } else {
      this.screenshotLoadStats = newStats;
    }
  }

  private async saveScreenshot(actionState: ScreenshotActionState) {
    const { screenshot } = actionState;
    const { imageType } = screenshot;
    if (imageType !== "image/png") {
      console.error("Image type is not PNG");
      this.viewer.display.screenshotMode.value = ScreenshotModes.OFF;
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
      const filename = this.generateFilename(
        renderingPanelArea.right - renderingPanelArea.left,
        renderingPanelArea.bottom - renderingPanelArea.top,
      );
      saveBlobToFile(croppedImage, filename);
    } catch (error) {
      console.error("Failed to save screenshot:", error);
    } finally {
      this.viewer.display.screenshotMode.value = ScreenshotModes.OFF;
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
    this.lastSavedStatistics = {
      timeElapsedString: null,
      chunkUsageDescription: "",
      gpuMemoryUsageDescription: "",
      downloadSpeedDescription: "",
    };
  }

  private persistStatisticsData(actionState: StatisticsActionState) {
    const nowtime = Date.now();
    const total = actionState.screenshotStatistics.total;
    const maxGpuMemory =
      this.viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit.value;

    const percentLoaded =
      total.visibleChunksTotal === 0
        ? 0
        : (100 * total.visibleChunksGpuMemory) / total.visibleChunksTotal;
    const percentGpuUsage = (100 * total.visibleGpuMemory) / maxGpuMemory;
    const gpuMemoryUsageInMB = total.visibleGpuMemory / 1000000;
    const totalMemoryInMB = maxGpuMemory / 1000000;
    const latency = isNaN(total.downloadLatency) ? 0 : total.downloadLatency;
    const passedTimeInSeconds = (
      (nowtime - this.screenshotStartTime) /
      1000
    ).toFixed(0);

    this.lastSavedStatistics = {
      timeElapsedString: passedTimeInSeconds,
      chunkUsageDescription: `${total.visibleChunksGpuMemory} out of ${total.visibleChunksTotal} (${percentLoaded.toFixed(2)}%)`,
      gpuMemoryUsageDescription: `${gpuMemoryUsageInMB.toFixed(0)}MB / ${totalMemoryInMB.toFixed(0)}MB (${percentGpuUsage.toFixed(2)}% of total)`,
      downloadSpeedDescription: `${total.visibleChunksDownloading} at ${latency.toFixed(0)}ms latency`,
    };
  }

  private generateFilename(width: number, height: number): string {
    if (!this.filename) {
      const nowtime = new Date().toLocaleString().replace(", ", "-");
      this.filename = `neuroglancer-screenshot-w${width}px-h${height}px-at-${nowtime}.png`;
    }
    return this.filename.endsWith(".png")
      ? this.filename
      : this.filename + ".png";
  }
}
