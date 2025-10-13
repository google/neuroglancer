/**
 * @license
 * Copyright 2025 Google Inc.
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

import "#src/ui/annotation_properties.css";

import svg_info from "ikonate/icons/info.svg?raw";
import type {
  AnnotationColorPropertySpec,
  AnnotationPropertySpec,
} from "#src/annotation/index.js";
import { WatchableValue } from "#src/trackable_value.js";
import { createBoundedNumberInputElement } from "#src/ui/bounded_number_input.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { serializeColor, unpackRGB, unpackRGBA } from "#src/util/color.js";
import type { vec3 } from "#src/util/geom.js";
import { ColorWidget } from "#src/widget/color.js";
import { makeIcon } from "#src/widget/icon.js";

export type AnnotationColorKey = AnnotationColorPropertySpec["type"];
export type AnnotationPropertyType = AnnotationPropertySpec["type"];

export const ANNOTATION_TYPES: AnnotationPropertyType[] = [
  "bool",
  "rgb",
  "rgba",
  "float32",
  "int8",
  "int16",
  "int32",
  "uint8",
  "uint16",
  "uint32",
];

function createColorPreviewBox(hexColor: string) {
  const previewBox = document.createElement("div");
  const colorSwatch = document.createElement("span");

  colorSwatch.style.background = hexColor;
  previewBox.appendChild(colorSwatch);
  previewBox.className = "neuroglancer-annotation-property-color-preview";

  return previewBox;
}

export function createTextAreaElement(
  inputValue: string,
  readonly: boolean,
): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.rows = 1;
  textarea.classList.add("neuroglancer-annotation-textarea");
  textarea.value = String(inputValue || "");

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      textarea.blur();
    }
  });

  const calculateRows = (): number => {
    const minRows = 1;
    const maxRows = 15;

    const originalRows = textarea.rows;
    textarea.rows = 1;
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    const rows = Math.ceil(textarea.scrollHeight / lineHeight);

    textarea.rows = originalRows;
    if (rows > maxRows) {
      textarea.style.overflowY = "auto";
    } else {
      textarea.style.overflowY = "hidden";
    }
    return Math.max(minRows, Math.min(maxRows, rows));
  };

  const updateTextareaRows = () => {
    textarea.rows = calculateRows();
  };
  const debouncedUpdateTextareaSize =
    animationFrameDebounce(updateTextareaRows);

  textarea.addEventListener("input", debouncedUpdateTextareaSize);
  const resizeObserver = new ResizeObserver(() => {
    debouncedUpdateTextareaSize();
  });
  resizeObserver.observe(textarea);
  debouncedUpdateTextareaSize();

  textarea.dataset.readonly = String(readonly);
  textarea.disabled = readonly;
  textarea.autocomplete = "off";
  textarea.spellcheck = false;

  return textarea;
}

export function isEnumType(enumLabels?: string[]): boolean {
  return (enumLabels && enumLabels.length > 0) || false;
}

export function makeBoolCheckbox(
  value: boolean | number,
  onChange?: (event: Event) => void,
): HTMLInputElement {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(value);
  checkbox.classList.add("neuroglancer-annotation-property-checkbox");
  if (onChange) {
    checkbox.addEventListener("change", (event) => {
      onChange(event);
    });
  }
  return checkbox;
}

export function makeDescriptionIcon(description: string) {
  const icon = makeIcon({
    svg: svg_info,
    title: description,
    clickable: false,
  });
  icon.classList.add("neuroglancer-annotation-description-icon");
  return icon;
}

export function makeReadonlyColorProperty(
  packColor: number,
  type: AnnotationColorKey,
): HTMLDivElement {
  const isRGBA = type === "rgba";
  const colorContainer = document.createElement("div");
  colorContainer.classList.add("neuroglancer-annotation-property-container");
  colorContainer.dataset.readonly = "true";

  const hexValue = serializeColor(
    isRGBA ? unpackRGBA(packColor) : unpackRGB(packColor),
  ).toUpperCase();
  const colorPreview = createColorPreviewBox(hexValue);
  const colorText = document.createElement("span");
  colorText.textContent = hexValue;

  colorContainer.appendChild(colorPreview);
  colorContainer.appendChild(colorText);

  return colorContainer;
}

export function makeEditableColorProperty(
  packedColor: number,
  type: AnnotationColorKey,
): {
  element: HTMLElement;
  color: ColorWidget;
  model: WatchableValue<vec3>;
  alpha?: HTMLInputElement;
} {
  const isRGBA = type === "rgba";
  const colorContainer = document.createElement("div");
  colorContainer.classList.add("neuroglancer-annotation-property-container");
  colorContainer.dataset.readonly = "false";
  // Base rgb color setter
  const colorOnly = unpackRGB(packedColor);
  const watchableColor = new WatchableValue(colorOnly);
  const colorInput = new ColorWidget(watchableColor);
  colorInput.element.classList.add("neuroglancer-annotation-property-color");
  colorContainer.appendChild(colorInput.element);

  let alphaInput: HTMLInputElement | undefined;
  if (isRGBA) {
    // Extra alpha input
    alphaInput = createBoundedNumberInputElement(unpackRGBA(packedColor)[3], {
      numDecimals: 2,
      min: 0,
      max: 1,
      step: 0.01,
    });
    alphaInput.classList.add("neuroglancer-annotation-property-value-input");
    colorContainer.appendChild(alphaInput);
  }

  return {
    element: colorContainer,
    color: colorInput,
    model: watchableColor,
    alpha: alphaInput,
  };
}
