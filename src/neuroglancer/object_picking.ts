/**
 * @license
 * Copyright 2016 Google Inc.
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

import {MouseSelectionState} from 'neuroglancer/layer';
import {RenderLayer} from 'neuroglancer/renderlayer';
import {Uint64} from 'neuroglancer/util/uint64';

const DEBUG_PICKING = false;

export class PickIDManager {
  /**
   * This specifies the render layer corresponding to each registered entry.
   */
  private renderLayers: (RenderLayer|null)[] = [null];

  private pickData: any[] = [null];

  /**
   * This contains 3 consecutive values, specifying (startPickID, low, high), for each registered
   * entry.  startPickID specifies the first uint32 pick ID corresponding to the entry.  low and
   * high specify two additional numbers associated with the entry.
   */
  private values = [0, 0, 0];

  private nextPickID = 1;

  constructor() {}

  clear() {
    this.renderLayers.length = 1;
    this.pickData.length = 1;
    this.values.length = 3;
    this.nextPickID = 1;
  }

  registerUint64(renderLayer: RenderLayer, x: Uint64, count = 1, data: any = null): number {
    return this.register(renderLayer, count, x.low, x.high, data);
  }

  register(renderLayer: RenderLayer, count = 1, low = 0, high = 0, data: any = null): number {
    let {renderLayers, values} = this;
    let pickID = this.nextPickID;
    this.nextPickID += count;
    let index = renderLayers.length;
    renderLayers[index] = renderLayer;
    let valuesOffset = index * 3;
    values[valuesOffset] = pickID;
    values[valuesOffset + 1] = low;
    values[valuesOffset + 2] = high;
    this.pickData[index] = data;
    return pickID;
  }

  /**
   * Set the object state according to the specified pick ID.
   */
  setMouseState(mouseState: MouseSelectionState, pickID: number) {
    // Binary search to find largest registered index with a pick ID <= pickID.
    const {renderLayers, values} = this;
    let lower = 0, upper = renderLayers.length - 1;
    while (lower < upper) {
      const mid = Math.ceil(lower + (upper - lower) / 2);
      if (values[mid * 3] > pickID) {
        upper = mid - 1;
      } else {
        lower = mid;
      }
    }
    const pickedRenderLayer = mouseState.pickedRenderLayer = renderLayers[lower];
    const valuesOffset = lower * 3;
    const pickedOffset = mouseState.pickedOffset = pickID - values[valuesOffset];
    if (DEBUG_PICKING) {
      console.log(
          `Looking up pick ID ${pickID}: renderLayer`, pickedRenderLayer, `offset=${pickedOffset}`);
    }
    let {pickedValue} = mouseState;
    pickedValue.low = values[valuesOffset + 1];
    pickedValue.high = values[valuesOffset + 2];
    mouseState.pickedAnnotationId = undefined;
    mouseState.pickedAnnotationLayer = undefined;
    mouseState.pickedAnnotationBuffer = undefined;
    mouseState.pickedAnnotationBufferBaseOffset = undefined;
    mouseState.pickedAnnotationIndex = undefined;
    mouseState.pickedAnnotationCount = undefined;
    mouseState.pickedAnnotationType = undefined;
    const data = this.pickData[lower];
    if (pickedRenderLayer !== null) {
      if (DEBUG_PICKING) {
        console.log(
            `Picked value=${pickedValue}, offset=${pickedOffset}, data=${this.pickData[lower]}`);
      }
      pickedRenderLayer.updateMouseState(mouseState, pickedValue, pickedOffset, data);
    }
  }
}
