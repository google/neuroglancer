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

import {LayerChunkProgressInfo} from 'neuroglancer/chunk_manager/base';
import {ChunkManager, ChunkRenderLayerFrontend} from 'neuroglancer/chunk_manager/frontend';
import {LayerSelectedValues} from 'neuroglancer/layer';
import {WatchableRenderLayerTransform} from 'neuroglancer/render_coordinate_transform';
import {RenderScaleHistogram} from 'neuroglancer/render_scale_statistics';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {SegmentLabelMap} from 'neuroglancer/segmentation_display_state/property_map';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Uint64Map} from 'neuroglancer/uint64_map';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec4} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';

export class Uint64MapEntry {
  constructor(public key: Uint64, public value?: Uint64, public label?: string|undefined) {}
  toString() {
    const {key, value, label} = this;
    let baseString: string;
    if (value === undefined) {
      baseString = `${key}`;
    } else {
      baseString = `${key}→${value}`;
    }
    if (label === undefined) return baseString;
    return `${baseString} ${label}`;
  }
}

export class SegmentSelectionState extends RefCounted {
  selectedSegment = new Uint64();
  hasSelectedSegment = false;
  changed = new NullarySignal();

  get value() {
    return this.hasSelectedSegment ? this.selectedSegment : undefined;
  }

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

  bindTo(layerSelectedValues: LayerSelectedValues, userLayer: SegmentationUserLayer) {
    let temp = new Uint64();
    this.registerDisposer(layerSelectedValues.changed.add(() => {
      const state = layerSelectedValues.get(userLayer);
      let value: any = undefined;
      if (state !== undefined) {
        value = state.value;
        if (typeof value === 'number') {
          temp.low = value;
          temp.high = 0;
          value = temp;
        } else if (value instanceof Uint64MapEntry) {
          value = value.value || value.key;
        }
        if (value != null && value.low === 0 && value.high === 0 &&
            userLayer.displayState.hideSegmentZero.value) {
          value = undefined;
        }
      }
      this.set(value);
    }));
  }
}

export interface SegmentationDisplayState extends VisibleSegmentsState {
  segmentSelectionState: SegmentSelectionState;
  segmentColorHash: SegmentColorHash;
  segmentStatedColors: Uint64Map;
  saturation: TrackableAlphaValue;
  highlightedSegments: Uint64Set;
  /**
   * Maximum length of base-10 representation of id seen.
   */
  maxIdLength: WatchableValueInterface<number>;
  segmentLabelMap: WatchableValueInterface<SegmentLabelMap|undefined>;

  selectSegment: (id: Uint64, pin: boolean|'toggle') => void;
  filterBySegmentLabel: (id: Uint64) => void;
}

export function updateIdStringWidth(idStringWidth: WatchableValueInterface<number>, idString: string) {
  const {length} = idString;
  if (idStringWidth.value < length) {
    idStringWidth.value = length;
  }
}

export interface SegmentationDisplayStateWithAlpha extends SegmentationDisplayState {
  objectAlpha: TrackableAlphaValue;
}

export interface SegmentationDisplayState3D extends SegmentationDisplayStateWithAlpha {
  transform: WatchableRenderLayerTransform;
  renderScaleHistogram: RenderScaleHistogram;
  renderScaleTarget: TrackableValue<number>;
  // Specifies whether to write to the pick buffer when rendering with transparency.  This prevents
  // any object behind the transparent object from being picked.  When not rendering with
  // transparency, the pick buffer is always written (since there is no downside).
  transparentPickEnabled: WatchableValueInterface<boolean>;
}

export function registerRedrawWhenSegmentationDisplayStateChanged(
    displayState: SegmentationDisplayState, renderLayer: {redrawNeeded: NullarySignal}&RefCounted) {
  const dispatchRedrawNeeded = renderLayer.redrawNeeded.dispatch;
  renderLayer.registerDisposer(displayState.segmentColorHash.changed.add(dispatchRedrawNeeded));
  renderLayer.registerDisposer(displayState.visibleSegments.changed.add(dispatchRedrawNeeded));
  renderLayer.registerDisposer(displayState.saturation.changed.add(dispatchRedrawNeeded));
  renderLayer.registerDisposer(displayState.highlightedSegments.changed.add(dispatchRedrawNeeded));
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
      displayState.transform.changed.add(renderLayer.redrawNeeded.dispatch));
  renderLayer.registerDisposer(
      displayState.renderScaleTarget.changed.add(renderLayer.redrawNeeded.dispatch));
  renderLayer.registerDisposer(
      displayState.transparentPickEnabled.changed.add(renderLayer.redrawNeeded.dispatch));
}

/**
 * Temporary values used by getObjectColor.
 */
const tempColor = vec4.create();
const tempStatedColor = new Uint64();

export function getBaseObjectColor(
    displayState: SegmentationDisplayState, objectId: Uint64, color: Float32Array = tempColor) {
  const {segmentStatedColors} = displayState;
  if (segmentStatedColors.size !== 0 && segmentStatedColors.has(objectId)) {
    // If displayState maps the ID to a color, use it
    displayState.segmentStatedColors.get(objectId, tempStatedColor);
    color[0] = ((tempStatedColor.low & 0x0000ff)) / 255.0;
    color[1] = ((tempStatedColor.low & 0x00ff00) >>> 8) / 255.0;
    color[2] = ((tempStatedColor.low & 0xff0000) >>> 16) / 255.0;
  } else {
    displayState.segmentColorHash.compute(color, objectId);
  }
  return color;
}

/**
 * Returns the alpha-premultiplied color to use.
 */
export function getObjectColor(
    displayState: SegmentationDisplayState, objectId: Uint64, alpha: number = 1) {
  const color = tempColor;
  color[3] = alpha;
  getBaseObjectColor(displayState, objectId, color);
  let saturation = displayState.saturation.value;
  if (displayState.segmentSelectionState.isSelected(objectId)) {
    if (saturation > 0.5) {
      saturation = saturation -= 0.5;
    } else {
      saturation += 0.5;
    }
  }
  for (let i = 0; i < 3; ++i) {
    color[i] = color[i] * saturation + (1 - saturation);
  }

  // Color highlighted segments
  if (displayState.highlightedSegments.has(objectId)) {
    // Make it vivid blue for selection
    color[0] = 0.2;
    color[1] = 0.2;
    color[2] = 2.0;
    color[3] = 1.0;
  }

  color[0] *= alpha;
  color[1] *= alpha;
  color[2] *= alpha;
  return color;
}

const Base = withSharedVisibility(ChunkRenderLayerFrontend);
export class SegmentationLayerSharedObject extends Base {
  constructor(
      public chunkManager: ChunkManager, public displayState: SegmentationDisplayState3D,
      chunkRenderLayer: LayerChunkProgressInfo) {
    super(chunkRenderLayer);
  }

  initializeCounterpartWithChunkManager(options: any) {
    let {displayState} = this;
    options['chunkManager'] = this.chunkManager.rpcId;
    options['visibleSegments'] = displayState.visibleSegments.rpcId;
    options['segmentEquivalences'] = displayState.segmentEquivalences.rpcId;
    options['transform'] =
        this.registerDisposer(SharedWatchableValue.makeFromExisting(
                                  this.chunkManager.rpc!, this.displayState.transform))
            .rpcId;
    options['renderScaleTarget'] =
        this.registerDisposer(SharedWatchableValue.makeFromExisting(
                                  this.chunkManager.rpc!, this.displayState.renderScaleTarget))
            .rpcId;
    super.initializeCounterpart(this.chunkManager.rpc!, options);
  }
}
