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

import {MouseSelectionState, RenderLayer} from 'neuroglancer/layer';
import {Uint64} from 'neuroglancer/util/uint64';

export class PickIDManager {
  renderLayers: (RenderLayer|null)[] = [null];
  lowValues = [0];
  highValues = [0];

  constructor() {}

  clear() {
    this.renderLayers.length = 1;
    this.lowValues.length = 1;
    this.highValues.length = 1;
  }

  register(renderLayer: RenderLayer, x: Uint64): number {
    let {renderLayers, lowValues, highValues} = this;
    let id = renderLayers.length;
    renderLayers[id] = renderLayer;
    lowValues[id] = x.low;
    highValues[id] = x.high;
    return id;
  }

  /**
   * Set the object state according to the specified pick ID.
   */
  setMouseState(mouseState: MouseSelectionState, pickID: number) {
    mouseState.pickedRenderLayer = this.renderLayers[pickID];
    let {pickedValue} = mouseState;
    pickedValue.low = this.lowValues[pickID];
    pickedValue.high = this.highValues[pickID];
  }
};
