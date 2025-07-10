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

import type { AnnotationColorPropertySpec } from "#src/annotation/index.js";
import { WatchableValue } from "#src/trackable_value.js";
import { createBoundedNumberInputElement } from "#src/ui/bounded_number_input.js";
import { serializeColor, unpackRGB, unpackRGBA } from "#src/util/color.js";
import { ColorWidget } from "#src/widget/color.js";
import svg_info from "ikonate/icons/info.svg?raw";
import { makeIcon } from "#src/widget/icon.js";

export type AnnotationColorKey = AnnotationColorPropertySpec["type"];

function createColorPreviewBox(hexColor: string) {
  const previewBox = document.createElement("div");
  const colorSwatch = document.createElement("span");

  colorSwatch.style.background = hexColor;
  previewBox.appendChild(colorSwatch);
  previewBox.className = "neuroglancer-annotation-property-color-preview";

  return previewBox;
}

export function isBooleanType(enumLabels?: string[]): boolean {
  return (
    (enumLabels?.includes("False") &&
      enumLabels?.includes("True") &&
      enumLabels.length === 2) ||
    false
  );
}
export function isEnumType(enumLabels?: string[]): boolean {
  return (enumLabels && enumLabels.length > 0) || false;
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
  alpha?: HTMLInputElement;
} {
  const isRGBA = type === "rgba";
  const colorContainer = document.createElement("div");
  colorContainer.classList.add("neuroglancer-annotation-property-container");

  // Base rgb color setter
  const colorOnly = unpackRGB(packedColor);
  const watchableColor = new WatchableValue(colorOnly);
  const colorInput = new ColorWidget(watchableColor);
  colorInput.element.classList.add("neuroglancer-annotation-property-color");
  colorContainer.appendChild(colorInput.element);

  let alphaInput: HTMLInputElement | undefined;
  if (isRGBA) {
    // Extra alpha input
    alphaInput = createBoundedNumberInputElement({
      inputValue: unpackRGBA(packedColor)[3],
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
    alpha: alphaInput,
  };
}
