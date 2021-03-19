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

import {TrackableValue} from 'neuroglancer/trackable_value';
import {verifyFinitePositiveFloat} from 'neuroglancer/util/json';
import {VisibilityPriorityAggregator} from 'neuroglancer/visibility_priority/frontend';
import { NullarySignal } from './util/signal';

export const numRenderScaleHistogramBins = 40;
export const renderScaleHistogramBinSize = 0.5;
export const renderScaleHistogramOrigin = -4;

export function getRenderScaleHistogramOffset(renderScale: number): number {
  return (Math.log2(renderScale) - renderScaleHistogramOrigin) / renderScaleHistogramBinSize;
}

export function getRenderScaleFromHistogramOffset(offset: number): number {
  return 2 ** (offset * renderScaleHistogramBinSize + renderScaleHistogramOrigin);
}

export function trackableRenderScaleTarget(initialValue: number) {
  return new TrackableValue<number>(initialValue, verifyFinitePositiveFloat);
}

export class RenderScaleHistogram {
  visibility = new VisibilityPriorityAggregator();
  changed = new NullarySignal();

  /**
   * Frame number corresponding to the current histogram.
   */
  frameNumber = -1;

  /**
   * Maps from spatial scale (nanometers) to histogram row index in the range
   * `[0, spatialScales.size)`.
   */
  spatialScales = new Map<number, number>();

  /**
   * Current number of rows allocated for the histogram.
   */
  numHistogramRows = 1;

  /**
   * Initially allocate one row.
   */
  value = new Uint32Array(numRenderScaleHistogramBins * this.numHistogramRows * 2);

  begin(frameNumber: number) {
    if (frameNumber !== this.frameNumber) {
      this.value.fill(0);
      this.frameNumber = frameNumber;
      this.spatialScales.clear();
      this.changed.dispatch();
    }
  }

  /**
   * Adds a count to the histogram.
   *
   * @param spatialScale Spatial resolution of data in nanometers.
   * @param renderScale Rendered scale of data in screen pixels.
   * @param presentCount Number of present chunks.
   * @param notPresentCount Number of desired but not-present chunks.
   */
  add(spatialScale: number, renderScale: number, presentCount: number, notPresentCount: number) {
    let {spatialScales, numHistogramRows, value} = this;
    let spatialScaleIndex = spatialScales.get(spatialScale);
    if (spatialScaleIndex === undefined) {
      spatialScaleIndex = spatialScales.size;
      spatialScales.set(spatialScale, spatialScaleIndex);
    }
    if (spatialScaleIndex >= numHistogramRows) {
      this.numHistogramRows = numHistogramRows *= 2;
      const newValue = new Uint32Array(numHistogramRows * numRenderScaleHistogramBins * 2);
      newValue.set(value);
      this.value = value = newValue;
    }
    const index = spatialScaleIndex * numRenderScaleHistogramBins * 2 +
        Math.min(
            Math.max(0, Math.round(getRenderScaleHistogramOffset(renderScale))),
            numRenderScaleHistogramBins - 1);
    value[index] += presentCount;
    value[index + numRenderScaleHistogramBins] += notPresentCount;
  }
}
