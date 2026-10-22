/**
 * @license
 * Copyright 2026 Google Inc.
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

import {
  AnnotationDisplayState,
  AnnotationLayerState,
} from "#src/annotation/annotation_layer_state.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import type { SkeletonFindPathState } from "#src/skeleton/find_path/find_path.js";
import { SkeletonDataSourceState } from "#src/skeleton/find_path/find_path.js";
import {
  SKELETON_FIND_PATH_ASSOCIATED_SEGMENTS_RELATIONSHIP,
  SpatialSkeletonFindPathAnnotations,
} from "#src/skeleton/find_path/find_path_annotations.js";
import type { SpatiallyIndexedSkeletonLayer } from "#src/skeleton/spatial/skeleton_render_layer.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

const SPATIAL_SKELETON_FIND_PATH_SUBSOURCE_ID = "spatialSkeletonFindPath";

export interface SpatialSkeletonFindPathAnnotationControllerOptions {
  layer: SegmentationUserLayer;
  loadedSubsource: LoadedDataSubsource;
  state: SkeletonFindPathState;
}

/** Shows the Find Path annotations of one loaded subsource as a white annotation layer. */
export class SpatialSkeletonFindPathAnnotationController extends RefCounted {
  readonly annotations: SpatialSkeletonFindPathAnnotations;
  readonly annotationState: AnnotationLayerState;

  constructor(options: SpatialSkeletonFindPathAnnotationControllerOptions) {
    super();
    const { layer, loadedSubsource, state } = options;
    const annotations = this.registerDisposer(
      new SpatialSkeletonFindPathAnnotations(
        loadedSubsource.loadedDataSource.transform,
        state,
      ),
    );
    this.annotations = annotations;

    const displayState = new AnnotationDisplayState();
    displayState.color.value.set([1, 1, 1]);
    displayState.relationshipStates.set(
      SKELETON_FIND_PATH_ASSOCIATED_SEGMENTS_RELATIONSHIP,
      {
        segmentationState: new WatchableValue(layer.displayState),
        showMatches: new TrackableBoolean(false),
      },
    );

    const annotationState = new AnnotationLayerState({
      localPosition: layer.localPosition,
      transform: loadedSubsource.getRenderLayerTransform(),
      source: annotations.annotationSource.addRef(),
      displayState,
      dataSource: loadedSubsource.loadedDataSource.layerDataSource,
      subsourceIndex: loadedSubsource.subsourceIndex,
      subsourceId: loadedSubsource.subsourceEntry.id,
      subsubsourceId: SPATIAL_SKELETON_FIND_PATH_SUBSOURCE_ID,
      role: RenderLayerRole.ANNOTATION,
    });
    annotationState.registerDisposer(displayState);
    this.annotationState = this.registerDisposer(annotationState);
    layer.addAnnotationLayerState(annotationState, loadedSubsource);
  }
}

export function attachFindPath(
  layer: SegmentationUserLayer,
  loadedSubsource: LoadedDataSubsource,
  skeletonLayer: SpatiallyIndexedSkeletonLayer,
) {
  const { activated } = loadedSubsource;
  const dataSourceState = loadedSubsource.loadedDataSource.dataSource.state;
  if (
    activated === undefined ||
    !(dataSourceState instanceof SkeletonDataSourceState)
  ) {
    return;
  }
  const annotationController = activated.registerDisposer(
    new SpatialSkeletonFindPathAnnotationController({
      layer,
      loadedSubsource,
      state: dataSourceState.findPathState,
    }),
  );
  layer.skeletonSourceConnection.attachFindPath(
    {
      skeletonLayer,
      state: dataSourceState.findPathState,
      annotationController,
    },
    activated,
  );
}
