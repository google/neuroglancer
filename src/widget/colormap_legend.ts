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

import "#src/widget/colormap_legend.css";

import type { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { positionDropdown } from "#src/util/dropdown.js";
import {
  COLORMAP_NAMES,
  type ColormapName,
  colormapDisplayName,
  computeColormapColor,
} from "#src/webgl/colormaps.js";
import type { ColormapParameters } from "#src/webgl/shader_ui_controls.js";

const SWATCH_WIDTH = 200;
const SWATCH_HEIGHT = 16;

const OPTION_SWATCH_WIDTH = 60;
const OPTION_SWATCH_HEIGHT = 12;

function renderColormapSwatch(
  canvas: HTMLCanvasElement,
  colormapName: ColormapName,
  width = SWATCH_WIDTH,
  height = SWATCH_HEIGHT,
) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(width, height);
  const { data } = imageData;
  for (let x = 0; x < width; x++) {
    const t = x / (width - 1);
    const [r, g, b] = computeColormapColor(colormapName, t);
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      data[idx] = Math.round(r * 255);
      data[idx + 1] = Math.round(g * 255);
      data[idx + 2] = Math.round(b * 255);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Widget for the `#uicontrol colormap` directive: a custom dropdown of named
 * colormaps with swatch previews next to each name, plus a wider gradient
 * swatch preview of the current selection.
 */
export class ColormapWidget extends RefCounted {
  element: HTMLElement;
  private button: HTMLButtonElement;
  private dropdown: HTMLUListElement;
  private optionElements = new Map<ColormapName, HTMLLIElement>();
  private isOpen = false;
  private highlightedIndex = -1;
  private colormapTrackable: WatchableValueInterface<ColormapParameters>;

  constructor(colormapTrackable: WatchableValueInterface<ColormapParameters>) {
    super();
    this.colormapTrackable = colormapTrackable;

    const container = (this.element = document.createElement("div"));
    container.classList.add("neuroglancer-colormap-widget");

    const button = (this.button = document.createElement("button"));
    button.type = "button";
    button.classList.add("neuroglancer-colormap-select");
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");

    const nameLabel = document.createElement("span");
    nameLabel.classList.add("neuroglancer-colormap-select-name");
    const arrow = document.createElement("span");
    arrow.classList.add("neuroglancer-colormap-select-arrow");
    arrow.textContent = "▾";
    button.appendChild(nameLabel);
    button.appendChild(arrow);

    const swatch = document.createElement("canvas");
    swatch.classList.add("neuroglancer-colormap-swatch");
    swatch.width = SWATCH_WIDTH;
    swatch.height = SWATCH_HEIGHT;

    const dropdown = (this.dropdown = document.createElement("ul"));
    dropdown.classList.add("neuroglancer-colormap-dropdown");
    dropdown.setAttribute("role", "listbox");
    for (const name of COLORMAP_NAMES) {
      const option = document.createElement("li");
      option.classList.add("neuroglancer-colormap-option");
      option.setAttribute("role", "option");

      const optionSwatch = document.createElement("canvas");
      optionSwatch.classList.add("neuroglancer-colormap-option-swatch");
      renderColormapSwatch(
        optionSwatch,
        name,
        OPTION_SWATCH_WIDTH,
        OPTION_SWATCH_HEIGHT,
      );

      const label = document.createElement("span");
      label.classList.add("neuroglancer-colormap-option-name");
      label.textContent = colormapDisplayName(name);

      option.appendChild(optionSwatch);
      option.appendChild(label);
      // Prevent the trigger button from losing focus on click.
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => this.select(name));
      this.optionElements.set(name, option);
      dropdown.appendChild(option);
    }

    container.appendChild(button);
    container.appendChild(swatch);

    const syncFromTrackable = () => {
      const name = colormapTrackable.value.colormap;
      nameLabel.textContent = colormapDisplayName(name);
      renderColormapSwatch(swatch, name);
      for (const [optionName, optionEl] of this.optionElements) {
        optionEl.classList.toggle(
          "neuroglancer-colormap-option-selected",
          optionName === name,
        );
      }
    };
    syncFromTrackable();
    this.registerDisposer(colormapTrackable.changed.add(syncFromTrackable));

    button.addEventListener("click", () => {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    });
    button.addEventListener("keydown", (event) => this.handleKeyDown(event));
    button.addEventListener("blur", () => {
      // Defer so a click on a dropdown option can still register.
      setTimeout(() => {
        if (
          !this.dropdown.contains(document.activeElement) &&
          document.activeElement !== this.button
        ) {
          this.close();
        }
      }, 0);
    });

    this.registerDisposer(() => this.close());
  }

  private select(name: ColormapName) {
    this.colormapTrackable.value = { colormap: name };
    this.close();
    this.button.focus();
  }

  private open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.button.setAttribute("aria-expanded", "true");
    document.body.appendChild(this.dropdown);
    positionDropdown(this.dropdown, this.button, { maxWidth: false });
    const idx = COLORMAP_NAMES.indexOf(this.colormapTrackable.value.colormap);
    this.setHighlight(idx);
    document.addEventListener("mousedown", this.onDocumentMouseDown, true);
  }

  private close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.button.setAttribute("aria-expanded", "false");
    if (this.dropdown.parentNode) {
      this.dropdown.parentNode.removeChild(this.dropdown);
    }
    this.setHighlight(-1);
    document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
  }

  private onDocumentMouseDown = (event: MouseEvent) => {
    const target = event.target as Node;
    if (this.dropdown.contains(target) || this.button.contains(target)) return;
    this.close();
  };

  private setHighlight(index: number) {
    if (this.highlightedIndex >= 0) {
      const prev = this.optionElements.get(
        COLORMAP_NAMES[this.highlightedIndex],
      );
      prev?.classList.remove("neuroglancer-colormap-option-highlighted");
    }
    this.highlightedIndex = index;
    if (index >= 0 && index < COLORMAP_NAMES.length) {
      const cur = this.optionElements.get(COLORMAP_NAMES[index]);
      cur?.classList.add("neuroglancer-colormap-option-highlighted");
      cur?.scrollIntoView({ block: "nearest" });
    }
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && this.isOpen) {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.isOpen) {
        this.open();
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      let idx = this.highlightedIndex + delta;
      if (idx < 0) idx = 0;
      if (idx >= COLORMAP_NAMES.length) idx = COLORMAP_NAMES.length - 1;
      this.setHighlight(idx);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (!this.isOpen) {
        event.preventDefault();
        this.open();
        return;
      }
      if (this.highlightedIndex >= 0) {
        event.preventDefault();
        this.select(COLORMAP_NAMES[this.highlightedIndex]);
      }
    }
  }
}
