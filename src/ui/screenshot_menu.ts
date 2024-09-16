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
import { debounce } from "lodash-es";
import { Overlay } from "#src/overlay.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import type {
  ScreenshotLoadStatistics,
  ScreenshotManager,
} from "#src/util/screenshot_manager.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import { VolumeRenderingRenderLayer } from "#src/volume_rendering/volume_render_layer.js";

const LARGE_SCREENSHOT_SIZE = 4096 * 4096;

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
  private takeScreenshotButton: HTMLButtonElement;
  private cancelScreenshotButton: HTMLButtonElement;
  private forceScreenshotButton: HTMLButtonElement;
  private statisticsTable: HTMLTableElement;
  private statisticsContainer: HTMLDivElement;
  private filenameAndButtonsContainer: HTMLDivElement;
  private screenshotSizeText: HTMLDivElement;
  private warningElement: HTMLDivElement;
  private statisticsKeyToCellMap: Map<string, HTMLTableCellElement> = new Map();
  constructor(private screenshotManager: ScreenshotManager) {
    super();

    this.initializeUI();
    this.setupEventListeners();
    this.parseLayerStatistics();
  }

  private initializeUI() {
    this.content.classList.add("neuroglancer-screenshot-dialog");

    this.cancelScreenshotButton = this.createButton(
      "Cancel",
      () => this.cancelScreenshot(),
      "neuroglancer-screenshot-close-button",
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

    this.content.appendChild(this.cancelScreenshotButton);
    this.content.appendChild(this.filenameAndButtonsContainer);
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(this.createStatisticsTable());
    this.updateUIBasedOnMode();
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
      timeElapsedString: "",
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

    this.populateStatistics();
    this.statisticsContainer.appendChild(this.statisticsTable);
    return this.statisticsContainer;
  }

  private forceScreenshot() {
    this.screenshotManager.forceScreenshot();
    this.dispose();
  }

  private cancelScreenshot() {
    this.screenshotManager.cancelScreenshot();
    this.dispose();
  }

  private screenshot() {
    const filename = this.nameInput.value;
    this.screenshotManager.takeScreenshot(filename);
    // Delay the update because sometimes the screenshot is immediately taken
    // And the UI is disposed before the update can happen
    this.debouncedUpdateUIElements();
  }

  private populateStatistics() {
    if (this.screenshotMode === ScreenshotMode.OFF) {
      return;
    }
    const statsRow = this.parseStatistics(
      this.screenshotManager.screenshotLoadStats,
    );
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
    const nowtime = Date.now();
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
    const passedTimeInSeconds =
      (nowtime - this.screenshotManager.screenshotStartTime) / 1000;

    return {
      timeElapsedString: `${passedTimeInSeconds.toFixed(0)} seconds`,
      chunkUsageDescription: `${currentStatistics.visibleChunksGpuMemory} out of ${currentStatistics.visibleChunksTotal} (${percentLoaded.toFixed(2)}%)`,
      gpuMemoryUsageDescription: `${gpuMemoryUsageInMB.toFixed(0)}MB / ${totalMemoryInMB.toFixed(0)}MB (${percentGpuUsage.toFixed(2)}% of total)`,
      downloadSpeedDescription: `${currentStatistics.visibleChunksDownloading} at ${latency.toFixed(0)}ms latency`,
    };
  }

  private parseLayerStatistics() {
    const layers =
      this.screenshotManager.viewer.layerManager.visibleRenderLayers;
    for (const layer of layers) {
      if (layer.role === RenderLayerRole.DATA) {
        console.log("Layer: ", layer);
        if (layer instanceof ImageRenderLayer) {
          // Use refCount to see if it is in any panels?
          console.log("ImageRenderLayer: ", layer);
          const sliceResolution = layer.renderScaleTarget.value;
          console.log("Slice Resolution: ", sliceResolution);
        }
        if (layer instanceof VolumeRenderingRenderLayer) {
          console.log("VolumeRenderingRenderLayer: ", layer);
          const volumeResolution = layer.depthSamplesTarget.value;
          console.log("Volume Resolution: ", volumeResolution);
          const physicalSpacing = layer.physicalSpacing;
          console.log("Physical Spacing: ", physicalSpacing);
          const resolutionIndex = layer.selectedDataResolution;
          console.log("Resolution Index: ", resolutionIndex);
        }
      }
    }
  }

  private debouncedUpdateUIElements = debounce(() => {
    this.updateUIBasedOnMode();
  }, 100);

  private updateUIBasedOnMode() {
    if (this.screenshotMode === ScreenshotMode.OFF) {
      this.forceScreenshotButton.disabled = true;
      this.takeScreenshotButton.disabled = false;
      this.forceScreenshotButton.title = "";
    } else {
      this.forceScreenshotButton.disabled = false;
      this.takeScreenshotButton.disabled = true;
      this.forceScreenshotButton.title =
        "Force a screenshot of the current view without waiting for all data to be loaded and rendered";
    }
    if (this.screenshotMode === ScreenshotMode.ON) {
      this.cancelScreenshotButton.textContent = "Cancel";
    } else {
      this.cancelScreenshotButton.textContent = "Close";
    }
  }

  get screenshotMode() {
    return this.screenshotManager.screenshotMode;
  }
}
