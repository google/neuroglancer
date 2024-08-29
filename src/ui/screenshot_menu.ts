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

import type { Viewer } from "#src/viewer.js";

export class ScreenshotDialog extends Overlay {
  nameInput: HTMLInputElement;
  saveButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  forceScreenshotButton: HTMLButtonElement;
  inScreenshotMode: boolean;
  constructor(public viewer: Viewer) {
    super();

    this.content.classList.add("neuroglancer-screenshot-dialog");

    const closeButton = (this.closeButton = document.createElement("button"));
    closeButton.classList.add("close-button");
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => this.dispose());

    const nameInput = (this.nameInput = document.createElement("input"));
    nameInput.type = "text";
    nameInput.placeholder = "Enter filename...";

    const saveButton = this.createSaveButton();
    const forceScreenshotButton = this.createForceScreenshotButton();

    this.content.appendChild(closeButton);
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(nameInput);
    this.inScreenshotMode = this.viewer.display.inScreenshotMode;

    if (this.inScreenshotMode) {
      this.content.appendChild(forceScreenshotButton);
    } else {
      this.content.appendChild(saveButton);
    }

    this.registerDisposer(
      this.viewer.display.screenshotFinished.add(() => {
        this.debouncedShowSaveOrForceScreenshotButton();
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

  private debouncedShowSaveOrForceScreenshotButton = debounce(() => {
    this.showSaveOrForceScreenshotButton();
  }, 200);

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
