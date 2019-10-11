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
import {LayerDataSource} from 'neuroglancer/layer_data_source';
import {ChunkTransformParameters, getChunkTransformParameters, RenderLayerTransformOrError} from 'neuroglancer/render_coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/renderlayer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {makeCachedLazyDerivedWatchableValue, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {makeValueOrError, ValueOrError, valueOrThrow} from 'neuroglancer/util/error';
import {vec3} from 'neuroglancer/util/geom';

export class AnnotationHoverState extends WatchableValue<
    {id: string, partIndex: number, annotationLayerState: AnnotationLayerState}|undefined> {}

export class AnnotationDisplayState {
  color = new TrackableRGB(vec3.fromValues(1, 1, 0));
  fillOpacity = trackableAlphaValue(0.0);
  /**
   * undefined means may have a segmentation state.  null means no segmentation state is supported.
   */
  segmentationState: WatchableValue<SegmentationDisplayState|undefined|null> =
      new WatchableValue(null);
  filterBySegmentation = new TrackableBoolean(false);
  hoverState = new AnnotationHoverState(undefined);
}

export class AnnotationLayerState extends RefCounted {
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  localPosition: WatchableValueInterface<Float32Array>;
  source: Owned<AnnotationSource|MultiscaleAnnotationSource>;
  role: RenderLayerRole;
  dataSource: LayerDataSource;
  subsourceId: string;
  subsourceIndex: number;
  displayState: AnnotationDisplayState;

  readonly chunkTransform: WatchableValueInterface<ValueOrError<ChunkTransformParameters>>;
  constructor(options: {
    transform: WatchableValueInterface<RenderLayerTransformOrError>,
    localPosition: WatchableValueInterface<Float32Array>,
    source: Owned<AnnotationSource|MultiscaleAnnotationSource>,
    displayState: AnnotationDisplayState,
    dataSource: LayerDataSource,
    subsourceId: string,
    subsourceIndex: number,
    role?: RenderLayerRole,
  }) {
    super();
    const {
      transform,
      localPosition,
      source,
      role = RenderLayerRole.ANNOTATION,
    } = options;
    this.transform = transform;
    this.localPosition = localPosition;
    this.source = this.registerDisposer(source);
    this.role = role;
    this.displayState = options.displayState;
    this.chunkTransform = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
        modelTransform =>
            makeValueOrError(() => getChunkTransformParameters(valueOrThrow(modelTransform))),
        this.transform));
    this.dataSource = options.dataSource;
    this.subsourceId = options.subsourceId;
    this.subsourceIndex = options.subsourceIndex;
  }

  get sourceIndex() {
    const {dataSource} = this;
    return dataSource.layer.dataSources.indexOf(dataSource);
  }
}
