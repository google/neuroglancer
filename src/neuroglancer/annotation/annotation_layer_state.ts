/**
 * @license
 * Copyright 2018 Google Inc.
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

import {AnnotationSource} from 'neuroglancer/annotation';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/layer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';

export class AnnotationHoverState extends
    WatchableValue<{id: string, partIndex: number}|undefined> {}

export class AnnotationLayerState extends RefCounted {
  transform: CoordinateTransform;
  source: Owned<AnnotationSource|MultiscaleAnnotationSource>;
  hoverState: AnnotationHoverState;
  role: RenderLayerRole;
  color: TrackableRGB;
  fillOpacity: TrackableAlphaValue;

  /**
   * undefined means may have a segmentation state.  null means no segmentation state is supported.
   */
  segmentationState: WatchableValue<SegmentationDisplayState|undefined|null>;
  filterBySegmentation: TrackableBoolean;

  private transformCacheGeneration = -1;
  private cachedObjectToGlobal = mat4.create();
  private cachedGlobalToObject = mat4.create();

  private updateTransforms() {
    const {transform, transformCacheGeneration} = this;
    const generation = transform.changed.count;
    if (generation === transformCacheGeneration) {
      return;
    }
    const {cachedObjectToGlobal} = this;
    mat4.multiply(cachedObjectToGlobal, this.transform.transform, this.source.objectToLocal);
    mat4.invert(this.cachedGlobalToObject, cachedObjectToGlobal);
  }

  get objectToGlobal() {
    this.updateTransforms();
    return this.cachedObjectToGlobal;
  }

  get globalToObject() {
    this.updateTransforms();
    return this.cachedGlobalToObject;
  }

  constructor(options: {
    transform?: CoordinateTransform, source: Owned<AnnotationSource|MultiscaleAnnotationSource>,
    hoverState?: AnnotationHoverState,
    role?: RenderLayerRole, color: TrackableRGB, fillOpacity: TrackableAlphaValue,
    segmentationState?: WatchableValue<SegmentationDisplayState|undefined|null>,
    filterBySegmentation?: TrackableBoolean,
  }) {
    super();
    const {
      transform = new CoordinateTransform(),
      source,
      hoverState = new AnnotationHoverState(undefined),
      role = RenderLayerRole.ANNOTATION,
      color,
      fillOpacity,
      segmentationState = new WatchableValue(null),
      filterBySegmentation = new TrackableBoolean(false),
    } = options;
    this.transform = transform;
    this.source = this.registerDisposer(source);
    this.hoverState = hoverState;
    this.role = role;
    this.color = color;
    this.fillOpacity = fillOpacity;
    this.segmentationState = segmentationState;
    this.filterBySegmentation = filterBySegmentation;
  }
}
