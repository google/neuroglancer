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
import {shareVisibility} from 'neuroglancer/shared_visibility_count/frontend';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec4} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {UseCount} from 'neuroglancer/util/use_count';
import {SharedObject} from 'neuroglancer/worker_rpc';
import {NullarySignal} from 'neuroglancer/util/signal';
import {rgbToHsv, hsvToRgb} from 'neuroglancer/util/colorspace';

export class Uint64MapEntry {
  constructor(public key: Uint64, public value: Uint64) {}
  toString() { return `${this.key}→${this.value}`; }
};

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
};

export interface SegmentationDisplayState extends VisibleSegmentsState {
  segmentSelectionState: SegmentSelectionState;
  segmentColorHash: SegmentColorHash;
  saturation: TrackableAlphaValue;
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

  // Apply saturation
  let hsv = new Float32Array(3);
  rgbToHsv(hsv, color[0], color[1], color[2]);
  hsv[1] *= displayState.saturation.value;
  let rgb = new Float32Array(3);
  hsvToRgb(rgb, hsv[0], hsv[1], hsv[2]);
  color[0] = rgb[0];
  color[1] = rgb[1];
  color[2] = rgb[2];

  // Color highlighted segments
  if(displayState.highlightedSegments.has(objectId)) {
    // Make it vivid blue for selection
    color[0] = 0.2;
    color[1] = 0.2;
    color[2] = 2.0;
    color[3] = 1.0;
  }
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

export class SegmentationLayerSharedObject extends SharedObject {
  visibilityCount = new UseCount();

  constructor(public chunkManager: ChunkManager, public displayState: SegmentationDisplayState) {
    super();
  }

  initializeCounterpartWithChunkManager(options: any) {
    let {displayState} = this;
    options['chunkManager'] = this.chunkManager.rpcId;
    options['visibleSegments'] = displayState.visibleSegments.rpcId;
    options['segmentEquivalences'] = displayState.segmentEquivalences.rpcId;
    super.initializeCounterpart(this.chunkManager.rpc!, options);
    shareVisibility(this);
  }
}
