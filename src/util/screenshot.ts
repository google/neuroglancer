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

// Warn after 5 seconds that the screenshot is likely stuck if no change in GPU chunks
const SCREENSHOT_TIMEOUT = 5000;

interface screenshotGpuStats {
  numVisibleChunks: number;
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

interface ScreenshotCanvasViewport {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function downloadFileForBlob(blob: Blob, filename: string) {
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

function determineViewPanelArea(
  panels: Set<RenderedPanel>,
): ScreenshotCanvasViewport {
  const clippedPanel = {
    left: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  };
  for (const panel of panels) {
    if (!panel.isDataPanel) continue;
    const viewport = panel.renderViewport;
    const { width, height } = viewport;
    const left = panel.canvasRelativeClippedLeft;
    const top = panel.canvasRelativeClippedTop;
    const right = left + width;
    const bottom = top + height;
    clippedPanel.left = Math.min(clippedPanel.left, left);
    clippedPanel.right = Math.max(clippedPanel.right, right);
    clippedPanel.top = Math.min(clippedPanel.top, top);
    clippedPanel.bottom = Math.max(clippedPanel.bottom, bottom);
  }
  return clippedPanel;
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

async function cropViewsFromViewer(
  viewer: Viewer,
  crop: ScreenshotCanvasViewport,
): Promise<Blob> {
  const cropWidth = crop.right - crop.left;
  const cropHeight = crop.bottom - crop.top;
  const img = await createImageBitmap(
    viewer.display.canvas,
    crop.left,
    crop.top,
    cropWidth,
    cropHeight,
  );

  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas context");
  ctx.drawImage(img, 0, 0);

  const croppedBlob = await canvasToBlob(canvas, "image/png");
  return croppedBlob;
}

export class ScreenshotFromViewer extends RefCounted {
  public screenshotId: number = -1;
  public screenshotScale: number = 1;
  private filename: string = "";
  private gpuStats: screenshotGpuStats = {
    numVisibleChunks: 0,
    timestamp: 0,
  };
  private lastUpdateTimestamp = 0;

  constructor(public viewer: Viewer) {
    super();
    this.viewer = viewer;
    this.registerDisposer(
      this.viewer.screenshotActionHandler.sendScreenshotRequested.add(
        (state) => {
          this.saveScreenshot(state);
        },
      ),
    );
    this.registerDisposer(
      this.viewer.display.updateFinished.add(() => {
        this.lastUpdateTimestamp = Date.now();
      }),
    );
    this.registerDisposer(
      this.viewer.screenshotActionHandler.sendStatisticsRequested.add(
        (actionState) => {
          this.checkForStuckScreenshot(actionState);
        },
      ),
    );
    this.registerDisposer(
      this.viewer.display.screenshotMode.changed.add(() => {
        this.handleScreenshotModeChange();
      }),
    );
  }

  screenshot(filename: string = "") {
    this.filename = filename;
    this.viewer.display.screenshotMode.value = ScreenshotModes.ON;
  }

  private startScreenshot() {
    const { viewer } = this;
    const shouldResize = this.screenshotScale !== 1;
    this.lastUpdateTimestamp = Date.now();
    this.gpuStats = {
      numVisibleChunks: 0,
      timestamp: 0,
    };
    if (shouldResize) {
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
    this.screenshotId++;
    this.viewer.screenshotActionHandler.requestState.value =
      this.screenshotId.toString();
    if (shouldResize) {
      ++viewer.display.resizeGeneration;
      viewer.display.resizeCallback();
    }
  }

  resetCanvasSize() {
    const { viewer } = this;
    ++viewer.display.resizeGeneration;
    viewer.display.resizeCallback();
  }

  async saveScreenshot(actionState: ScreenshotActionState) {
    const { screenshot } = actionState;
    const { imageType } = screenshot;
    if (imageType !== "image/png") {
      console.error("Image type is not PNG");
      this.viewer.display.screenshotMode.value = ScreenshotModes.OFF;
      return;
    }
    const renderingPanelArea = determineViewPanelArea(
      this.viewer.display.panels,
    );
    try {
      const croppedImage = await cropViewsFromViewer(
        this.viewer,
        renderingPanelArea,
      );
      const filename = this.generateFilename(
        renderingPanelArea.right - renderingPanelArea.left,
        renderingPanelArea.bottom - renderingPanelArea.top,
      );
      downloadFileForBlob(croppedImage, filename);
    } catch (error) {
      console.error(error);
    } finally {
      this.viewer.display.screenshotMode.value = ScreenshotModes.OFF;
    }
  }

  /**
   * Check if the screenshot is stuck by comparing the number of visible chunks
   * in the GPU with the previous number of visible chunks. If the number of
   * visible chunks has not changed after a certain timeout, and the display has not updated, force a screenshot.
   */
  private checkForStuckScreenshot(actionState: StatisticsActionState) {
    const total = actionState.screenshotStatistics.total;
    const newStats = {
      numVisibleChunks: total.visibleChunksGpuMemory,
      timestamp: Date.now(),
    };
    const oldStats = this.gpuStats;
    if (oldStats.timestamp === 0) {
      this.gpuStats = newStats;
      return;
    }
    if (oldStats.numVisibleChunks === newStats.numVisibleChunks) {
      if (
        newStats.timestamp - oldStats.timestamp > SCREENSHOT_TIMEOUT &&
        Date.now() - this.lastUpdateTimestamp > SCREENSHOT_TIMEOUT
      ) {
        const totalChunks = total.visibleChunksTotal;
        console.warn(
          `Forcing screenshot: screenshot is likely stuck, no change in GPU chunks after ${SCREENSHOT_TIMEOUT}ms. Last visible chunks: ${newStats.numVisibleChunks}/${totalChunks}`,
        );
        this.forceScreenshot();
      }
    } else {
      this.gpuStats = newStats;
    }
  }

  parseStatistics(actionState: StatisticsActionState | undefined) {
    const nowtime = new Date().toLocaleTimeString();
    let statsRow;
    if (actionState === undefined) {
      statsRow = {
        time: nowtime,
        visibleChunksGpuMemory: "",
        visibleGpuMemory: "",
        visibleChunksDownloading: "",
      };
    } else {
      const total = actionState.screenshotStatistics.total;

      const percentLoaded =
        (100 * total.visibleChunksGpuMemory) / total.visibleChunksTotal;
      const percentGpuUsage =
        (100 * total.visibleGpuMemory) /
        this.viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit.value;
      const gpuMemoryUsageInMB = total.visibleGpuMemory / 1024 / 1024;
      statsRow = {
        time: nowtime,
        visibleChunksGpuMemory: `${total.visibleChunksGpuMemory} out of ${total.visibleChunksTotal} (${percentLoaded.toFixed(2)}%)`,
        visibleGpuMemory: `${gpuMemoryUsageInMB}Mb (${percentGpuUsage.toFixed(2)}% of total)`,
        visibleChunksDownloading: `${total.visibleChunksDownloading} at ${total.downloadLatency}ms`,
      };
    }
    return statsRow;
  }

  forceScreenshot() {
    this.viewer.display.screenshotMode.value = ScreenshotModes.FORCE;
  }

  generateFilename(width: number, height: number): string {
    let filename = this.filename;
    if (filename.length === 0) {
      let nowtime = new Date().toLocaleString();
      nowtime = nowtime.replace(", ", "-");
      filename = `neuroglancer-screenshot-w${width}px-h${height}px-at-${nowtime}.png`;
    }
    if (!filename.endsWith(".png")) {
      filename += ".png";
    }
    return filename;
  }

  handleScreenshotModeChange() {
    const { viewer } = this;
    const { display } = viewer;
    const { screenshotMode } = display;
    if (screenshotMode.value === ScreenshotModes.OFF) {
      this.resetCanvasSize();
    } else if (screenshotMode.value === ScreenshotModes.FORCE) {
      display.scheduleRedraw();
    } else if (screenshotMode.value === ScreenshotModes.ON) {
      this.startScreenshot();
    }
  }
}
