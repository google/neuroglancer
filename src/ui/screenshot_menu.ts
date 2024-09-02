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

import { ScreenshotModes } from "#src/util/trackable_screenshot_mode.js";
import type { Viewer } from "#src/viewer.js";

export class ScreenshotDialog extends Overlay {
  private nameInput: HTMLInputElement;
  private saveButton: HTMLButtonElement;
  private closeButton: HTMLButtonElement;
  private forceScreenshotButton: HTMLButtonElement;
  private statisticsTable: HTMLTableElement;
  private statisticsContainer: HTMLDivElement;
  private filenameAndButtonsContainer: HTMLDivElement;
  private screenshotMode: ScreenshotModes;
  constructor(public viewer: Viewer) {
    super();
    this.screenshotMode = this.viewer.display.screenshotMode.value;

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
    this.filenameAndButtonsContainer = document.createElement("div");
    this.filenameAndButtonsContainer.classList.add(
      "neuroglancer-screenshot-filename-and-buttons",
    );
    this.filenameAndButtonsContainer.appendChild(this.createNameInput());
    this.filenameAndButtonsContainer.appendChild(
      this.getScreenshotButtonBasedOnMode,
    );

    this.content.appendChild(this.closeButton);
    this.content.appendChild(this.filenameAndButtonsContainer);
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(this.createStatisticsTable());
  }

  private setupEventListeners() {
    this.registerDisposer(
      this.viewer.screenshotActionHandler.sendScreenshotRequested.add(() => {
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
  }

  private createNameInput(): HTMLInputElement {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Enter filename...";
    nameInput.classList.add("neuroglancer-screenshot-name-input");
    return (this.nameInput = nameInput);
  }

  private get getScreenshotButtonBasedOnMode() {
    return this.screenshotMode === ScreenshotModes.OFF
      ? this.saveButton
      : this.forceScreenshotButton;
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
      input.checked = scale === this.screenshotHandler.screenshotScale;
      input.classList.add("neuroglancer-screenshot-scale-radio");

      label.appendChild(input);
      label.appendChild(document.createTextNode(`${scale}x`));

      scaleMenu.appendChild(label);

      input.addEventListener("change", () => {
        this.screenshotHandler.screenshotScale = scale;
      });
    });
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
    this.statisticsTable.title = "Screenshot statistics";

    const headerRow = this.statisticsTable.createTHead().insertRow();
    const keyHeader = document.createElement("th");
    keyHeader.textContent = "Key";
    headerRow.appendChild(keyHeader);
    const valueHeader = document.createElement("th");
    valueHeader.textContent = "Value";
    headerRow.appendChild(valueHeader);

    this.setTitleBarText();
    this.populateStatistics(undefined);
    return this.statisticsContainer;
  }

  private setTitleBarText() {
    const titleBarText =
      this.screenshotMode === ScreenshotModes.OFF
        ? "Start a screenshot to update statistics:"
        : "Screenshot in progress with the following statistics:";
    this.statisticsContainer.textContent = titleBarText;
    this.statisticsContainer.appendChild(this.statisticsTable);
  }

  private forceScreenshot() {
    this.screenshotHandler.forceScreenshot();
    this.debouncedShowSaveOrForceScreenshotButton();
  }

  private screenshot() {
    const filename = this.nameInput.value;
    this.screenshotHandler.screenshot(filename);
    this.debouncedShowSaveOrForceScreenshotButton();
  }

  private populateStatistics(actionState: StatisticsActionState | undefined) {
    if (actionState !== undefined) {
      while (this.statisticsTable.rows.length > 1) {
        this.statisticsTable.deleteRow(1);
      }
    }
    const statsRow = this.screenshotHandler.parseStatistics(actionState);

    for (const key in statsRow) {
      const row = this.statisticsTable.insertRow();
      const keyCell = row.insertCell();
      const valueCell = row.insertCell();
      keyCell.textContent = key;
      valueCell.textContent = String(statsRow[key as keyof typeof statsRow]);
    }
  }

  private debouncedShowSaveOrForceScreenshotButton = debounce(() => {
    this.showSaveOrForceScreenshotButton();
    this.setTitleBarText();
  }, 200);

  private showSaveOrForceScreenshotButton() {
    if (this.viewer.display.screenshotMode.value !== this.screenshotMode) {
      if (this.viewer.display.screenshotMode.value === ScreenshotModes.OFF) {
        this.filenameAndButtonsContainer.replaceChild(
          this.saveButton,
          this.forceScreenshotButton,
        );
      } else {
        this.filenameAndButtonsContainer.replaceChild(
          this.forceScreenshotButton,
          this.saveButton,
        );
      }
      this.screenshotMode = this.viewer.display.screenshotMode.value;
    }
  }

  get screenshotHandler() {
    return this.viewer.screenshotHandler;
  }
}
