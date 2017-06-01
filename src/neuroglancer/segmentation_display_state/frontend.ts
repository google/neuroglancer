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
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {LayerSelectedValues, UserLayer} from 'neuroglancer/layer';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {forEachVisibleSegment, getObjectKey, VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec4} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {SharedObject} from 'neuroglancer/worker_rpc';

export class Uint64MapEntry {
  constructor(public key: Uint64, public value: Uint64) {}
  toString() {
    return `${this.key}→${this.value}`;
  }
}

export class SegmentSelectionState extends RefCounted {
  selectedSegment = new Uint64();
  hasSelectedSegment = false;
  changed = new NullarySignal();

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
    this.registerDisposer(layerSelectedValues.changed.add(() => {
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
}

export interface SegmentationDisplayState extends VisibleSegmentsState {
  segmentSelectionState: SegmentSelectionState;
  segmentColorHash: SegmentColorHash;
}

export interface SegmentationDisplayStateWithAlpha extends SegmentationDisplayState {
  objectAlpha: TrackableAlphaValue;
}

export interface SegmentationDisplayState3D extends SegmentationDisplayStateWithAlpha {
  objectToDataTransform: CoordinateTransform;
}

export function registerRedrawWhenSegmentationDisplayStateChanged(
    displayState: SegmentationDisplayState, renderLayer: {redrawNeeded: NullarySignal}&RefCounted) {
  const dispatchRedrawNeeded = renderLayer.redrawNeeded.dispatch;
  renderLayer.registerDisposer(displayState.segmentColorHash.changed.add(dispatchRedrawNeeded));
  renderLayer.registerDisposer(displayState.visibleSegments.changed.add(dispatchRedrawNeeded));
  renderLayer.registerDisposer(displayState.segmentEquivalences.changed.add(dispatchRedrawNeeded));
  renderLayer.registerDisposer(
      displayState.segmentSelectionState.changed.add(dispatchRedrawNeeded));
}

export function registerRedrawWhenSegmentationDisplayStateWithAlphaChanged(
    displayState: SegmentationDisplayStateWithAlpha,
    renderLayer: {redrawNeeded: NullarySignal}&RefCounted) {
  registerRedrawWhenSegmentationDisplayStateChanged(displayState, renderLayer);
  renderLayer.registerDisposer(
      displayState.objectAlpha.changed.add(renderLayer.redrawNeeded.dispatch));
}

export function registerRedrawWhenSegmentationDisplayState3DChanged(
    displayState: SegmentationDisplayState3D,
    renderLayer: {redrawNeeded: NullarySignal}&RefCounted) {
  registerRedrawWhenSegmentationDisplayStateWithAlphaChanged(displayState, renderLayer);
  renderLayer.registerDisposer(
      displayState.objectToDataTransform.changed.add(renderLayer.redrawNeeded.dispatch));
}

/**
 * Temporary value used by getObjectColor.
 */
const tempColor = vec4.create();

/**
 * Returns the alpha-premultiplied color to use.
 */
export function getObjectColor(
    displayState: SegmentationDisplayState, objectId: Uint64, alpha: number = 1) {
  const color = tempColor;
  color[3] = alpha;
  displayState.segmentColorHash.compute(color, objectId);
  if (displayState.segmentSelectionState.isSelected(objectId)) {
    for (let i = 0; i < 3; ++i) {
      color[i] = color[i] * 0.5 + 0.5;
    }
  }
  color[0] *= alpha;
  color[1] *= alpha;
  color[2] *= alpha;
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

const Base = withSharedVisibility(SharedObject);
export class SegmentationLayerSharedObject extends Base {
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
