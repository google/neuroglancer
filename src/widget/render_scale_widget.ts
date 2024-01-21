/**
 * @license
 * Copyright 2019 Google Inc.
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

import "#src/widget/render_scale_widget.css";

import { debounce, throttle } from "lodash-es";
import type { UserLayer } from "#src/layer/index.js";
import type { RenderScaleHistogram } from "#src/render_scale_statistics.js";
import {
  getRenderScaleFromHistogramOffset,
  getRenderScaleHistogramOffset,
  numRenderScaleHistogramBins,
  renderScaleHistogramBinSize,
  renderScaleHistogramOrigin,
} from "#src/render_scale_statistics.js";
import type { TrackableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { serializeColor } from "#src/util/color.js";
import { hsvToRgb } from "#src/util/colorspace.js";
import { RefCounted } from "#src/util/disposable.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import { vec3 } from "#src/util/geom.js";
import { clampToInterval } from "#src/util/lerp.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import { numberToStringFixed } from "#src/util/number_to_string.js";
import { formatScaleWithUnitAsString } from "#src/util/si_units.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";

const updateInterval = 200;

const inputEventMap = EventActionMap.fromObject({
  mousedown0: { action: "set" },
  wheel: { action: "adjust-via-wheel" },
  dblclick0: { action: "reset" },
});

function formatPixelNumber(x: number) {
  if (x < 1 || x > 1024) {
    const exponent = Math.log2(x) | 0;
    const coeff = x / 2 ** exponent;
    return `${numberToStringFixed(coeff, 1)}p${exponent}`;
  }
  return Math.round(x) + "";
}

export interface RenderScaleWidgetOptions {
  histogram: RenderScaleHistogram;
  target: TrackableValueInterface<number>;
}

export class RenderScaleWidget extends RefCounted {
  label = document.createElement("div");
  element = document.createElement("div");
  canvas = document.createElement("canvas");
  legend = document.createElement("div");
  legendRenderScale = document.createElement("div");
  legendSpatialScale = document.createElement("div");
  legendChunks = document.createElement("div");
  protected logScaleOrigin = renderScaleHistogramOrigin;
  protected unitOfTarget = "px";
  private ctx = this.canvas.getContext("2d")!;
  hoverTarget = new WatchableValue<[number, number] | undefined>(undefined);
  private throttledUpdateView = this.registerCancellable(
    throttle(() => this.debouncedUpdateView(), updateInterval, {
      leading: true,
      trailing: true,
    }),
  );
  private debouncedUpdateView = this.registerCancellable(
    debounce(() => this.updateView(), 0),
  );

  adjustViaWheel(event: WheelEvent) {
    const deltaY = this.getWheelMoveValue(event);
    if (deltaY === 0) {
      return;
    }
    this.hoverTarget.value = undefined;
    const logScaleMax = Math.round(
      this.logScaleOrigin +
        numRenderScaleHistogramBins * renderScaleHistogramBinSize,
    );
    const targetValue = clampToInterval(
      [2 ** this.logScaleOrigin, 2 ** (logScaleMax - 1)],
      this.target.value * 2 ** Math.sign(deltaY),
    ) as number;
    this.target.value = targetValue;
    event.preventDefault();
  }

  constructor(
    public histogram: RenderScaleHistogram,
    public target: TrackableValueInterface<number>,
  ) {
    super();
    const {
      canvas,
      label,
      element,
      legend,
      legendRenderScale,
      legendSpatialScale,
      legendChunks,
    } = this;
    label.className = "neuroglancer-render-scale-widget-prompt";
    element.className = "neuroglancer-render-scale-widget";
    element.title = inputEventMap.describe();
    legend.className = "neuroglancer-render-scale-widget-legend";
    element.appendChild(label);
    element.appendChild(canvas);
    element.appendChild(legend);
    legendRenderScale.title = "Target resolution of data in screen pixels";
    legendChunks.title = "Number of chunks rendered";
    legend.appendChild(legendRenderScale);
    legend.appendChild(legendChunks);
    legend.appendChild(legendSpatialScale);
    this.registerDisposer(histogram.changed.add(this.throttledUpdateView));
    this.registerDisposer(
      histogram.visibility.changed.add(this.debouncedUpdateView),
    );
    this.registerDisposer(target.changed.add(this.debouncedUpdateView));
    this.registerDisposer(new MouseEventBinder(canvas, inputEventMap));
    this.registerDisposer(target.changed.add(this.debouncedUpdateView));
    this.registerDisposer(
      this.hoverTarget.changed.add(this.debouncedUpdateView),
    );

    const getTargetValue = (event: MouseEvent) => {
      const position =
        (event.offsetX / canvas.width) * numRenderScaleHistogramBins;
      return getRenderScaleFromHistogramOffset(position, this.logScaleOrigin);
    };
    this.registerEventListener(canvas, "pointermove", (event: MouseEvent) => {
      this.hoverTarget.value = [getTargetValue(event), event.offsetY];
    });

    this.registerEventListener(canvas, "pointerleave", () => {
      this.hoverTarget.value = undefined;
    });

    this.registerDisposer(
      registerActionListener<MouseEvent>(canvas, "set", (actionEvent) => {
        this.target.value = getTargetValue(actionEvent.detail);
      }),
    );

    this.registerDisposer(
      registerActionListener<WheelEvent>(
        canvas,
        "adjust-via-wheel",
        (actionEvent) => {
          this.adjustViaWheel(actionEvent.detail);
        },
      ),
    );

    this.registerDisposer(
      registerActionListener(canvas, "reset", (event) => {
        this.reset();
        event.preventDefault();
      }),
    );
    const resizeObserver = new ResizeObserver(() => this.debouncedUpdateView());
    resizeObserver.observe(canvas);
    this.registerDisposer(() => resizeObserver.disconnect());
    this.updateView();
  }

  getWheelMoveValue(event: WheelEvent) {
    return event.deltaY;
  }

  reset() {
    this.hoverTarget.value = undefined;
    this.target.reset();
  }

  updateView() {
    const { ctx } = this;
    const { canvas } = this;
    const width = (canvas.width = canvas.offsetWidth);
    const height = (canvas.height = canvas.offsetHeight);
    const targetValue = this.target.value;
    const hoverValue = this.hoverTarget.value;

    {
      const { legendRenderScale } = this;
      const value = hoverValue === undefined ? targetValue : hoverValue[0];
      const valueString = formatPixelNumber(value);
      legendRenderScale.textContent = valueString + " " + this.unitOfTarget;
    }

    function binToCanvasX(bin: number) {
      return (bin * width) / numRenderScaleHistogramBins;
    }

    ctx.clearRect(0, 0, width, height);

    const { histogram } = this;
    // histogram.begin(this.frameNumberCounter.frameNumber);
    const { value: histogramData, spatialScales } = histogram;

    if (!histogram.visibility.visible) {
      histogramData.fill(0);
    }

    const sortedSpatialScales = Array.from(spatialScales.keys());
    sortedSpatialScales.sort();

    const tempColor = vec3.create();

    let maxCount = 1;
    const numRows = spatialScales.size;
    let totalPresent = 0;
    let totalNotPresent = 0;
    for (let bin = 0; bin < numRenderScaleHistogramBins; ++bin) {
      let count = 0;
      for (let row = 0; row < numRows; ++row) {
        const index = row * numRenderScaleHistogramBins * 2 + bin;
        const presentCount = histogramData[index];
        const notPresentCount =
          histogramData[index + numRenderScaleHistogramBins];
        totalPresent += presentCount;
        totalNotPresent += notPresentCount;
        count += presentCount + notPresentCount;
      }
      maxCount = Math.max(count, maxCount);
    }
    totalNotPresent -= histogram.fakeChunkCount;

    const maxBarHeight = height;

    const yScale = maxBarHeight / Math.log(1 + maxCount);

    function countToCanvasY(count: number) {
      return height - Math.log(1 + count) * yScale;
    }

    let hoverSpatialScale: number | undefined = undefined;
    if (hoverValue !== undefined) {
      const i = Math.floor(
        getRenderScaleHistogramOffset(hoverValue[0], this.logScaleOrigin),
      );
      if (i >= 0 && i < numRenderScaleHistogramBins) {
        let sum = 0;
        const hoverY = hoverValue[1];
        for (
          let spatialScaleIndex = numRows - 1;
          spatialScaleIndex >= 0;
          --spatialScaleIndex
        ) {
          const spatialScale = sortedSpatialScales[spatialScaleIndex];
          const row = spatialScales.get(spatialScale)!;
          const index = 2 * row * numRenderScaleHistogramBins + i;
          const count =
            histogramData[index] +
            histogramData[index + numRenderScaleHistogramBins];
          if (count === 0) continue;
          const yStart = Math.round(countToCanvasY(sum));
          sum += count;
          const yEnd = Math.round(countToCanvasY(sum));
          if (yEnd <= hoverY && hoverY <= yStart) {
            hoverSpatialScale = spatialScale;
            break;
          }
        }
      }
    }
    if (hoverSpatialScale !== undefined) {
      totalPresent = 0;
      totalNotPresent = 0;
      const row = spatialScales.get(hoverSpatialScale)!;
      const baseIndex = 2 * row * numRenderScaleHistogramBins;
      for (let bin = 0; bin < numRenderScaleHistogramBins; ++bin) {
        const index = baseIndex + bin;
        totalPresent += histogramData[index];
        totalNotPresent += histogramData[index + numRenderScaleHistogramBins];
      }
      if (Number.isFinite(hoverSpatialScale)) {
        this.legendSpatialScale.textContent = formatScaleWithUnitAsString(
          hoverSpatialScale,
          "m",
          { precision: 2, elide1: false },
        );
      } else {
        this.legendSpatialScale.textContent = "unknown";
      }
    } else {
      this.legendSpatialScale.textContent = "";
    }

    this.legendChunks.textContent = `${totalPresent}/${
      totalPresent + totalNotPresent
    }`;

    const spatialScaleColors = sortedSpatialScales.map((spatialScale) => {
      const saturation = spatialScale === hoverSpatialScale ? 0.5 : 1;
      let hue;
      if (Number.isFinite(spatialScale)) {
        hue = (((Math.log2(spatialScale) * 0.1) % 1) + 1) % 1;
      } else {
        hue = 0;
      }
      hsvToRgb(tempColor, hue, saturation, 1);
      const presentColor = serializeColor(tempColor);
      hsvToRgb(tempColor, hue, saturation, 0.5);
      const notPresentColor = serializeColor(tempColor);
      return [presentColor, notPresentColor];
    });

    for (let i = 0; i < numRenderScaleHistogramBins; ++i) {
      let sum = 0;
      for (
        let spatialScaleIndex = numRows - 1;
        spatialScaleIndex >= 0;
        --spatialScaleIndex
      ) {
        const spatialScale = sortedSpatialScales[spatialScaleIndex];
        const row = spatialScales.get(spatialScale)!;
        const index = row * numRenderScaleHistogramBins * 2 + i;
        const presentCount = histogramData[index];
        const notPresentCount =
          histogramData[index + numRenderScaleHistogramBins];
        const count = presentCount + notPresentCount;
        if (count === 0) continue;
        const xStart = Math.round(binToCanvasX(i));
        const xEnd = Math.round(binToCanvasX(i + 1));
        const yStart = Math.round(countToCanvasY(sum));
        sum += count;
        const yEnd = Math.round(countToCanvasY(sum));
        const ySplit = (presentCount * yEnd + notPresentCount * yStart) / count;
        ctx.fillStyle = spatialScaleColors[spatialScaleIndex][1];
        ctx.fillRect(xStart, yEnd, xEnd - xStart, ySplit - yEnd);
        ctx.fillStyle = spatialScaleColors[spatialScaleIndex][0];
        ctx.fillRect(xStart, ySplit, xEnd - xStart, yStart - ySplit);
      }
    }

    {
      const value = targetValue;
      ctx.fillStyle = "#fff";
      const startOffset = binToCanvasX(
        getRenderScaleHistogramOffset(value, this.logScaleOrigin),
      );
      const lineWidth = 1;
      ctx.fillRect(Math.floor(startOffset), 0, lineWidth, height);
    }

    if (hoverValue !== undefined) {
      const value = hoverValue[0];
      ctx.fillStyle = "#888";
      const startOffset = binToCanvasX(
        getRenderScaleHistogramOffset(value, this.logScaleOrigin),
      );
      const lineWidth = 1;
      ctx.fillRect(Math.floor(startOffset), 0, lineWidth, height);
    }
  }
}

export class VolumeRenderingRenderScaleWidget extends RenderScaleWidget {
  protected unitOfTarget = "samples";
  protected logScaleOrigin = 1;

  getWheelMoveValue(event: WheelEvent) {
    return -event.deltaY;
  }
}

const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift+wheel": { action: "adjust-via-wheel" },
  "at:shift+dblclick0": { action: "reset" },
});

export function renderScaleLayerControl<
  LayerType extends UserLayer,
  WidgetType extends RenderScaleWidget,
>(
  getter: (layer: LayerType) => RenderScaleWidgetOptions,
  widgetClass: new (
    histogram: RenderScaleHistogram,
    target: TrackableValueInterface<number>,
  ) => WidgetType = RenderScaleWidget as new (
    histogram: RenderScaleHistogram,
    target: TrackableValueInterface<number>,
  ) => WidgetType,
): LayerControlFactory<LayerType, RenderScaleWidget> {
  return {
    makeControl: (layer, context) => {
      const { histogram, target } = getter(layer);
      const control = context.registerDisposer(
        new widgetClass(histogram, target),
      );
      return { control, controlElement: control.element };
    },
    activateTool: (activation, control) => {
      activation.bindInputEventMap(TOOL_INPUT_EVENT_MAP);
      activation.bindAction(
        "adjust-via-wheel",
        (event: ActionEvent<WheelEvent>) => {
          event.stopPropagation();
          event.preventDefault();
          control.adjustViaWheel(event.detail);
        },
      );
      activation.bindAction("reset", (event: ActionEvent<WheelEvent>) => {
        event.stopPropagation();
        event.preventDefault();
        control.reset();
      });
    },
  };
}
