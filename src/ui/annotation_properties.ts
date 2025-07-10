import "#src/ui/annotation_properties.css";

import { WatchableValue } from "#src/trackable_value.js";
import { serializeColor, unpackRGB, unpackRGBA } from "#src/util/color.js";
import { ColorWidget } from "#src/widget/color.js";
import { AnnotationColorPropertySpec } from "../annotation";
import { createBoundedNumberInputElement } from "#src/ui/bounded_number_input.js";

export type AnnotationColorKey = AnnotationColorPropertySpec["type"];

function createColorPreviewBox(hexColor: string) {
  const previewBox = document.createElement("div");
  const colorSwatch = document.createElement("span");

  colorSwatch.style.background = hexColor;
  previewBox.appendChild(colorSwatch);
  previewBox.className = "neuroglancer-annotation-property-color-preview";

  return previewBox;
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
