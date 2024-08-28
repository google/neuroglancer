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

export interface ScreenshotActionState {
  viewerState: any;
  selectedValues: any;
  screenshot: ScreenshotResponse;
}

export class ScreenshotFromViewer extends RefCounted {
  public screenshotId: number = -1;
  private screenshotUrl: string | undefined;
  public screenshotScale: number = 1;

  constructor(public viewer: Viewer) {
    super();
    this.viewer = viewer;
  }

  screenshot() {
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
    viewer.display.inScreenshotMode = true;
    if (!shouldResize) {
      viewer.display.scheduleRedraw();
    } else {
      ++viewer.display.resizeGeneration;
      viewer.display.resizeCallback();
    }
  }

  resetCanvasSize() {
    const { viewer } = this;
    viewer.display.inScreenshotMode = false;
    ++viewer.display.resizeGeneration;
    viewer.display.resizeCallback();
  }

  saveScreenshot(actionState: ScreenshotActionState) {
    function binaryStringToUint8Array(binaryString: string) {
      const length = binaryString.length;
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    }

    function base64ToUint8Array(base64: string) {
      const binaryString = window.atob(base64);
      return binaryStringToUint8Array(binaryString);
    }

    const { screenshot } = actionState;
    const { image, imageType, width, height } = screenshot;
    const screenshotImage = new Blob([base64ToUint8Array(image)], {
      type: imageType,
    });
    if (this.screenshotUrl !== undefined) {
      URL.revokeObjectURL(this.screenshotUrl);
    }
    this.screenshotUrl = URL.createObjectURL(screenshotImage);

    const a = document.createElement("a");
    if (this.screenshotUrl !== undefined) {
      let nowtime = new Date().toLocaleString();
      nowtime = nowtime.replace(", ", "-");
      a.href = this.screenshotUrl;
      a.download = `neuroglancer-screenshot-w${width}px-h${height}px-at-${nowtime}.png`;
      document.body.appendChild(a);
      try {
        a.click();
      } finally {
        document.body.removeChild(a);
      }
    }

    this.resetCanvasSize();
  }
}
