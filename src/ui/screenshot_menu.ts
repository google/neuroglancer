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

    this.content.classList.add("neuroglancer-screenshot-dialog");
    this.screenshotMode = this.viewer.display.screenshotMode.value;

    this.content.appendChild(this.createCloseButton());
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(this.createNameInput());
    this.content.appendChild(this.createSaveAndForceScreenshotButtons());
    this.content.appendChild(this.createStatisticsTable());

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
    this.closeButton;
  }

  private createSaveAndForceScreenshotButtons() {
    this.createSaveButton();
    this.createForceScreenshotButton();

    return this.screenshotMode === ScreenshotModes.OFF
      ? this.saveButton
      : this.forceScreenshotButton;
  }

  private createCloseButton() {
    const closeButton = (this.closeButton = document.createElement("button"));
    closeButton.classList.add("close-button");
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => this.dispose());
    return closeButton;
  }

  private createNameInput() {
    const nameInput = (this.nameInput = document.createElement("input"));
    nameInput.type = "text";
    nameInput.placeholder = "Enter filename...";
    return nameInput;
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
      input.checked = scale === this.screenshotHandler.screenshotScale;
      label.appendChild(input);
      label.appendChild(document.createTextNode(`Scale ${scale}x`));
      scaleRadioButtons.appendChild(label);
      input.addEventListener("change", () => {
        this.screenshotHandler.screenshotScale = scale;
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
    const titleBarText =
      this.screenshotMode !== ScreenshotModes.OFF
        ? "Screenshot in progress with the following statistics:"
        : "Start screenshot mode to see statistics";
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
      keyCell.textContent = key;
      const valueCell = row.insertCell();
      valueCell.textContent = String(statsRow[key as keyof typeof statsRow]);
    }
  }

  private debouncedShowSaveOrForceScreenshotButton = debounce(() => {
    this.showSaveOrForceScreenshotButton();
    this.setTitleBarText();
  }, 200);

  private showSaveOrForceScreenshotButton() {
    // Check to see if the global state matches the current state of the dialog
    if (this.viewer.display.screenshotMode.value === this.screenshotMode) {
      return;
    }
    if (this.viewer.display.screenshotMode.value === ScreenshotModes.OFF) {
      this.content.replaceChild(this.saveButton, this.forceScreenshotButton);
    } else {
      this.content.replaceChild(this.forceScreenshotButton, this.saveButton);
    }
    this.screenshotMode = this.viewer.display.screenshotMode.value;
  }

  get screenshotHandler() {
    return this.viewer.screenshotHandler;
  }
}
