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
import { PerspectivePanel } from "#src/perspective_view/panel.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { RefCounted } from "#src/util/disposable.js";
import type { Viewer } from "#src/viewer.js";

interface ScreenshotResponse {
  id: string;
  image: string;
  imageType: string;
  depthData: string | undefined;
  width: number;
  height: number;
}

interface ScreenshotActionState {
  viewerState: any;
  selectedValues: any;
  screenshot: ScreenshotResponse;
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

function generateFilename(
  inputFilename: string,
  width: number,
  height: number,
): string {
  let filename = inputFilename;
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
    if (
      !(panel instanceof SliceViewPanel) &&
      !(panel instanceof PerspectivePanel)
    ) {
      continue;
    }
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

async function cropUint8Image(
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
  }

  screenshot(filename: string = "") {
    const { viewer } = this;
    const shouldResize = this.screenshotScale !== 1;
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
    viewer.display.inScreenshotMode = true;
    if (shouldResize) {
      ++viewer.display.resizeGeneration;
      viewer.display.resizeCallback();
    }
    this.filename = filename;
  }

  resetCanvasSize() {
    const { viewer } = this;
    viewer.display.inScreenshotMode = false;
    viewer.display.screenshotFinished.dispatch();
    ++viewer.display.resizeGeneration;
    viewer.display.resizeCallback();
  }

  async saveScreenshot(actionState: ScreenshotActionState) {
    const { screenshot } = actionState;
    const { imageType } = screenshot;
    if (imageType !== "image/png") {
      console.error("Image type is not PNG");
      return;
    }
    const renderLocation = determineViewPanelArea(this.viewer.display.panels);
    try {
      const croppedImage = await cropUint8Image(this.viewer, renderLocation);
      const filename = generateFilename(
        this.filename,
        renderLocation.right - renderLocation.left,
        renderLocation.bottom - renderLocation.top,
      );
      downloadFileForBlob(croppedImage, filename);
    } catch (error) {
      console.error(error);
    } finally {
      this.resetCanvasSize();
    }
  }
}
