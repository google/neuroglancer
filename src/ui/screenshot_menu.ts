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

import "#src/ui/screenshot_menu.css";
import { debounce, throttle } from "lodash-es";
import { Overlay } from "#src/overlay.js";
import type {
  ScreenshotLoadStatistics,
  ScreenshotManager,
} from "#src/util/screenshot_manager.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import type { DimensionResolutionStats } from "#src/util/viewer_resolution_stats.js";
import {
  getViewerLayerResolutions,
  getViewerPanelResolutions,
} from "#src/util/viewer_resolution_stats.js";

// If true, the menu can be closed by clicking the close button
// Usually the user is locked into the screenshot menu until the screenshot is taken or cancelled
// Setting this to true, and setting the SCREENSHOT_MENU_CLOSE_TIMEOUT in screenshot_manager.ts
// to a high value can be useful for debugging canvas handling of the resize

const DEBUG_ALLOW_MENU_CLOSE = false;
const LARGE_SCREENSHOT_SIZE = 4096 * 4096;

interface UIScreenshotStatistics {
  chunkUsageDescription: string;
  gpuMemoryUsageDescription: string;
  downloadSpeedDescription: string;
}

const statisticsNamesForUI = {
  chunkUsageDescription: "Number of loaded chunks",
  gpuMemoryUsageDescription: "Visible chunk GPU memory usage",
  downloadSpeedDescription: "Number of downloading chunks",
};

const layerNamesForUI = {
  ImageRenderLayer: "Image slice (2D)",
  VolumeRenderingRenderLayer: "Volume rendering (3D)",
  SegmentationRenderLayer: "Segmentation slice (2D)",
};

function formatResolution(resolution: DimensionResolutionStats[]) {
  if (resolution.length === 0) {
    return {
      type: "Loading...",
      resolution: "Loading...",
    };
  }
  const first_resolution = resolution[0];
  // If the resolution is the same for all dimensions, display it as a single line
  if (first_resolution.dimensionName === "All_") {
    return {
      type: first_resolution.parentType,
      resolution: ` ${first_resolution.resolutionWithUnit}`,
    };
  } else {
    let text = "";
    for (const res of resolution) {
      text += `${res.dimensionName}: ${res.resolutionWithUnit}, `;
    }
    text = text.slice(0, -2);
    return {
      type: first_resolution.parentType,
      resolution: text,
    };
  }
}

export class ScreenshotDialog extends Overlay {
  private nameInput: HTMLInputElement;
  private takeScreenshotButton: HTMLButtonElement;
  private closeMenuButton: HTMLButtonElement;
  private cancelScreenshotButton: HTMLButtonElement;
  private forceScreenshotButton: HTMLButtonElement;
  private statisticsTable: HTMLTableElement;
  private panelResolutionTable: HTMLTableElement;
  private layerResolutionTable: HTMLTableElement;
  private statisticsContainer: HTMLDivElement;
  private filenameAndButtonsContainer: HTMLDivElement;
  private screenshotSizeText: HTMLDivElement;
  private warningElement: HTMLDivElement;
  private statisticsKeyToCellMap: Map<string, HTMLTableCellElement> = new Map();
  private layerResolutionKeyToCellMap: Map<string, HTMLTableCellElement> =
    new Map();

  private throttledUpdateLayerResolutionTable = this.registerCancellable(
    throttle(() => {
      this.populateLayerResolutionTable();
    }, 1000),
  );
  constructor(private screenshotManager: ScreenshotManager) {
    super();

    this.initializeUI();
    this.setupEventListeners();
    this.screenshotManager.throttledSendStatistics();
  }

  private initializeUI() {
    this.content.classList.add("neuroglancer-screenshot-dialog");

    this.closeMenuButton = this.createButton(
      "Close",
      () => this.dispose(),
      "neuroglancer-screenshot-close-button",
    );
    this.cancelScreenshotButton = this.createButton("Cancel screenshot", () =>
      this.cancelScreenshot(),
    );
    this.takeScreenshotButton = this.createButton("Take screenshot", () =>
      this.screenshot(),
    );
    this.forceScreenshotButton = this.createButton("Force screenshot", () =>
      this.forceScreenshot(),
    );
    this.filenameAndButtonsContainer = document.createElement("div");
    this.filenameAndButtonsContainer.classList.add(
      "neuroglancer-screenshot-filename-and-buttons",
    );
    this.filenameAndButtonsContainer.appendChild(this.createNameInput());
    this.filenameAndButtonsContainer.appendChild(this.takeScreenshotButton);
    this.filenameAndButtonsContainer.appendChild(this.forceScreenshotButton);

    this.content.appendChild(this.closeMenuButton);
    this.content.appendChild(this.cancelScreenshotButton);
    this.content.appendChild(this.filenameAndButtonsContainer);
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(this.createPanelResolutionTable());
    this.content.appendChild(this.createLayerResolutionTable());
    this.content.appendChild(this.createStatisticsTable());
    this.updateUIBasedOnMode();
    this.populatePanelResolutionTable();
    this.throttledUpdateLayerResolutionTable();
  }

  private setupEventListeners() {
    this.registerDisposer(
      this.screenshotManager.screenshotFinished.add(() => {
        this.dispose();
      }),
    );
    this.registerDisposer(
      this.screenshotManager.statisticsUpdated.add((screenshotLoadStats) => {
        this.populateStatistics(screenshotLoadStats);
      }),
    );
    this.registerDisposer(
      this.screenshotManager.viewer.display.updateFinished.add(() => {
        this.throttledUpdateLayerResolutionTable();
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
    const scaleMenu = document.createElement("div");
    scaleMenu.classList.add("neuroglancer-screenshot-scale-menu");

    this.screenshotSizeText = document.createElement("div");
    this.screenshotSizeText.classList.add("neuroglancer-screenshot-size-text");
    scaleMenu.appendChild(this.screenshotSizeText);

    const scaleLabel = document.createElement("label");
    scaleLabel.textContent = "Screenshot scale factor:";
    scaleMenu.appendChild(scaleLabel);

    this.warningElement = document.createElement("div");
    this.warningElement.classList.add("neuroglancer-screenshot-warning");
    this.warningElement.textContent = "";

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
        this.handleScreenshotResize();
      });
    });
    scaleMenu.appendChild(this.warningElement);
    this.handleScreenshotResize();
    return scaleMenu;
  }

  private handleScreenshotResize() {
    const screenshotSize =
      this.screenshotManager.calculatedScaledAndClippedSize();
    if (screenshotSize.width * screenshotSize.height > LARGE_SCREENSHOT_SIZE) {
      this.warningElement.textContent =
        "Warning: large screenshots (bigger than 4096x4096) may fail";
    } else {
      this.warningElement.textContent = "";
    }
    this.screenshotSizeText.textContent = `Screenshot size: ${screenshotSize.width}px, ${screenshotSize.height}px`;
  }

  private createStatisticsTable() {
    this.statisticsContainer = document.createElement("div");
    this.statisticsContainer.classList.add(
      "neuroglancer-screenshot-statistics-title",
    );

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
      chunkUsageDescription: "",
      gpuMemoryUsageDescription: "",
      downloadSpeedDescription: "",
    };
    for (const key in orderedStatsRow) {
      const row = this.statisticsTable.insertRow();
      const keyCell = row.insertCell();
      const valueCell = row.insertCell();
      keyCell.textContent =
        statisticsNamesForUI[key as keyof typeof statisticsNamesForUI];
      valueCell.textContent =
        orderedStatsRow[key as keyof typeof orderedStatsRow];
      this.statisticsKeyToCellMap.set(key, valueCell);
    }

    this.populateStatistics(this.screenshotManager.screenshotLoadStats);
    this.statisticsContainer.appendChild(this.statisticsTable);
    return this.statisticsContainer;
  }

  private createPanelResolutionTable() {
    const resolutionTable = (this.panelResolutionTable =
      document.createElement("table"));
    resolutionTable.classList.add("neuroglancer-screenshot-resolution-table");
    resolutionTable.title = "Viewer resolution statistics";

    const headerRow = resolutionTable.createTHead().insertRow();
    const keyHeader = document.createElement("th");
    keyHeader.textContent = "Panel type";
    headerRow.appendChild(keyHeader);
    const valueHeader = document.createElement("th");
    valueHeader.textContent = "Resolution";
    headerRow.appendChild(valueHeader);
    return resolutionTable;
  }

  private populatePanelResolutionTable() {
    const resolutionTable = this.panelResolutionTable;
    const resolutions = getViewerPanelResolutions(
      this.screenshotManager.viewer.display.panels,
    );
    for (const resolution of resolutions) {
      const resolutionStrings = formatResolution(resolution);
      const row = resolutionTable.insertRow();
      const keyCell = row.insertCell();
      const valueCell = row.insertCell();
      keyCell.textContent = resolutionStrings.type;
      valueCell.textContent = resolutionStrings.resolution;
    }
    return resolutionTable;
  }

  private createLayerResolutionTable() {
    const resolutionTable = (this.layerResolutionTable =
      document.createElement("table"));
    resolutionTable.classList.add("neuroglancer-screenshot-resolution-table");
    resolutionTable.title = "Viewer resolution statistics";

    const headerRow = resolutionTable.createTHead().insertRow();
    const keyHeader = document.createElement("th");
    keyHeader.textContent = "Layer name";
    headerRow.appendChild(keyHeader);
    const typeHeader = document.createElement("th");
    typeHeader.textContent = "Type";
    headerRow.appendChild(typeHeader);
    const valueHeader = document.createElement("th");
    valueHeader.textContent = "Resolution";
    headerRow.appendChild(valueHeader);
    return resolutionTable;
  }

  private populateLayerResolutionTable() {
    const resolutionTable = this.layerResolutionTable;
    const resolutionMap = getViewerLayerResolutions(
      this.screenshotManager.viewer,
    );
    for (const [key, value] of resolutionMap) {
      const { name, type } = key;
      if (type === "MultiscaleMeshLayer") {
        continue;
      }
      const stringKey = `{${name}--${type}}`;
      let valueCell = this.layerResolutionKeyToCellMap.get(stringKey);
      if (valueCell === undefined) {
        const row = resolutionTable.insertRow();
        const keyCell = row.insertCell();
        const typeCell = row.insertCell();
        valueCell = row.insertCell();
        keyCell.textContent = name;
        typeCell.textContent =
          layerNamesForUI[type as keyof typeof layerNamesForUI];
        this.layerResolutionKeyToCellMap.set(stringKey, valueCell);
      }
      valueCell.textContent = formatResolution(value).resolution;
    }
  }

  private forceScreenshot() {
    this.screenshotManager.forceScreenshot();
    this.dispose();
  }

  private cancelScreenshot() {
    this.screenshotManager.cancelScreenshot();
    this.updateUIBasedOnMode();
  }

  private screenshot() {
    const filename = this.nameInput.value;
    this.screenshotManager.takeScreenshot(filename);
    // Delay the update because sometimes the screenshot is immediately taken
    // And the UI is disposed before the update can happen
    this.debouncedUpdateUIElements();
  }

  private populateStatistics(
    screenshotLoadStats: ScreenshotLoadStatistics | null,
  ) {
    const statsRow = this.parseStatistics(screenshotLoadStats);
    if (statsRow === null) {
      return;
    }

    for (const key in statsRow) {
      this.statisticsKeyToCellMap.get(key)!.textContent = String(
        statsRow[key as keyof typeof statsRow],
      );
    }
  }

  private parseStatistics(
    currentStatistics: ScreenshotLoadStatistics | null,
  ): UIScreenshotStatistics | null {
    if (currentStatistics === null) {
      return null;
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

    const downloadString =
      currentStatistics.visibleChunksDownloading == 0
        ? "0"
        : `${currentStatistics.visibleChunksDownloading} at ${latency.toFixed(0)}ms latency`;

    return {
      chunkUsageDescription: `${currentStatistics.visibleChunksGpuMemory} out of ${currentStatistics.visibleChunksTotal} (${percentLoaded.toFixed(2)}%)`,
      gpuMemoryUsageDescription: `${gpuMemoryUsageInMB.toFixed(0)}MB / ${totalMemoryInMB.toFixed(0)}MB (${percentGpuUsage.toFixed(2)}% of total)`,
      downloadSpeedDescription: downloadString,
    };
  }

  private debouncedUpdateUIElements = debounce(() => {
    this.updateUIBasedOnMode();
  }, 100);

  private updateUIBasedOnMode() {
    if (this.screenshotMode === ScreenshotMode.OFF) {
      this.forceScreenshotButton.disabled = true;
      this.cancelScreenshotButton.disabled = true;
      this.takeScreenshotButton.disabled = false;
      this.closeMenuButton.disabled = false;
      this.forceScreenshotButton.title = "";
    } else {
      this.forceScreenshotButton.disabled = false;
      this.cancelScreenshotButton.disabled = false;
      this.takeScreenshotButton.disabled = true;
      this.closeMenuButton.disabled = true;
      this.forceScreenshotButton.title =
        "Force a screenshot of the current view without waiting for all data to be loaded and rendered";
    }
    if (DEBUG_ALLOW_MENU_CLOSE) {
      this.closeMenuButton.disabled = false;
    }
  }

  get screenshotMode() {
    return this.screenshotManager.screenshotMode;
  }
}
