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
import { throttle } from "lodash-es";
import { Overlay } from "#src/overlay.js";
import { StatusMessage } from "#src/status.js";
import { setClipboard } from "#src/util/clipboard.js";
import type {
  ScreenshotLoadStatistics,
  ScreenshotManager,
} from "#src/util/screenshot_manager.js";
import { MAX_RENDER_AREA_PIXELS } from "#src/util/screenshot_manager.js";
import { parseScale } from "#src/util/si_units.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import type {
  DimensionResolutionStats,
  PanelViewport,
} from "#src/util/viewer_resolution_stats.js";
import {
  getViewerResolutionMetadata,
  getViewerLayerResolutions,
  getViewerPanelResolutions,
} from "#src/util/viewer_resolution_stats.js";
import { makeCopyButton } from "#src/widget/copy_button.js";
import { makeIcon } from "#src/widget/icon.js";

// If DEBUG_ALLOW_MENU_CLOSE is true, the menu can be closed by clicking the close button
// Usually the user is locked into the screenshot menu until the screenshot is taken or cancelled
// Setting this to true, and setting the SCREENSHOT_MENU_CLOSE_TIMEOUT in screenshot_manager.ts
// to a high value can be useful for debugging canvas handling of the resize
// Also helpful for viewing the canvas at higher resolutions
const DEBUG_ALLOW_MENU_CLOSE = false;

// For easy access to UI elements
const PANEL_TABLE_HEADER_STRINGS = {
  type: "Panel type",
  pixelResolution: "Pixel resolution",
  physicalResolution: "Physical scale",
};
const LAYER_TABLE_HEADER_STRINGS = {
  name: "Layer name",
  type: "Data type",
  resolution: "Physical voxel resolution",
};
const TOOLTIPS = {
  generalSettingsTooltip:
    "In the main viewer, see the settings (cog icon, top right) for options to turn off the axis line indicators, the scale bar, and the default annotation yellow bounding box.",
  orthographicSettingsTooltip:
    "In the main viewer, press 'o' to toggle between perspective and orthographic views.",
  layerDataTooltip:
    "The highest loaded resolution of 2D image slices, 3D volume renderings, and 2D segmentation slices are shown here. Other layers are not shown.",
  scaleFactorHelpTooltip:
    "Adjusting the scale will zoom out 2D cross-section panels by that factor unless the box is ticked to keep the slice FOV fixed with scale changes. 3D panels always have fixed FOV regardless of the scale factor.",
  panelScaleTooltip:
    "Set the display scale or the 2D panel FOV (pixel resolution x physical scale) by hovering over the top left dimension indicator in the main viewer panels.",
};

interface UIScreenshotStatistics {
  chunkUsageDescription: string;
  gpuMemoryUsageDescription: string;
  downloadSpeedDescription: string;
}

interface ScreenshotMetadata {
  date: string;
  name: string;
  size: ScreenshotOrPanelSize;
  panels: PanelMetadata[];
  layers: LayerMetadata[];
}

interface ScreenshotOrPanelSize {
  width: number;
  height: number;
}

interface ResolutionMetadata {
  formattedScale: string; // Human-readable format (e.g., "8.75nm")
  dimension: string; // E.g., "Isotropic", "x", "y", "z"
  scale: number; // Actual scale value in SI unit
  unit: string; // SI unit
}

interface PanelResolutionMetadata extends ResolutionMetadata {
  panelViewportUnit: string;
}

interface PanelMetadata {
  type: string;
  pixelResolution: ScreenshotOrPanelSize;
  physicalScale: PanelResolutionMetadata[];
}

interface LayerMetadata {
  name: string;
  type: string;
  voxelResolution: ResolutionMetadata[];
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

function splitIntoLines(text: string, maxLineLength: number = 60): string {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + word).length > maxLineLength) {
      lines.push(currentLine.trim());
      currentLine = word + " ";
    } else {
      currentLine += word + " ";
    }
  }
  lines.push(currentLine.trim());

  return lines.join("\n");
}

/**
 * Combine the resolution of all dimensions into a single string for UI display
 */
function formatPhysicalResolution(resolution: DimensionResolutionStats[]) {
  if (resolution.length === 0) {
    return {
      type: "Loading...",
      resolution: "Data not loaded",
    };
  }

  const firstResolution = resolution[0];
  const type = firstResolution.panelType;

  if (firstResolution.dimensionName === "All_") {
    return {
      type,
      resolution: firstResolution.resolutionWithUnit,
    };
  }

  const resolutionHtml = resolution
    .map(
      (res) =>
        `<span class="neuroglancer-screenshot-dimension">${res.dimensionName}</span> ${res.resolutionWithUnit}`,
    )
    .join(" ");

  return {
    type,
    resolution: resolutionHtml,
  };
}

function formatPixelResolution(panelArea: PanelViewport) {
  const width = Math.round(panelArea.right - panelArea.left);
  const height = Math.round(panelArea.bottom - panelArea.top);
  const type = panelArea.panelType;
  return { width, height, type };
}

function parseResolution<T extends ResolutionMetadata>(
  fullResolution: string,
): T[] {
  const extractScaleAndUnit = (resolution: string) => {
    const [formattedScale, unit = ""] = resolution.split("/");
    return { formattedScale, unit };
  };

  const createResolutionData = (dimension: string, resolution: string): T => {
    const { formattedScale, unit } = extractScaleAndUnit(resolution);
    const scale = parseScale(formattedScale);
    if (!scale) throw new Error(`Invalid scale: ${resolution}`);

    return {
      formattedScale,
      dimension,
      scale: scale.scale,
      unit: scale.unit,
      ...(unit && { panelViewportUnit: unit }),
    } as T;
  };

  if (!fullResolution.includes(" ")) {
    return [createResolutionData("Uniform", fullResolution)];
  }

  return fullResolution
    .split(" ")
    .reduce<T[]>((result, value, index, array) => {
      if (index % 2 === 0)
        result.push(createResolutionData(value, array[index + 1]));
      return result;
    }, []);
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
  private filenameInputContainer: HTMLDivElement;
  private screenshotSizeText: HTMLDivElement;
  private warningElement: HTMLDivElement;
  private footerScreenshotActionBtnsContainer: HTMLDivElement;
  private progressText: HTMLParagraphElement;
  private scaleRadioButtonsContainer: HTMLDivElement;
  private keepSliceFOVFixedCheckbox: HTMLInputElement;
  private helpTooltips: {
    generalSettingsTooltip: HTMLElement;
    orthographicSettingsTooltip: HTMLElement;
    layerDataTooltip: HTMLElement;
    scaleFactorHelpTooltip: HTMLElement;
    panelScaleTooltip: HTMLElement;
  };
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
  private screenshotPixelSize: HTMLElement;
  constructor(private screenshotManager: ScreenshotManager) {
    super();

    this.initializeUI();
    this.setupEventListeners();
    this.screenshotManager.throttledSendStatistics();
  }

  dispose(): void {
    super.dispose();
    if (!DEBUG_ALLOW_MENU_CLOSE) {
      this.screenshotManager.shouldKeepSliceViewFOVFixed = true;
      this.screenshotManager.screenshotScale = 1;
      this.screenshotManager.cancelScreenshot();
    }
  }

  close(): void {
    if (
      this.screenshotMode !== ScreenshotMode.PREVIEW &&
      !DEBUG_ALLOW_MENU_CLOSE
    ) {
      StatusMessage.showTemporaryMessage(
        "Cannot close screenshot menu while a screenshot is in progress. Hit 'Cancel screenshot' to stop the screenshot, or 'Force screenshot' to screenshot the currently available data.",
        4000,
      );
    } else {
      super.close();
    }
  }

  private setupHelpTooltips() {
    const generalSettingsTooltip = makeIcon({
      svg: svg_help,
      title: splitIntoLines(TOOLTIPS.generalSettingsTooltip),
    });

    const orthographicSettingsTooltip = makeIcon({
      svg: svg_help,
      title: TOOLTIPS.orthographicSettingsTooltip,
    });
    orthographicSettingsTooltip.classList.add(
      "neuroglancer-screenshot-resolution-table-tooltip",
    );

    const layerDataTooltip = makeIcon({
      svg: svg_help,
      title: splitIntoLines(TOOLTIPS.layerDataTooltip),
    });
    layerDataTooltip.classList.add(
      "neuroglancer-screenshot-resolution-table-tooltip",
    );

    const scaleFactorHelpTooltip = makeIcon({
      svg: svg_help,
      title: splitIntoLines(TOOLTIPS.scaleFactorHelpTooltip),
    });

    const panelScaleTooltip = makeIcon({
      svg: svg_help,
      title: splitIntoLines(TOOLTIPS.panelScaleTooltip),
    });
    panelScaleTooltip.classList.add(
      "neuroglancer-screenshot-resolution-table-tooltip",
    );

    return (this.helpTooltips = {
      generalSettingsTooltip,
      orthographicSettingsTooltip,
      layerDataTooltip,
      scaleFactorHelpTooltip,
      panelScaleTooltip,
    });
  }

  private initializeUI() {
    const tooltips = this.setupHelpTooltips();
    this.content.classList.add("neuroglancer-screenshot-dialog");
    const parentElement = this.content.parentElement;
    if (parentElement) {
      parentElement.classList.add("neuroglancer-screenshot-overlay");
    }

    const titleText = document.createElement("h2");
    titleText.classList.add("neuroglancer-screenshot-title");
    titleText.textContent = "Screenshot";

    this.closeMenuButton = this.createButton(
      null,
      () => this.close(),
      "neuroglancer-screenshot-close-button",
      svg_close,
    );

    this.cancelScreenshotButton = this.createButton(
      "Cancel screenshot",
      () => this.cancelScreenshot(),
      "neuroglancer-screenshot-footer-button",
    );
    this.takeScreenshotButton = this.createButton(
      "Take screenshot",
      () => this.screenshot(),
      "neuroglancer-screenshot-footer-button",
    );
    this.forceScreenshotButton = this.createButton(
      "Force screenshot",
      () => this.forceScreenshot(),
      "neuroglancer-screenshot-footer-button",
    );
    this.filenameInputContainer = document.createElement("div");
    this.filenameInputContainer.classList.add(
      "neuroglancer-screenshot-filename-container",
    );
    const menuText = document.createElement("h3");
    menuText.classList.add("neuroglancer-screenshot-title-subheading");
    menuText.classList.add("neuroglancer-screenshot-title");
    menuText.textContent = "Settings";
    menuText.appendChild(tooltips.generalSettingsTooltip);
    this.filenameInputContainer.appendChild(menuText);

    const nameInputLabel = document.createElement("label");
    nameInputLabel.textContent = "Screenshot name";
    nameInputLabel.classList.add("neuroglancer-screenshot-label");
    nameInputLabel.classList.add("neuroglancer-screenshot-name-label");
    this.filenameInputContainer.appendChild(nameInputLabel);
    this.filenameInputContainer.appendChild(this.createNameInput());

    const closeAndHelpContainer = document.createElement("div");
    closeAndHelpContainer.classList.add("neuroglancer-screenshot-close");

    closeAndHelpContainer.appendChild(titleText);
    closeAndHelpContainer.appendChild(this.closeMenuButton);

    // This is the header
    this.content.appendChild(closeAndHelpContainer);

    const mainBody = document.createElement("div");
    mainBody.classList.add("neuroglancer-screenshot-main-body-container");
    this.content.appendChild(mainBody);

    mainBody.appendChild(this.filenameInputContainer);
    mainBody.appendChild(this.createScaleRadioButtons());

    const previewContainer = document.createElement("div");
    previewContainer.classList.add(
      "neuroglancer-screenshot-resolution-preview-container",
    );
    const settingsPreview = document.createElement("div");
    settingsPreview.classList.add(
      "neuroglancer-screenshot-resolution-table-container",
    );
    const previewTopContainer = document.createElement("div");
    previewTopContainer.classList.add(
      "neuroglancer-screenshot-resolution-preview-top-container",
    );
    previewTopContainer.style.display = "flex";
    const previewLabel = document.createElement("h2");
    previewLabel.classList.add("neuroglancer-screenshot-title");
    previewLabel.textContent = "Preview";

    this.screenshotSizeText = document.createElement("div");
    this.screenshotSizeText.classList.add("neuroglancer-screenshot-label");
    this.screenshotSizeText.classList.add("neuroglancer-screenshot-size-text");
    const screenshotLabel = document.createElement("h3");
    screenshotLabel.textContent = "Screenshot size";
    screenshotLabel.classList.add(
      "neuroglancer-screenshot-resolution-size-label",
    );
    this.screenshotPixelSize = document.createElement("span");
    this.screenshotPixelSize.classList.add(
      "neuroglancer-screenshot-resolution-size-value",
    );

    const screenshotCopyButton = makeCopyButton({
      title: "Copy table to clipboard",
      onClick: () => {
        const result = setClipboard(this.generateScreenshotMetadataJson());
        StatusMessage.showTemporaryMessage(
          result
            ? "Resolution metadata JSON copied to clipboard"
            : "Failed to copy resolution JSON to clipboard",
        );
      },
    });
    screenshotCopyButton.classList.add("neuroglancer-screenshot-copy-icon");

    this.screenshotSizeText.appendChild(screenshotLabel);
    this.screenshotSizeText.appendChild(this.screenshotPixelSize);

    previewContainer.appendChild(previewTopContainer);
    previewTopContainer.appendChild(previewLabel);
    previewTopContainer.appendChild(screenshotCopyButton);
    previewContainer.appendChild(this.screenshotSizeText);
    previewContainer.appendChild(settingsPreview);
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

    this.screenshotManager.previewScreenshot();
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

    const scaleLabel = document.createElement("label");
    scaleLabel.classList.add("neuroglancer-screenshot-scale-factor-label");
    scaleLabel.classList.add("neuroglancer-screenshot-label");
    scaleLabel.textContent = "Screenshot scale factor";

    scaleLabel.appendChild(this.helpTooltips.scaleFactorHelpTooltip);

    scaleMenu.appendChild(scaleLabel);

    this.scaleRadioButtonsContainer = document.createElement("div");
    this.scaleRadioButtonsContainer.classList.add(
      "neuroglancer-screenshot-scale-radio-container",
    );
    scaleMenu.appendChild(this.scaleRadioButtonsContainer);

    this.warningElement = document.createElement("div");
    this.warningElement.classList.add("neuroglancer-screenshot-warning");
    this.warningElement.textContent = "";

    const scales = [1, 2, 4];
    scales.forEach((scale) => {
      const container = document.createElement("div");
      const label = document.createElement("label");
      const input = document.createElement("input");

      input.type = "radio";
      input.name = "screenshot-scale";
      input.value = scale.toString();
      input.checked = scale === this.screenshotManager.screenshotScale;
      input.classList.add("neuroglancer-screenshot-scale-radio-input");

      label.appendChild(document.createTextNode(`${scale}x`));
      label.classList.add("neuroglancer-screenshot-scale-radio-label");

      container.classList.add("neuroglancer-screenshot-scale-radio-item");
      container.appendChild(input);
      container.appendChild(label);
      this.scaleRadioButtonsContainer.appendChild(container);

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
    keepSliceFOVFixedDiv.classList.add("neuroglancer-screenshot-label");
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
    this.keepSliceFOVFixedCheckbox = keepSliceFOVFixedCheckbox;
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
    this.statisticsContainer.style.padding = "1rem";

    this.statisticsTable = document.createElement("table");
    this.statisticsTable.classList.add(
      "neuroglancer-screenshot-statistics-table",
    );

    const headerRow = this.statisticsTable.createTHead().insertRow();
    const keyHeader = document.createElement("th");
    keyHeader.textContent = "Screenshot progress";
    keyHeader.classList.add("neuroglancer-screenshot-title");
    headerRow.appendChild(keyHeader);
    const valueHeader = document.createElement("th");
    valueHeader.textContent = "";
    headerRow.appendChild(valueHeader);

    const descriptionRow = this.statisticsTable.createTHead().insertRow();
    const descriptionkeyHeader = document.createElement("th");
    descriptionkeyHeader.classList.add(
      "neuroglancer-statistics-table-description-header",
    );
    descriptionkeyHeader.colSpan = 2;

    descriptionkeyHeader.textContent =
      "The screenshot will take when all the chunks are loaded. If GPU memory is full, the screenshot will only capture the successfully loaded chunks. A screenshot scale larger than 1 may cause new chunks to be downloaded once the screenshot is in progress.";

    // It can be used to point to a docs page when complete
    // const descriptionLearnMoreLink = document.createElement("a");
    // descriptionLearnMoreLink.text = "Learn more";
    // descriptionLearnMoreLink.classList.add("neuroglancer-statistics-table-description-link")

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
      keyCell.classList.add(
        "neuroglancer-screenshot-statistics-table-data-key",
      );
      const valueCell = row.insertCell();
      valueCell.classList.add(
        "neuroglancer-screenshot-statistics-table-data-value",
      );
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

    const headerRow = resolutionTable.createTHead().insertRow();
    const keyHeader = document.createElement("th");
    keyHeader.textContent = PANEL_TABLE_HEADER_STRINGS.type;
    keyHeader.appendChild(this.helpTooltips.orthographicSettingsTooltip);

    headerRow.appendChild(keyHeader);
    const pixelValueHeader = document.createElement("th");
    pixelValueHeader.textContent = PANEL_TABLE_HEADER_STRINGS.pixelResolution;
    headerRow.appendChild(pixelValueHeader);
    const physicalValueHeader = document.createElement("th");
    physicalValueHeader.textContent =
      PANEL_TABLE_HEADER_STRINGS.physicalResolution;
    physicalValueHeader.appendChild(this.helpTooltips.panelScaleTooltip);
    headerRow.appendChild(physicalValueHeader);
    return resolutionTable;
  }

  private populatePanelResolutionTable() {
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
      const pixelResolution = formatPixelResolution(resolution.pixelResolution);
      const row = resolutionTable.insertRow();
      const keyCell = row.insertCell();
      const pixelValueCell = row.insertCell();
      pixelValueCell.textContent = `${pixelResolution.width} x ${pixelResolution.height} px`;
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

    const headerRow = resolutionTable.createTHead().insertRow();
    const keyHeader = document.createElement("th");
    keyHeader.textContent = LAYER_TABLE_HEADER_STRINGS.name;
    keyHeader.appendChild(this.helpTooltips.layerDataTooltip);

    headerRow.appendChild(keyHeader);
    const typeHeader = document.createElement("th");
    typeHeader.textContent = LAYER_TABLE_HEADER_STRINGS.type;
    headerRow.appendChild(typeHeader);
    const valueHeader = document.createElement("th");
    valueHeader.textContent = LAYER_TABLE_HEADER_STRINGS.resolution;
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
  }

  private cancelScreenshot() {
    this.screenshotManager.cancelScreenshot(true /* shouldStayInPrevieMenu */);
    this.updateUIBasedOnMode();
  }

  private screenshot() {
    const filename = this.nameInput.value;
    this.screenshotManager.takeScreenshot(filename);
    this.updateUIBasedOnMode();
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
      this.screenshotManager.calculatedClippedViewportSize();
    const scale = this.screenshotManager.screenshotScale.toFixed(2);
    const numPixels = Math.round(Math.sqrt(MAX_RENDER_AREA_PIXELS));
    // Add a little to account for potential rounding errors
    if (
      (screenshotSize.width + 2) * (screenshotSize.height + 2) >=
      MAX_RENDER_AREA_PIXELS
    ) {
      this.warningElement.textContent = `Screenshots can't have more than ${numPixels}x${numPixels} total pixels, the scale factor was reduced to x${scale} to fit.`;
    } else {
      this.warningElement.textContent = "";
    }
    this.screenshotWidth = screenshotSize.width;
    this.screenshotHeight = screenshotSize.height;
    // Update the screenshot size display whenever dimensions change
    this.updateScreenshotSizeDisplay();
  }

  private updateScreenshotSizeDisplay() {
    if (this.screenshotPixelSize) {
      this.screenshotPixelSize.textContent = `${this.screenshotWidth} x ${this.screenshotHeight} px`;
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

  private generateScreenshotMetadataJson() {
    const screenshotSize = {
      width: this.screenshotWidth,
      height: this.screenshotHeight,
    };
    const { panelResolutionData, layerResolutionData } =
      getViewerResolutionMetadata(this.screenshotManager.viewer);

    const panelsMetadata = [];
    for (const resolution of panelResolutionData) {
      const panelMetadataItem: PanelMetadata = {
        type: resolution.type,
        pixelResolution: {
          width: resolution.width,
          height: resolution.height,
        },
        physicalScale: parseResolution(resolution.resolution),
      };
      panelsMetadata.push(panelMetadataItem);
    }

    const layersMetadata = [];
    for (const resolution of layerResolutionData) {
      const layerMetadataItem: LayerMetadata = {
        name: resolution.name,
        type: resolution.type,
        voxelResolution: parseResolution(resolution.resolution),
      };
      layersMetadata.push(layerMetadataItem);
    }

    const screenshotMetadata: ScreenshotMetadata = {
      date: new Date().toISOString(),
      name: this.nameInput.value,
      size: screenshotSize,
      panels: panelsMetadata,
      layers: layersMetadata,
    };

    return JSON.stringify(screenshotMetadata, null, 2);
  }

  private updateUIBasedOnMode() {
    if (this.screenshotMode === ScreenshotMode.PREVIEW) {
      this.nameInput.disabled = false;
      for (const radio of this.scaleRadioButtonsContainer.children) {
        for (const child of (radio as HTMLElement).children) {
          if (child instanceof HTMLInputElement) child.disabled = false;
        }
      }
      this.keepSliceFOVFixedCheckbox.disabled = false;
      this.forceScreenshotButton.disabled = true;
      this.cancelScreenshotButton.disabled = true;
      this.takeScreenshotButton.disabled = false;
      this.progressText.textContent = "";
      this.forceScreenshotButton.title = "";
    } else {
      this.nameInput.disabled = true;
      for (const radio of this.scaleRadioButtonsContainer.children) {
        for (const child of (radio as HTMLElement).children) {
          if (child instanceof HTMLInputElement) child.disabled = true;
        }
      }
      this.keepSliceFOVFixedCheckbox.disabled = true;
      this.forceScreenshotButton.disabled = false;
      this.cancelScreenshotButton.disabled = false;
      this.takeScreenshotButton.disabled = true;
      this.progressText.textContent = "Screenshot in progress...";
      this.forceScreenshotButton.title =
        "Force a screenshot of the current view without waiting for all data to be loaded and rendered";
    }
  }

  get screenshotMode() {
    return this.screenshotManager.screenshotMode;
  }
}
