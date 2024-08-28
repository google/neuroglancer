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

import { Overlay } from "#src/overlay.js";
import "#src/ui/screenshot_menu.css";

import type { Viewer } from "#src/viewer.js";

export class ScreenshotDialog extends Overlay {
  nameInput: HTMLInputElement;
  saveButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  forceScreenshotButton: HTMLButtonElement;
  constructor(public viewer: Viewer) {
    super();

    // TODO: this might be better as a menu, not a dialog.
    this.content.classList.add("neuroglancer-screenshot-dialog");

    const closeButton = (this.closeButton = document.createElement("button"));
    closeButton.classList.add("close-button");
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => this.dispose());

    const nameInput = (this.nameInput = document.createElement("input"));
    nameInput.type = "text";
    nameInput.placeholder = "Enter filename...";

    const saveButton = (this.saveButton = document.createElement("button"));
    saveButton.textContent = "Take screenshot";
    saveButton.title =
      "Take a screenshot of the current view and save it to a png file";
    saveButton.addEventListener("click", () => this.screenshot());

    const forceScreenshotButton = (this.forceScreenshotButton =
      document.createElement("button"));
    forceScreenshotButton.textContent = "Force screenshot";
    forceScreenshotButton.title =
      "Force a screenshot of the current view and save it to a png file";
    forceScreenshotButton.addEventListener("click", () => {
      this.viewer.display.forceScreenshot = true;
    });

    this.content.appendChild(closeButton);
    this.content.appendChild(this.createScaleRadioButtons());
    this.content.appendChild(nameInput);
    this.content.appendChild(saveButton);
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
      input.checked = scale === 1;
      label.appendChild(input);
      label.appendChild(document.createTextNode(`Scale ${scale}x`));
      scaleRadioButtons.appendChild(label);
      input.addEventListener("change", () => {
        this.viewer.screenshotHandler.screenshotScale = scale;
      });
    }
    return scaleRadioButtons;
  }

  private screenshot() {
    const filename = this.nameInput.value;
    this.viewer.screenshotHandler.screenshot(filename);
    this.viewer.display.forceScreenshot = false;
    this.dispose();
  }
}
