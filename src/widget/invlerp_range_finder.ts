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
import { computePercentilesFromEmpiricalHistogram } from "#src/util/empirical_cdf.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import {
  dataTypeCompare,
  dataTypeIntervalEqual,
  defaultDataTypeRange,
} from "#src/util/lerp.js";
import { NullarySignal } from "#src/util/signal.js";
import type { HistogramSpecifications } from "#src/webgl/empirical_cdf.js";
import { copyHistogramToCPU } from "#src/webgl/empirical_cdf.js";
import "#src/widget/invlerp_range_finder.css";

const MAX_AUTO_RANGE_ITERATIONS = 16;
const FLOAT_EQUAL_TOLERANCE = 1e-3;

interface AutoRangeData {
  inputPercentileBounds: [number, number];
  autoComputeInProgress: boolean;
  previouslyComputedRanges: DataTypeInterval[];
  numIterationsThisCompute: number;
  invertedInitialRange: boolean;
  finishedLerpRange: DataTypeInterval | null;
}

interface ParentInvlerpWidget {
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
    previouslyComputedRanges: [],
    numIterationsThisCompute: 0,
    invertedInitialRange: false,
    finishedLerpRange: null,
  };
  finished = new NullarySignal();
  element: HTMLDivElement;

  constructor(public parent: ParentInvlerpWidget) {
    super();
    this.makeAutoRangeButtons(
      () => this.autoComputeRange(0.0, 1.0),
      () => this.autoComputeRange(0.01, 0.99),
      () => this.autoComputeRange(0.05, 0.95),
    );
  }

  get computedRange() {
    return this.autoRangeData.finishedLerpRange;
  }

  private wasInputInverted() {
    const { range } = this.parent.trackable.value;
    return range !== undefined && dataTypeCompare(range[0], range[1]) > 0;
  }

  autoComputeRange(minPercentile: number, maxPercentile: number) {
    if (!this.autoRangeData.autoComputeInProgress) {
      const { autoRangeData } = this;
      const { dataType, display } = this.parent;

      // Reset the auto-compute state
      autoRangeData.inputPercentileBounds = [minPercentile, maxPercentile];
      this.resetAutoRangeData(autoRangeData);
      autoRangeData.invertedInitialRange = this.wasInputInverted();
      display.force3DHistogramForAutoRange = true;

      // Create a large range to search over
      // It's easier to contract the range than to expand it
      const maxRange =
        dataType === DataType.FLOAT32
          ? ([-65536, 65536] as [number, number])
          : defaultDataTypeRange[dataType];
      this.setTrackableValue(maxRange, maxRange);
      display.scheduleRedraw();
    }
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
    const { range: newRange, window: newWindow } =
      computePercentilesFromEmpiricalHistogram(
        empiricalCdf,
        autoRangeData.inputPercentileBounds[0],
        autoRangeData.inputPercentileBounds[1],
        range,
        dataType,
      );

    // If the range remains constant over two iterations
    // or the range is a single value,
    // or if we've exceeded the maximum number of iterations, stop
    // For non-float32 data types we can exact match the range
    let foundRange = false;
    if (dataType !== DataType.FLOAT32) {
      foundRange = autoRangeData.previouslyComputedRanges.some((prevRange) =>
<<<<<<< HEAD
        dataTypeIntervalEqual(prevRange, newRange),
=======
        dataTypeIntervalEqual(dataType, prevRange, newRange),
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
      );
    } else {
      foundRange = autoRangeData.previouslyComputedRanges.some(
        (prevRange) =>
          Math.abs((prevRange[0] as number) - (newRange[0] as number)) <
            FLOAT_EQUAL_TOLERANCE &&
          Math.abs((prevRange[1] as number) - (newRange[1] as number)) <
            FLOAT_EQUAL_TOLERANCE,
      );
    }
    const rangeBoundsEqual = dataTypeCompare(newRange[0], newRange[1]) === 0;
    const exceededMaxIterations =
      autoRangeData.numIterationsThisCompute > MAX_AUTO_RANGE_ITERATIONS;
    autoRangeData.previouslyComputedRanges.push(newRange);
    ++autoRangeData.numIterationsThisCompute;
    if (foundRange || exceededMaxIterations || rangeBoundsEqual) {
      if (autoRangeData.invertedInitialRange) {
        newRange.reverse();
      }
      this.resetAutoRangeData(autoRangeData, true /* finished */);
      autoRangeData.finishedLerpRange = newRange;
      this.setTrackableValue(newRange, newWindow);
      this.finished.dispatch();
    } else {
      display.force3DHistogramForAutoRange = true;
      this.setTrackableValue(newRange, newRange);
    }
  }
  private resetAutoRangeData(
    autoRangeData: AutoRangeData,
    finished: boolean = false,
  ) {
    autoRangeData.autoComputeInProgress = !finished;
    autoRangeData.previouslyComputedRanges = [];
    autoRangeData.numIterationsThisCompute = 0;
    if (finished) {
      autoRangeData.invertedInitialRange = false;
    }
  }

  makeAutoRangeButtons(
    minMaxHandler: () => void,
    oneTo99Handler: () => void,
    fiveTo95Handler: () => void,
  ) {
    const parent = this.parent.element;
    this.element = document.createElement("div");
    const buttonContainer = this.element;
    buttonContainer.classList.add(
      "neuroglancer-invlerp-range-finder-button-container",
    );
    parent.appendChild(buttonContainer);

    const minMaxButton = document.createElement("button");
    minMaxButton.textContent = "Min-Max";
    minMaxButton.title = "Set range to the minimum and maximum values";
    minMaxButton.classList.add("neuroglancer-invlerp-range-finder-button");
    minMaxButton.addEventListener("click", minMaxHandler);
    buttonContainer.appendChild(minMaxButton);

    const midButton = document.createElement("button");
    midButton.textContent = "1-99%";
    midButton.title = "Set range to the 1st and 99th percentiles";
    midButton.classList.add("neuroglancer-invlerp-range-finder-button");
    midButton.addEventListener("click", oneTo99Handler);
    buttonContainer.appendChild(midButton);

    const highButton = document.createElement("button");
    highButton.textContent = "5-95%";
    highButton.title = "Set range to the 5th and 95th percentiles";
    highButton.classList.add("neuroglancer-invlerp-range-finder-button");
    highButton.addEventListener("click", fiveTo95Handler);
    buttonContainer.appendChild(highButton);
  }
}
