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
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { computeRangeForCdf } from "#src/util/empirical_cdf.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import {
  dataTypeCompare,
  dataTypeIntervalEqual,
  defaultDataTypeRange,
} from "#src/util/lerp.js";
import { Uint64 } from "#src/util/uint64.js";
import type { HistogramSpecifications } from "#src/webgl/empirical_cdf.js";
import { copyHistogramToCPU } from "#src/webgl/empirical_cdf.js";
import "#src/widget/invlerp_range_finder.css";

const MAX_AUTO_RANGE_ITERATIONS = 16;

interface AutoRangeData {
  inputPercentileBounds: [number, number];
  autoComputeInProgress: boolean;
  lastComputedLerpRange: DataTypeInterval | null;
  numIterationsThisCompute: number;
  invertedInitialRange: boolean;
}

interface ParentWidget {
  trackable: {
    value: {
      range?: DataTypeInterval;
      window: DataTypeInterval;
    };
  };
  dataType: DataType;
  display: DisplayContext;
  element: HTMLDivElement;
  histogramSpecifications: HistogramSpecifications;
  histogramIndex: number;
}

export class AutoRangeFinder extends RefCounted {
  autoRangeData: AutoRangeData = {
    inputPercentileBounds: [0, 1],
    autoComputeInProgress: false,
    lastComputedLerpRange: null,
    numIterationsThisCompute: 0,
    invertedInitialRange: false,
  };

  constructor(public parent: ParentWidget) {
    super();
    makeAutoRangeButtons(
      this.parent.element,
      () => this.autoComputeRange(0.0, 1.0),
      () => this.autoComputeRange(0.01, 0.99),
      () => this.autoComputeRange(0.05, 0.95),
    );
  }

  private wasInputInverted() {
    const { range } = this.parent.trackable.value;
    return range !== undefined && range[0] > range[1];
  }

  autoComputeRange(minPercentile: number, maxPercentile: number) {
    if (!this.autoRangeData.autoComputeInProgress) {
      const { autoRangeData } = this;
      const { trackable, dataType, display } = this.parent;

      // Reset the auto-compute state
      autoRangeData.inputPercentileBounds = [minPercentile, maxPercentile];
      autoRangeData.lastComputedLerpRange = null;
      autoRangeData.numIterationsThisCompute = 0;
      autoRangeData.autoComputeInProgress = true;
      autoRangeData.invertedInitialRange = this.wasInputInverted();
      display.force3DHistogramForAutoRange = true;

      // Create a large range to search over
      // It's easier to contract the range than to expand it
      const maxRange =
        dataType === DataType.FLOAT32
          ? ([-65536, 65536] as [number, number])
          : defaultDataTypeRange[dataType];
      trackable.value = {
        ...trackable.value,
        window: maxRange,
        range: maxRange,
      };
      display.scheduleRedraw();
    }
  }

  /**
   * Due to how the 3D histogram is computed, the lower bound of the range
   * can sometimes be 1 unit away from the minimum value of the data type.
   * This function checks if the lower bound is near the minimum value and
   * adjusts the range accordingly.
   */
  correctLowerBound(range: DataTypeInterval) {
    const { dataType } = this.parent;
    if (dataType !== DataType.UINT64) {
      const minRange = defaultDataTypeRange[dataType][0] as number;
      const lowerBound = range[0] as number;
      if (lowerBound === minRange + 1) {
        return [minRange, range[1]] as [number, number];
      }
    } else {
      const minRange = Uint64.ZERO;
      const lowerBound = range[0] as Uint64;
      const minRangePlusOne = new Uint64();
      Uint64.increment(minRangePlusOne, minRange);
      if (lowerBound === minRangePlusOne) {
        return [minRange, range[1]] as [Uint64, Uint64];
      }
    }
    return range;
  }

  setTrackableValue(range: DataTypeInterval, window: DataTypeInterval) {
    const hasRange = this.parent.trackable.value.range !== undefined;

    const ensureWindowBoundsNotEqual = (window: DataTypeInterval) => {
      if (dataTypeCompare(window[0], window[1]) === 0) {
        return defaultDataTypeRange[this.parent.dataType];
      }
      return window;
    };

    if (hasRange) {
      this.parent.trackable.value = {
        ...this.parent.trackable.value,
        range,
        window,
      };
    } else {
      this.parent.trackable.value = {
        ...this.parent.trackable.value,
        window: ensureWindowBoundsNotEqual(window),
      };
    }
  }

  public maybeAutoComputeRange() {
    if (!this.autoRangeData.autoComputeInProgress) {
      this.parent.display.force3DHistogramForAutoRange = false;
      return;
    }
    const { autoRangeData } = this;
    const {
      trackable,
      dataType,
      display,
      histogramSpecifications,
      histogramIndex,
    } = this.parent;
    const gl = display.gl;
    let { range } = trackable.value;
    if (range === undefined) {
      range = trackable.value.window;
    }

    // Read the histogram from the GPU and compute new range based on this
    const frameBuffer =
      histogramSpecifications.getFramebuffers(gl)[histogramIndex];
    frameBuffer.bind(256, 1);
    const empiricalCdf = copyHistogramToCPU(gl);
    let { range: newRange, window: newWindow } = computeRangeForCdf(
      empiricalCdf,
      autoRangeData.inputPercentileBounds[0],
      autoRangeData.inputPercentileBounds[1],
      range,
      dataType,
    );

    // If the range remains constant over two iterations
    // or if we've exceeded the maximum number of iterations, stop
    const foundRange =
      autoRangeData.lastComputedLerpRange !== null &&
      dataTypeIntervalEqual(
        dataType,
        newRange,
        autoRangeData.lastComputedLerpRange,
      );
    const exceededMaxIterations =
      autoRangeData.numIterationsThisCompute > MAX_AUTO_RANGE_ITERATIONS;
    autoRangeData.lastComputedLerpRange = newRange;
    ++autoRangeData.numIterationsThisCompute;
    if (foundRange || exceededMaxIterations) {
      newRange = this.correctLowerBound(newRange);
      if (autoRangeData.invertedInitialRange) {
        newRange.reverse();
      }
      autoRangeData.autoComputeInProgress = false;
      autoRangeData.lastComputedLerpRange = null;
      autoRangeData.numIterationsThisCompute = 0;
      autoRangeData.invertedInitialRange = false;
      this.setTrackableValue(newRange, newWindow);
    } else {
      display.force3DHistogramForAutoRange = true;
      this.setTrackableValue(newRange, newRange);
    }
  }
}

export function makeAutoRangeButtons(
  parent: HTMLDivElement,
  minMaxHandler: () => void,
  oneTo99Handler: () => void,
  fiveTo95Handler: () => void,
) {
  const buttonContainer = document.createElement("div");
  buttonContainer.classList.add("neuroglancer-auto-range-button-container");
  parent.appendChild(buttonContainer);

  const minMaxButton = document.createElement("button");
  minMaxButton.textContent = "Min-Max";
  minMaxButton.title = "Set range to the minimum and maximum values.";
  minMaxButton.classList.add("neuroglancer-auto-range-button");
  minMaxButton.addEventListener("click", minMaxHandler);
  buttonContainer.appendChild(minMaxButton);

  const midButton = document.createElement("button");
  midButton.textContent = "1-99%";
  midButton.title = "Set range to the 1st and 99th percentiles.";
  midButton.classList.add("neuroglancer-auto-range-button");
  midButton.addEventListener("click", oneTo99Handler);
  buttonContainer.appendChild(midButton);

  const highButton = document.createElement("button");
  highButton.textContent = "5-95%";
  highButton.title = "Set range to the 5th and 95th percentiles.";
  highButton.classList.add("neuroglancer-auto-range-button");
  highButton.addEventListener("click", fiveTo95Handler);
  buttonContainer.appendChild(highButton);
}
