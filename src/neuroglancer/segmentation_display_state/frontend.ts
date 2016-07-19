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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {LayerSelectedValues, UserLayer} from 'neuroglancer/layer';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {VisibleSegmentsState, forEachVisibleSegment, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {SharedObject} from 'neuroglancer/worker_rpc';
import {Signal} from 'signals';

export class Uint64MapEntry {
  constructor(public key: Uint64, public value: Uint64) {}
  toString() { return `${this.key}→${this.value}`; }
};

export class SegmentSelectionState extends RefCounted {
  selectedSegment = new Uint64();
  hasSelectedSegment = false;
  changed = new Signal();

  set(value: Uint64|null|undefined) {
    if (value == null) {
      if (this.hasSelectedSegment) {
        this.hasSelectedSegment = false;
        this.changed.dispatch();
      }
    } else {
      let existingValue = this.selectedSegment;
      if (!this.hasSelectedSegment || value.low !== existingValue.low ||
          value.high !== existingValue.high) {
        existingValue.low = value.low;
        existingValue.high = value.high;
        this.hasSelectedSegment = true;
        this.changed.dispatch();
      }
    }
  }

  isSelected(value: Uint64) {
    return this.hasSelectedSegment && Uint64.equal(value, this.selectedSegment);
  }

  bindTo(layerSelectedValues: LayerSelectedValues, userLayer: UserLayer) {
    let temp = new Uint64();
    this.registerSignalBinding(layerSelectedValues.changed.add(() => {
      let value = layerSelectedValues.get(userLayer);
      if (typeof value === 'number') {
        temp.low = value;
        temp.high = 0;
        value = temp;
      } else if (value instanceof Uint64MapEntry) {
        value = value.value;
      }
      this.set(value);
    }));
  }
};

export interface SegmentationDisplayState extends VisibleSegmentsState {
  segmentSelectionState: SegmentSelectionState;
  segmentColorHash: SegmentColorHash;
}

export function registerRedrawWhenSegmentationDisplayStateChanged(
    displayState: SegmentationDisplayState, renderLayer: {redrawNeeded: Signal}&RefCounted) {
  let dispatchRedrawNeeded = () => { renderLayer.redrawNeeded.dispatch(); };
  renderLayer.registerSignalBinding(
      displayState.segmentColorHash.changed.add(dispatchRedrawNeeded));
  renderLayer.registerSignalBinding(displayState.visibleSegments.changed.add(dispatchRedrawNeeded));
  renderLayer.registerSignalBinding(
      displayState.segmentEquivalences.changed.add(dispatchRedrawNeeded));
  renderLayer.registerSignalBinding(
      displayState.segmentSelectionState.changed.add(dispatchRedrawNeeded));
}

/**
 * Temporary value used by getObjectColor.
 */
const tempColor = vec3.create();

export function getObjectColor(displayState: SegmentationDisplayState, objectId: Uint64) {
  const color = tempColor;
  displayState.segmentColorHash.compute(color, objectId);
  if (displayState.segmentSelectionState.isSelected(objectId)) {
    for (let i = 0; i < 3; ++i) {
      color[i] = color[i] * 0.5 + 0.5;
    }
  }
  return color;
}

export function forEachSegmentToDraw<SegmentData>(
    displayState: SegmentationDisplayState, objects: Map<string, SegmentData>,
    callback: (rootObjectId: Uint64, objectId: Uint64, segmentData: SegmentData) => void) {
  forEachVisibleSegment(displayState, (objectId, rootObjectId) => {
    const key = getObjectKey(objectId);
    const segmentData = objects.get(key);
    if (segmentData !== undefined) {
      callback(rootObjectId, objectId, segmentData);
    }
  });
}

export class SegmentationLayerSharedObject extends SharedObject {
  constructor(public chunkManager: ChunkManager, public displayState: SegmentationDisplayState) {
    super();
  }

  initializeCounterpartWithChunkManager(options: any) {
    let {displayState} = this;
    options['chunkManager'] = this.chunkManager.rpcId;
    options['visibleSegments'] = displayState.visibleSegments.rpcId;
    options['segmentEquivalences'] = displayState.segmentEquivalences.rpcId;
    super.initializeCounterpart(this.chunkManager.rpc!, options);
  }
}
