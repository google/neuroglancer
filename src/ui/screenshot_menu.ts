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
  private titleBar: HTMLDivElement;
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

    this.content.appendChild(this.closeButton);
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(this.createNameInput());
    this.content.appendChild(this.modeDependentScreenshotButton);
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
    return (this.nameInput = nameInput);
  }

  private get modeDependentScreenshotButton() {
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
    const scaleRadioButtons = document.createElement("div");
    scaleRadioButtons.classList.add("scale-radio-buttons");

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
      label.appendChild(document.createTextNode(`Scale ${scale}x`));
      scaleRadioButtons.appendChild(label);

      input.addEventListener("change", () => {
        this.screenshotHandler.screenshotScale = scale;
      });
    });
    return scaleRadioButtons;
  }

  private createStatisticsTable() {
    this.titleBar = document.createElement("div");
    this.titleBar.classList.add("neuroglancer-screenshot-statistics-title");

    this.statisticsTable = document.createElement("table");
    this.statisticsTable.classList.add(
      "neuroglancer-screenshot-statistics-table",
    );
    this.statisticsTable.createTHead().insertRow().innerHTML =
      "<th>Key</th><th>Value</th>";
    this.statisticsTable.title = "Screenshot statistics";

    this.setTitleBarText();
    this.populateStatistics(undefined);
    return this.titleBar;
  }

  private setTitleBarText() {
    const titleBarText =
      this.screenshotMode === ScreenshotModes.OFF
        ? "Start screenshot mode to see statistics"
        : "Screenshot in progress with the following statistics:";
    this.titleBar.textContent = titleBarText;
    this.titleBar.appendChild(this.statisticsTable);
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
        this.content.replaceChild(this.saveButton, this.forceScreenshotButton);
      } else {
        this.content.replaceChild(this.forceScreenshotButton, this.saveButton);
      }
      this.screenshotMode = this.viewer.display.screenshotMode.value;
    }
  }

  get screenshotHandler() {
    return this.viewer.screenshotHandler;
  }
}
