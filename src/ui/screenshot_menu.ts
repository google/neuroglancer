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
  filenameEditor: HTMLInputElement;
  saveScreenshotButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  constructor(public viewer: Viewer) {
    super();

    // TODO: this might be better as a menu, not a dialog.
    this.content.classList.add("neuroglancer-screenshot-dialog");

    const buttonClose = (this.closeButton = document.createElement("button"));
    buttonClose.classList.add("close-button");
    buttonClose.textContent = "Close";
    this.content.appendChild(buttonClose);
    buttonClose.addEventListener("click", () => this.dispose());

    this.filenameEditor = document.createElement("input");
    this.filenameEditor.type = "text";
    this.filenameEditor.placeholder = "Enter filename...";
    this.content.appendChild(this.filenameEditor);

    const saveScreenshotButton = (this.saveScreenshotButton =
      document.createElement("button"));
    saveScreenshotButton.textContent = "Download";
    saveScreenshotButton.title = "Download state as a JSON file";
    this.content.appendChild(saveScreenshotButton);
    saveScreenshotButton.addEventListener("click", () => this.screenshot());
  }

  screenshot() {
    const filename = this.filenameEditor.value;
    filename;
    //this.viewer.saveScreenshot(filename);
    this.dispose();
  }
}
