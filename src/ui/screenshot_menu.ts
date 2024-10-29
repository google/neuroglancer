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
 *
 * @file UI menu for taking screenshots from the viewer.
 */

import "#src/ui/screenshot_menu.css";
import svg_close from "ikonate/icons/close.svg?raw";
import svg_help from "ikonate/icons/help.svg?raw";
import { debounce, throttle } from "lodash-es";
import { Overlay } from "#src/overlay.js";
import type {
  ScreenshotLoadStatistics,
  ScreenshotManager,
} from "#src/util/screenshot_manager.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import type {
  DimensionResolutionStats,
  PanelViewport,
} from "#src/util/viewer_resolution_stats.js";
import {
  getViewerLayerResolutions,
  getViewerPanelResolutions,
} from "#src/util/viewer_resolution_stats.js";
import { makeCopyButton } from "#src/widget/copy_button.js";
import { makeIcon } from "#src/widget/icon.js";

// If DEBUG_ALLOW_MENU_CLOSE is true, the menu can be closed by clicking the close button
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

/**
 * Combine the resolution of all dimensions into a single string for UI display
 */
function formatPhysicalResolution(resolution: DimensionResolutionStats[]) {
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
      text += `<span class="neuroglancer-screenshot-dimension">${res.dimensionName}</span> ${res.resolutionWithUnit} `;
    }
    text = text.slice(0, -1);
    return {
      type: first_resolution.parentType,
      resolution: text,
    };
  }
}

/**
 * This menu allows the user to take a screenshot of the current view, with options to
 * set the filename, scale, and force the screenshot to be taken immediately.
 * Once a screenshot is initiated, the user is locked into the menu until the
 * screenshot is taken or cancelled, to prevent
 * the user from interacting with the viewer while the screenshot is being taken.
 *
 * The menu displays statistics about the current view, such as the number of loaded
 * chunks, GPU memory usage, and download speed. These are to inform the user about the
 * progress of the screenshot, as it may take some time to load all the data.
 *
 * The menu also displays the resolution of each panel in the viewer, as well as the resolution
 * of the voxels loaded for each Image, Volume, and Segmentation layer.
 * This is to inform the user about the the physical units of the data and panels,
 * and to help them decide on the scale of the screenshot.
 *
 * The screenshot menu supports keeping the slice view FOV fixed when changing the scale of the screenshot.
 * This will cause the viewer to zoom in or out to keep the same FOV in the slice view.
 * For example, an x2 scale will cause the viewer in slice views to zoom in by a factor of 2
 * such that when the number of pixels in the slice view is doubled, the FOV remains the same.
 */
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
  private footerScreenshotActionBtnsContainer: HTMLDivElement;
  private progressText: HTMLParagraphElement;
  private statisticsKeyToCellMap: Map<string, HTMLTableCellElement> = new Map();
  private layerResolutionKeyToCellMap: Map<string, HTMLTableCellElement> =
    new Map();

  private throttledUpdateTableStatistics = this.registerCancellable(
    throttle(() => {
      this.populateLayerResolutionTable();
      this.handleScreenshotResize();
      this.populatePanelResolutionTable();
    }, 500),
  );
  private screenshotWidth: number = 0;
  private screenshotHeight: number = 0;
  private screenshotSelectedValues: HTMLElement;
  constructor(private screenshotManager: ScreenshotManager) {
    super();

    this.initializeUI();
    this.setupEventListeners();
    this.screenshotManager.throttledSendStatistics();
  }

  dispose(): void {
    super.dispose();
    if (!DEBUG_ALLOW_MENU_CLOSE) {
      this.screenshotManager.screenshotScale = 1;
    }
  }

  private setupHelpTooltips() {
    const generalSettingsTooltip = makeIcon({ svg: svg_help });
    generalSettingsTooltip.classList.add("neuroglancer-screenshot-tooltip");
    generalSettingsTooltip.setAttribute(
      "data-tooltip",
      "In the main viewer, see the settings (cog icon, top right) for options to turn off the axis line indicators, the scale bar, and the default annotations (yellow bounding box)",
    );

    const orthographicSettingsTooltip = makeIcon({ svg: svg_help });
    orthographicSettingsTooltip.classList.add(
      "neuroglancer-screenshot-tooltip",
    );
    orthographicSettingsTooltip.setAttribute(
      "data-tooltip",
      "In the main viewer, press 'o' to toggle between perspective and orthographic views",
    );

    const scaleFactorHelpTooltip = makeIcon({ svg: svg_help });
    scaleFactorHelpTooltip.classList.add("neuroglancer-screenshot-tooltip");
    scaleFactorHelpTooltip.setAttribute(
      "data-tooltip",
      "Adjusting the scale will zoom out 2D cross-section panels by that factor unless the box is ticked to keep FOV fixed with scale changes. 3D panels always have fixed FOV regardless of the setting and scale factor.",
    );

    return {
      generalSettingsTooltip,
      orthographicSettingsTooltip,
      scaleFactorHelpTooltip,
    };
  }

  private initializeUI() {
    this.content.classList.add("neuroglancer-screenshot-dialog");
    const parentElement = this.content.parentElement;
    if (parentElement) {
      parentElement.classList.add("neuroglancer-screenshot-overlay");
    }

    const titleText = document.createElement("h2");
    titleText.classList.add("neuroglancer-screenshot-title-heading");
    titleText.textContent = "Screenshot";

    this.closeMenuButton = this.createButton(
      null,
      () => this.dispose(),
      "neuroglancer-screenshot-close-button",
      svg_close,
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
    const menuText = document.createElement("h3");
    menuText.classList.add("neuroglancer-screenshot-title-subheading");
    menuText.textContent = "Settings";
    const tooltip = this.setupHelpTooltips();
    menuText.appendChild(tooltip.generalSettingsTooltip);
    this.filenameAndButtonsContainer.appendChild(menuText);

    const nameInputLabel = document.createElement("label");
    nameInputLabel.textContent = "Screenshot name";
    this.filenameAndButtonsContainer.appendChild(nameInputLabel);
    this.filenameAndButtonsContainer.appendChild(this.createNameInput());

    const closeAndHelpContainer = document.createElement("div");
    closeAndHelpContainer.classList.add(
      "neuroglancer-screenshot-close-and-help",
    );

    closeAndHelpContainer.appendChild(titleText);
    closeAndHelpContainer.appendChild(this.closeMenuButton);

    // This is the header
    this.content.appendChild(closeAndHelpContainer);

    const mainBody = document.createElement("div");
    mainBody.classList.add("neuroglancer-screenshot-main-body-container");
    this.content.appendChild(mainBody);

    mainBody.appendChild(this.filenameAndButtonsContainer);
    mainBody.appendChild(this.createScaleRadioButtons());

    const previewContainer = document.createElement("div");
    previewContainer.classList.add(
      "neuroglancer-screenshot-resolution-preview-container",
    );
    const settingsPreview = document.createElement("div");
    settingsPreview.classList.add("neuroglancer-screenshot-resolution-table");
    const previewLabel = document.createElement("h2");
    previewLabel.textContent = "Preview";

    this.screenshotSizeText = document.createElement("div");
    this.screenshotSizeText.classList.add("neuroglancer-screenshot-size-text");
    const screenshotLabel = document.createElement("h3");
    screenshotLabel.textContent = "Screenshot size";
    this.screenshotSelectedValues = document.createElement("span");
    this.screenshotSelectedValues.textContent = `${this.screenshotWidth}px, ${this.screenshotHeight}px`;

    const screenshotCopyBtn = makeCopyButton({
      onClick: () => {},
    });
    screenshotCopyBtn.classList.add("neuroglancer-screenshot-copy-icon");
    screenshotCopyBtn.setAttribute("data-tooltip", "Copy to clipboard");

    this.screenshotSizeText.appendChild(screenshotLabel);
    this.screenshotSizeText.appendChild(this.screenshotSelectedValues);
    this.screenshotSizeText.appendChild(screenshotCopyBtn);

    previewContainer.appendChild(previewLabel);
    previewContainer.appendChild(settingsPreview);
    settingsPreview.appendChild(this.screenshotSizeText);
    settingsPreview.appendChild(this.createPanelResolutionTable());
    settingsPreview.appendChild(this.createLayerResolutionTable());

    mainBody.appendChild(previewContainer);
    mainBody.appendChild(this.createStatisticsTable());

    this.footerScreenshotActionBtnsContainer = document.createElement("div");
    this.footerScreenshotActionBtnsContainer.classList.add(
      "neuroglancer-screenshot-footer-container",
    );
    this.progressText = document.createElement("p");
    this.progressText.classList.add("neuroglancer-screenshot-progress-text");
    this.footerScreenshotActionBtnsContainer.appendChild(this.progressText);
    this.footerScreenshotActionBtnsContainer.appendChild(
      this.cancelScreenshotButton,
    );
    this.footerScreenshotActionBtnsContainer.appendChild(
      this.takeScreenshotButton,
    );
    this.footerScreenshotActionBtnsContainer.appendChild(
      this.forceScreenshotButton,
    );
    this.content.appendChild(this.footerScreenshotActionBtnsContainer);

    this.updateUIBasedOnMode();
    this.populatePanelResolutionTable();
    this.throttledUpdateTableStatistics();
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
        this.throttledUpdateTableStatistics();
      }),
    );
    this.registerDisposer(
      this.screenshotManager.zoomMaybeChanged.add(() => {
        this.populatePanelResolutionTable();
      }),
    );
  }

  private createNameInput(): HTMLInputElement {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Enter optional screenshot name";
    nameInput.classList.add("neuroglancer-screenshot-name-input");
    return (this.nameInput = nameInput);
  }

  private createButton(
    text: string | null,
    onClick: () => void,
    cssClass: string = "",
    svgUrl: string | null = null,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    if (svgUrl) {
      const icon = makeIcon({ svg: svgUrl });
      button.appendChild(icon);
    } else if (text) {
      button.textContent = text;
    }
    button.classList.add("neuroglancer-screenshot-button");
    if (cssClass) button.classList.add(cssClass);
    button.addEventListener("click", onClick);
    return button;
  }

  private createScaleRadioButtons() {
    const scaleMenu = document.createElement("div");
    scaleMenu.classList.add("neuroglancer-screenshot-scale-menu");
    // scaleMenu.appendChild(this.screenshotSizeText);

    const scaleLabel = document.createElement("label");
    scaleLabel.classList.add("neuroglancer-screenshot-scale-factor");
    scaleLabel.textContent = "Screenshot scale factor";

    const tooltip = this.setupHelpTooltips();
    scaleLabel.appendChild(tooltip.scaleFactorHelpTooltip);

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

    const keepSliceFOVFixedDiv = document.createElement("div");
    keepSliceFOVFixedDiv.classList.add(
      "neuroglancer-screenshot-keep-slice-label",
    );
    keepSliceFOVFixedDiv.textContent = "Keep slice FOV fixed with scale change";

    const keepSliceFOVFixedCheckbox = document.createElement("input");
    keepSliceFOVFixedCheckbox.classList.add(
      "neuroglancer-screenshot-keep-slice-fov-checkbox",
    );
    keepSliceFOVFixedCheckbox.type = "checkbox";
    keepSliceFOVFixedCheckbox.checked =
      this.screenshotManager.shouldKeepSliceViewFOVFixed;
    keepSliceFOVFixedCheckbox.addEventListener("change", () => {
      this.screenshotManager.shouldKeepSliceViewFOVFixed =
        keepSliceFOVFixedCheckbox.checked;
    });
    keepSliceFOVFixedDiv.appendChild(keepSliceFOVFixedCheckbox);
    scaleMenu.appendChild(keepSliceFOVFixedDiv);

    this.handleScreenshotResize();
    return scaleMenu;
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

    const headerRow = this.statisticsTable.createTHead().insertRow();
    const keyHeader = document.createElement("th");
    keyHeader.textContent = "Screenshot progress";
    headerRow.appendChild(keyHeader);
    const valueHeader = document.createElement("th");
    valueHeader.textContent = "";
    headerRow.appendChild(valueHeader);

    const descriptionRow = this.statisticsTable.createTHead().insertRow();
    const descriptionkeyHeader = document.createElement("th");
    descriptionkeyHeader.colSpan = 2;

    descriptionkeyHeader.textContent =
      "Screenshot will take when all the chunks are loaded. If GPU memory is full, screenshot will only take the successfully loaded chunks.";

    // It can be used to point to a docs page when complete
    // const descriptionLearnMoreLink = document.createElement("a");
    // descriptionLearnMoreLink.text = "Learn more";

    // descriptionkeyHeader.appendChild(descriptionLearnMoreLink);
    descriptionRow.appendChild(descriptionkeyHeader);

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

    const tooltip = this.setupHelpTooltips();
    keyHeader.appendChild(tooltip.orthographicSettingsTooltip);

    headerRow.appendChild(keyHeader);
    const pixelValueHeader = document.createElement("th");
    pixelValueHeader.textContent = "Pixel resolution";
    headerRow.appendChild(pixelValueHeader);
    const physicalValueHeader = document.createElement("th");
    physicalValueHeader.textContent = "Physical resolution";
    headerRow.appendChild(physicalValueHeader);
    return resolutionTable;
  }

  private populatePanelResolutionTable() {
    function formatPixelResolution(panelArea: PanelViewport, scale: number) {
      const width = Math.round(panelArea.right - panelArea.left) * scale;
      const height = Math.round(panelArea.bottom - panelArea.top) * scale;
      const type = panelArea.panelType;
      return { width, height, type };
    }

    // Clear the table before populating it
    while (this.panelResolutionTable.rows.length > 1) {
      this.panelResolutionTable.deleteRow(1);
    }
    const resolutionTable = this.panelResolutionTable;
    const resolutions = getViewerPanelResolutions(
      this.screenshotManager.viewer.display.panels,
    );
    for (const resolution of resolutions) {
      const physicalResolution = formatPhysicalResolution(
        resolution.physicalResolution,
      );
      const pixelResolution = formatPixelResolution(
        resolution.pixelResolution,
        this.screenshotManager.screenshotScale,
      );
      const row = resolutionTable.insertRow();
      const keyCell = row.insertCell();
      const pixelValueCell = row.insertCell();
      pixelValueCell.textContent = `${pixelResolution.width}x${pixelResolution.height} px`;
      const physicalValueCell = row.insertCell();
      keyCell.textContent = physicalResolution.type;
      physicalValueCell.innerHTML = physicalResolution.resolution;
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
    valueHeader.textContent = "Physical voxel resolution";
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
      valueCell.innerHTML = formatPhysicalResolution(value).resolution;
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

  private handleScreenshotResize() {
    const screenshotSize =
      this.screenshotManager.calculatedScaledAndClippedSize();
    if (screenshotSize.width * screenshotSize.height > LARGE_SCREENSHOT_SIZE) {
      this.warningElement.textContent =
        "Warning: large screenshots (bigger than 4096x4096) may fail";
    } else {
      this.warningElement.textContent = "";
    }
    this.screenshotWidth = screenshotSize.width;
    this.screenshotHeight = screenshotSize.height;
    // Update the screenshot size display whenever dimensions change
    this.updateScreenshotSizeDisplay();
    // this.screenshotSizeText.textContent = `Screenshot size: ${screenshotSize.width}px, ${screenshotSize.height}px`;
  }

  private updateScreenshotSizeDisplay() {
    if (this.screenshotSelectedValues) {
      this.screenshotSelectedValues.textContent = `${this.screenshotWidth}px x ${this.screenshotHeight}px`;
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
      this.progressText.textContent = "";
      this.closeMenuButton.disabled = false;
      this.forceScreenshotButton.title = "";
    } else {
      this.forceScreenshotButton.disabled = false;
      this.cancelScreenshotButton.disabled = false;
      this.takeScreenshotButton.disabled = true;
      this.progressText.textContent = "Screenshot in progress...";
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
