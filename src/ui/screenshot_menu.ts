/**
 * @license
 * Copyright 2024 Google Inc.
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

import { debounce } from "lodash-es";
import { Overlay } from "#src/overlay.js";
import "#src/ui/screenshot_menu.css";

import type { StatisticsActionState } from "#src/util/screenshot.js";
import type { Viewer } from "#src/viewer.js";

// Warn after 5 seconds that the screenshot is likely stuck if no change in GPU chunks
const SCREENSHOT_TIMEOUT = 5000;

interface screenshotGpuStats {
  numVisibleChunks: number;
  timestamp: number;
}

export class ScreenshotDialog extends Overlay {
  private nameInput: HTMLInputElement;
  private saveButton: HTMLButtonElement;
  private closeButton: HTMLButtonElement;
  private forceScreenshotButton: HTMLButtonElement;
  private statisticsTable: HTMLTableElement;
  private titleBar: HTMLDivElement;
  private inScreenshotMode: boolean;
  private gpuStats: screenshotGpuStats = {
    numVisibleChunks: 0,
    timestamp: 0,
  };
  private lastUpdateTimestamp = 0;
  constructor(public viewer: Viewer) {
    super();

    this.content.classList.add("neuroglancer-screenshot-dialog");
    this.inScreenshotMode = this.viewer.display.inScreenshotMode;

    const closeButton = (this.closeButton = document.createElement("button"));
    closeButton.classList.add("close-button");
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => this.dispose());

    const nameInput = (this.nameInput = document.createElement("input"));
    nameInput.type = "text";
    nameInput.placeholder = "Enter filename...";

    const saveButton = this.createSaveButton();
    const forceScreenshotButton = this.createForceScreenshotButton();

    this.content.appendChild(this.closeButton);
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(this.nameInput);
    if (this.inScreenshotMode) {
      this.content.appendChild(forceScreenshotButton);
    } else {
      this.content.appendChild(saveButton);
    }
    this.content.appendChild(this.createStatisticsTable());

    this.registerDisposer(
      this.viewer.display.screenshotFinished.add(() => {
        this.debouncedShowSaveOrForceScreenshotButton();
        this.dispose();
      }),
    );
    this.registerDisposer(
      this.viewer.screenshotActionHandler.sendStatisticsRequested.add(
        (actionState) => {
          this.populateStatistics(actionState);
        },
      ),
    );
    this.registerDisposer(
      this.viewer.display.updateFinished.add(() => {
        this.lastUpdateTimestamp = Date.now();
      }),
    );
  }

  private createSaveButton() {
    const saveButton = (this.saveButton = document.createElement("button"));
    saveButton.textContent = "Take screenshot";
    saveButton.title =
      "Take a screenshot of the current view and save it to a png file";
    saveButton.addEventListener("click", () => {
      this.screenshot();
    });
    return saveButton;
  }

  private createForceScreenshotButton() {
    const forceScreenshotButton = (this.forceScreenshotButton =
      document.createElement("button"));
    forceScreenshotButton.textContent = "Force screenshot";
    forceScreenshotButton.title =
      "Force a screenshot of the current view and save it to a png file";
    forceScreenshotButton.addEventListener("click", () => {
      this.forceScreenshot();
    });
    return forceScreenshotButton;
  }

  private createScaleRadioButtons() {
    const scaleRadioButtons = document.createElement("div");
    scaleRadioButtons.classList.add("scale-radio-buttons");
    const scales = [1, 2, 4];
    for (const scale of scales) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "screenshot-scale";
      input.value = scale.toString();
      input.checked = scale === this.viewer.screenshotHandler.screenshotScale;
      label.appendChild(input);
      label.appendChild(document.createTextNode(`Scale ${scale}x`));
      scaleRadioButtons.appendChild(label);
      input.addEventListener("change", () => {
        this.viewer.screenshotHandler.screenshotScale = scale;
      });
    }
    return scaleRadioButtons;
  }

  private createStatisticsTable() {
    const titleBar = document.createElement("div");
    this.titleBar = titleBar;
    titleBar.classList.add("neuroglancer-screenshot-statistics-title");
    this.content.appendChild(titleBar);
    this.statisticsTable = document.createElement("table");
    this.statisticsTable.classList.add(
      "neuroglancer-screenshot-statistics-table",
    );
    this.statisticsTable.createTHead().insertRow().innerHTML =
      "<th>Key</th><th>Value</th>";
    this.statisticsTable.title = "Screenshot statistics";

    this.setTitleBarText();
    this.populateStatistics(undefined);
    return titleBar;
  }

  private setTitleBarText() {
    const titleBarText = this.inScreenshotMode
      ? "Screenshot in progress with the following statistics:"
      : "Start screenshot mode to see statistics";
    this.titleBar.textContent = titleBarText;
    this.titleBar.appendChild(this.statisticsTable);
  }

  private forceScreenshot() {
    this.viewer.display.forceScreenshot = true;
    this.viewer.display.scheduleRedraw();
    this.debouncedShowSaveOrForceScreenshotButton();
    this.dispose();
  }

  private screenshot() {
    const filename = this.nameInput.value;
    this.viewer.screenshotHandler.screenshot(filename);
    this.viewer.display.forceScreenshot = false;
    this.debouncedShowSaveOrForceScreenshotButton();
  }

  private populateStatistics(actionState: StatisticsActionState | undefined) {
    const nowtime = new Date().toLocaleString().replace(", ", "-");
    let statsRow;
    if (actionState === undefined) {
      statsRow = {
        time: nowtime,
        visibleChunksGpuMemory: 0,
        visibleChunksTotal: 0,
        visibleGpuMemory: 0,
        visibleChunksDownloading: 0,
        downloadLatency: 0,
      };
    } else {
      const total = actionState.screenshotStatistics.total;

      statsRow = {
        time: nowtime,
        visibleChunksGpuMemory: total.visibleChunksGpuMemory,
        visibleChunksTotal: total.visibleChunksTotal,
        visibleGpuMemory: total.visibleGpuMemory,
        visibleChunksDownloading: total.visibleChunksDownloading,
        downloadLatency: total.downloadLatency,
      };
      while (this.statisticsTable.rows.length > 1) {
        this.statisticsTable.deleteRow(1);
      }
      this.checkForStuckScreenshot(
        {
          numVisibleChunks: total.visibleChunksGpuMemory,
          timestamp: Date.now(),
        },
        total.visibleChunksTotal,
      );
    }

    for (const key in statsRow) {
      const row = this.statisticsTable.insertRow();
      const keyCell = row.insertCell();
      keyCell.textContent = key;
      const valueCell = row.insertCell();
      valueCell.textContent = String(statsRow[key as keyof typeof statsRow]);
    }
  }

  private debouncedShowSaveOrForceScreenshotButton = debounce(() => {
    this.showSaveOrForceScreenshotButton();
    this.setTitleBarText();
  }, 200);

  /**
   * Check if the screenshot is stuck by comparing the number of visible chunks
   * in the GPU with the previous number of visible chunks. If the number of
   * visible chunks has not changed after a certain timeout, and the display has not updated, force a screenshot.
   */
  private checkForStuckScreenshot(
    newStats: screenshotGpuStats,
    totalChunks: number,
  ) {
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
        console.warn(
          `Forcing screenshot: screenshot is likely stuck, no change in GPU chunks after ${SCREENSHOT_TIMEOUT}ms. Last visible chunks: ${newStats.numVisibleChunks}/${totalChunks}`,
        );
        this.forceScreenshotButton.click();
      }
    } else {
      this.gpuStats = newStats;
    }
  }

  private showSaveOrForceScreenshotButton() {
    if (this.viewer.display.inScreenshotMode && !this.inScreenshotMode) {
      this.inScreenshotMode = true;
      this.content.replaceChild(this.forceScreenshotButton, this.saveButton);
    } else if (!this.viewer.display.inScreenshotMode && this.inScreenshotMode) {
      this.inScreenshotMode = false;
      this.content.replaceChild(this.saveButton, this.forceScreenshotButton);
    }
  }
}
