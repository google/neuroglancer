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

import type { DisplayContext } from "#src/display_context.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type { HistogramSpecifications } from "#src/webgl/empirical_cdf.js";
import {
  COLORMAP_NAMES,
  colormapDisplayName,
  computeColormapColor,
} from "#src/webgl/colormaps.js";
import type {
  ColormapParameters,
  InvlerpParameters,
} from "#src/webgl/shader_ui_controls.js";
import type { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";
import { InvlerpWidget } from "#src/widget/invlerp.js";
import type { LegendShaderOptions } from "#src/widget/shader_controls.js";

const SWATCH_WIDTH = 200;
const SWATCH_HEIGHT = 16;

function renderColormapSwatch(
  canvas: HTMLCanvasElement,
  colormapName: (typeof COLORMAP_NAMES)[number],
) {
  canvas.width = SWATCH_WIDTH;
  canvas.height = SWATCH_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(SWATCH_WIDTH, SWATCH_HEIGHT);
  const { data } = imageData;
  for (let x = 0; x < SWATCH_WIDTH; x++) {
    const t = x / (SWATCH_WIDTH - 1);
    const [r, g, b] = computeColormapColor(colormapName, t);
    for (let y = 0; y < SWATCH_HEIGHT; y++) {
      const idx = (y * SWATCH_WIDTH + x) * 4;
      data[idx] = Math.round(r * 255);
      data[idx + 1] = Math.round(g * 255);
      data[idx + 2] = Math.round(b * 255);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Widget that combines a colormap picker (select + gradient swatch) with an
 * InvlerpWidget for range/histogram control.  Used for the `#uicontrol colormap`
 * directive.
 */
export class ColormapWidget extends RefCounted {
  element: HTMLElement;
  // Exposed for activateInvlerpTool compatibility
  readonly dataType: DataType;
  readonly trackable: WatchableValueInterface<InvlerpParameters>;

  constructor(
    visibility: WatchableVisibilityPriority,
    display: DisplayContext,
    dataType: DataType,
    colormapTrackable: WatchableValueInterface<ColormapParameters>,
    histogramSpecifications: HistogramSpecifications,
    histogramIndex: number,
    legendShaderOptions: LegendShaderOptions | undefined,
  ) {
    super();

    this.dataType = dataType;
    // ColormapParameters extends InvlerpParameters; all mutations spread existing
    // value so extra fields are preserved — safe to alias here.
    this.trackable =
      colormapTrackable as unknown as WatchableValueInterface<InvlerpParameters>;

    const container = (this.element = document.createElement("div"));
    container.classList.add("neuroglancer-colormap-widget");

    // Colormap picker row
    const pickerRow = document.createElement("div");
    pickerRow.classList.add("neuroglancer-colormap-picker-row");

    const select = document.createElement("select");
    select.classList.add("neuroglancer-colormap-select");
    for (const name of COLORMAP_NAMES) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = colormapDisplayName(name);
      select.appendChild(option);
    }
    select.value = colormapTrackable.value.colormap;

    const swatch = document.createElement("canvas");
    swatch.classList.add("neuroglancer-colormap-swatch");
    swatch.width = SWATCH_WIDTH;
    swatch.height = SWATCH_HEIGHT;
    renderColormapSwatch(swatch, colormapTrackable.value.colormap);

    select.addEventListener("change", () => {
      const name = select.value as (typeof COLORMAP_NAMES)[number];
      colormapTrackable.value = { ...colormapTrackable.value, colormap: name };
      renderColormapSwatch(swatch, name);
    });

    pickerRow.appendChild(select);
    pickerRow.appendChild(swatch);
    container.appendChild(pickerRow);

    // Sync select when trackable changes externally (e.g., JSON load)
    const updateSelect = () => {
      const name = colormapTrackable.value.colormap;
      if (select.value !== name) {
        select.value = name;
        renderColormapSwatch(swatch, name);
      }
    };
    this.registerDisposer(colormapTrackable.changed.add(updateSelect));

    // InvlerpWidget for range/histogram control — shares the same trackable;
    // spread-based mutations preserve the colormap/channel fields.
    const invlerpWidget = this.registerDisposer(
      new InvlerpWidget(
        visibility,
        display,
        dataType,
        this.trackable,
        histogramSpecifications,
        histogramIndex,
        legendShaderOptions,
      ),
    );
    container.appendChild(invlerpWidget.element);
  }
}
