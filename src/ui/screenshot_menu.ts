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

import type {
  ScreenshotLoadStatistics,
  ScreenshotManager,
} from "#src/util/screenshot_manager.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";

interface UIScreenshotStatistics {
  timeElapsedString: string | null;
  chunkUsageDescription: string;
  gpuMemoryUsageDescription: string;
  downloadSpeedDescription: string;
}

const statisticsNamesForUI = {
  timeElapsedString: "Screenshot duration",
  chunkUsageDescription: "Number of loaded chunks",
  gpuMemoryUsageDescription: "Visible chunk GPU memory usage",
  downloadSpeedDescription: "Number of downloading chunks",
};

export class ScreenshotDialog extends Overlay {
  private nameInput: HTMLInputElement;
  private saveButton: HTMLButtonElement;
  private closeButton: HTMLButtonElement;
  private forceScreenshotButton: HTMLButtonElement;
  private statisticsTable: HTMLTableElement;
  private statisticsContainer: HTMLDivElement;
  private scaleSelectContainer: HTMLDivElement;
  private filenameAndButtonsContainer: HTMLDivElement;
  private statisticsKeyToCellMap: Map<string, HTMLTableCellElement> = new Map();
  constructor(private screenshotManager: ScreenshotManager) {
    super();

    this.initializeUI();
    this.setupEventListeners();
  }

  private initializeUI() {
    this.content.classList.add("neuroglancer-screenshot-dialog");

    this.closeButton = this.createButton(
      "Close",
      () => this.dispose(),
      "neuroglancer-screenshot-close-button",
    );
    this.saveButton = this.createButton("Take screenshot", () =>
      this.screenshot(),
    );
    this.forceScreenshotButton = this.createButton("Force screenshot", () =>
      this.forceScreenshot(),
    );
    this.forceScreenshotButton.title =
      "Force a screenshot of the current view without waiting for all data to be loaded and rendered";
    this.filenameAndButtonsContainer = document.createElement("div");
    this.filenameAndButtonsContainer.classList.add(
      "neuroglancer-screenshot-filename-and-buttons",
    );
    this.filenameAndButtonsContainer.appendChild(this.createNameInput());
    this.filenameAndButtonsContainer.appendChild(this.saveButton);

    this.content.appendChild(this.closeButton);
    this.content.appendChild(this.filenameAndButtonsContainer);
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(this.createStatisticsTable());
    this.updateSetupUIVisibility();
  }

  private setupEventListeners() {
    this.registerDisposer(
      this.screenshotManager.screenshotFinished.add(() => {
        this.dispose();
      }),
    );
    this.registerDisposer(
      this.screenshotManager.statisticsUpdated.add(() => {
        this.populateStatistics();
      }),
    );
  }

  private createNameInput(): HTMLInputElement {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Enter optional filename...";
    nameInput.classList.add("neuroglancer-screenshot-name-input");
    return (this.nameInput = nameInput);
  }

  private createButton(
    text: string,
    onClick: () => void,
    cssClass: string = "",
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = text;
    button.classList.add("neuroglancer-screenshot-button");
    if (cssClass) button.classList.add(cssClass);
    button.addEventListener("click", onClick);
    return button;
  }

  private createScaleRadioButtons() {
    const scaleMenu = (this.scaleSelectContainer =
      document.createElement("div"));
    scaleMenu.classList.add("neuroglancer-screenshot-scale-menu");

    const scaleLabel = document.createElement("label");
    scaleLabel.textContent = "Screenshot scale factor:";
    scaleMenu.appendChild(scaleLabel);

    const scales = [1, 2, 4];
    scales.forEach((scale) => {
      const label = document.createElement("label");
      const input = document.createElement("input");

      input.type = "radio";
      input.name = "screenshot-scale";
      input.value = scale.toString();
      input.checked = scale === this.screenshotManager.screenshotScale;
      input.classList.add("neuroglancer-screenshot-scale-radio");

      label.appendChild(input);
      label.appendChild(document.createTextNode(`${scale}x`));

      scaleMenu.appendChild(label);

      input.addEventListener("change", () => {
        this.screenshotManager.screenshotScale = scale;
      });
    });
    return scaleMenu;
  }

  private createStatisticsTable() {
    this.statisticsContainer = document.createElement("div");
    this.statisticsContainer.classList.add(
      "neuroglancer-screenshot-statistics-title",
    );
    this.statisticsContainer.appendChild(this.forceScreenshotButton);

    this.statisticsTable = document.createElement("table");
    this.statisticsTable.classList.add(
      "neuroglancer-screenshot-statistics-table",
    );
    this.statisticsTable.title = "Screenshot statistics";

    const headerRow = this.statisticsTable.createTHead().insertRow();
    const keyHeader = document.createElement("th");
    keyHeader.textContent = "Screenshot statistics";
    headerRow.appendChild(keyHeader);
    const valueHeader = document.createElement("th");
    valueHeader.textContent = "";
    headerRow.appendChild(valueHeader);

    // Populate inital table elements with placeholder text
    const orderedStatsRow: UIScreenshotStatistics = {
      chunkUsageDescription: "Loading...",
      gpuMemoryUsageDescription: "Loading...",
      downloadSpeedDescription: "Loading...",
      timeElapsedString: "Loading...",
    };
    for (const key in orderedStatsRow) {
      const row = this.statisticsTable.insertRow();
      const keyCell = row.insertCell();
      const valueCell = row.insertCell();
      keyCell.textContent =
        statisticsNamesForUI[key as keyof typeof statisticsNamesForUI];
      valueCell.textContent = orderedStatsRow[key as keyof typeof orderedStatsRow];
      this.statisticsKeyToCellMap.set(key, valueCell);
    }

    this.populateStatistics();
    this.updateStatisticsTableDisplayBasedOnMode();
    this.statisticsContainer.appendChild(this.statisticsTable);
    return this.statisticsContainer;
  }

  private forceScreenshot() {
    this.screenshotManager.forceScreenshot();
  }

  private screenshot() {
    const filename = this.nameInput.value;
    this.screenshotManager.takeScreenshot(filename);
    // Delay the update because sometimes the screenshot is immediately taken
    // And the UI is disposed before the update can happen
    this.debouncedUpdateUIElements();
  }

  private updateStatisticsTableDisplayBasedOnMode() {
    if (this.screenshotMode === ScreenshotMode.OFF) {
      this.statisticsContainer.style.display = "none";
    } else {
      this.statisticsContainer.style.display = "block";
    }
  }

  private populateStatistics() {
    const statsRow = this.parseStatistics(
      this.screenshotManager.screenshotLoadStats,
    );

    for (const key in statsRow) {
      this.statisticsKeyToCellMap.get(key)!.textContent = String(
        statsRow[key as keyof typeof statsRow],
      );
    }
  }

  private parseStatistics(
    currentStatistics: ScreenshotLoadStatistics | null,
  ): UIScreenshotStatistics {
    const nowtime = Date.now();
    if (currentStatistics === null) {
      return {
        timeElapsedString: "Loading...",
        chunkUsageDescription: "Loading...",
        gpuMemoryUsageDescription: "Loading...",
        downloadSpeedDescription: "Loading...",
      };
    }

    const percentLoaded =
      currentStatistics.visibleChunksTotal === 0
        ? 0
        : (100 * currentStatistics.visibleChunksGpuMemory) /
          currentStatistics.visibleChunksTotal;
    const percentGpuUsage =
      (100 * currentStatistics.visibleGpuMemory) /
      currentStatistics.gpuMemoryCapacity;
    const gpuMemoryUsageInMB = currentStatistics.visibleGpuMemory / 1000000;
    const totalMemoryInMB = currentStatistics.gpuMemoryCapacity / 1000000;
    const latency = isNaN(currentStatistics.downloadLatency)
      ? 0
      : currentStatistics.downloadLatency;
    const passedTimeInSeconds =
      (nowtime - this.screenshotManager.screenshotStartTime) / 1000;

    return {
      timeElapsedString: `${passedTimeInSeconds.toFixed(0)} seconds`,
      chunkUsageDescription: `${currentStatistics.visibleChunksGpuMemory} out of ${currentStatistics.visibleChunksTotal} (${percentLoaded.toFixed(2)}%)`,
      gpuMemoryUsageDescription: `${gpuMemoryUsageInMB.toFixed(0)}MB / ${totalMemoryInMB.toFixed(0)}MB (${percentGpuUsage.toFixed(2)}% of total)`,
      downloadSpeedDescription: `${currentStatistics.visibleChunksDownloading} at ${latency.toFixed(0)}ms latency`,
    };
  }

  private debouncedUpdateUIElements = debounce(() => {
    this.updateSetupUIVisibility();
    this.updateStatisticsTableDisplayBasedOnMode();
  }, 100);

  private updateSetupUIVisibility() {
    if (this.screenshotMode === ScreenshotMode.OFF) {
      this.forceScreenshotButton.style.display = "none";
      this.filenameAndButtonsContainer.style.display = "block";
      this.scaleSelectContainer.style.display = "block";
    } else {
      this.forceScreenshotButton.style.display = "block";
      this.filenameAndButtonsContainer.style.display = "none";
      this.scaleSelectContainer.style.display = "none";
    }
  }

  get screenshotMode() {
    return this.screenshotManager.screenshotMode;
  }
}
