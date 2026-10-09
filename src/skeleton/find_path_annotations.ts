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
import {
  type AnnotationReference,
  AnnotationType,
  LocalAnnotationSource,
  type Point,
  type PolyLine,
} from "#src/annotation/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import {
  type SkeletonFindPathEndpoint,
  type SkeletonFindPathResultNode,
  type SkeletonFindPathState,
} from "#src/skeleton/find_path.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

const ASSOCIATED_SEGMENTS_RELATIONSHIP = "associated segments";
const SPATIAL_SKELETON_FIND_PATH_SUBSOURCE_ID = "spatialSkeletonFindPath";

export const SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION = "find path source";
export const SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION = "find path target";
export const SPATIAL_SKELETON_FIND_PATH_RESULT_DESCRIPTION = "find path result";

export interface SpatialSkeletonFindPathAnnotationControllerOptions {
  layer: SegmentationUserLayer;
  loadedSubsource: LoadedDataSubsource;
  state: SkeletonFindPathState;
}

interface RenderedEndpoint {
  endpoint: SkeletonFindPathEndpoint;
  annotationReference: AnnotationReference;
}

/**
 * Projects persisted spatial-skeleton Find Path state into local annotations
 * for one loaded subsource. Annotation references remain runtime-only.
 */
export class SpatialSkeletonFindPathAnnotationController extends RefCounted {
  readonly annotationSource: LocalAnnotationSource;
  readonly annotationState: AnnotationLayerState;

  private renderedSource: RenderedEndpoint | undefined;
  private renderedTarget: RenderedEndpoint | undefined;
  private resultReference: AnnotationReference | undefined;
  private synchronizing = false;

  constructor(
    private readonly options: SpatialSkeletonFindPathAnnotationControllerOptions,
  ) {
    super();

    const { layer, loadedSubsource, state } = options;
    const annotationSource = new LocalAnnotationSource(
      loadedSubsource.loadedDataSource.transform,
      new WatchableValue([]),
      [ASSOCIATED_SEGMENTS_RELATIONSHIP],
    );
    this.annotationSource = annotationSource;

    const displayState = new AnnotationDisplayState();
    displayState.color.value.set([1, 1, 1]);
    displayState.relationshipStates.set(ASSOCIATED_SEGMENTS_RELATIONSHIP, {
      segmentationState: new WatchableValue(layer.displayState),
      showMatches: new TrackableBoolean(false),
    });

    const annotationState = new AnnotationLayerState({
      localPosition: layer.localPosition,
      transform: loadedSubsource.getRenderLayerTransform(),
      source: annotationSource,
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

    this.registerDisposer(
      annotationSource.childDeleted.add((annotationId) => {
        this.handleAnnotationDeleted(annotationId);
      }),
    );
    this.registerDisposer(state.changed.add(() => this.synchronize()));
    this.synchronize();
  }

  private deleteAnnotation(reference: AnnotationReference) {
    this.annotationSource.delete(reference);
    reference.dispose();
  }

  private synchronizeEndpoint(
    rendered: RenderedEndpoint | undefined,
    endpoint: SkeletonFindPathEndpoint | undefined,
    description: string,
  ): RenderedEndpoint | undefined {
    if (rendered?.endpoint === endpoint) return rendered;
    if (rendered !== undefined) {
      this.deleteAnnotation(rendered.annotationReference);
    }
    if (endpoint === undefined) return undefined;

    const annotation: Point = {
      id: "",
      point: endpoint.position,
      type: AnnotationType.POINT,
      properties: [],
      relatedSegments: [BigUint64Array.of(endpoint.segmentId)],
      description,
    };
    return {
      endpoint,
      annotationReference: this.annotationSource.add(annotation),
    };
  }

  private synchronizeResult(
    result: readonly SkeletonFindPathResultNode[] | undefined,
    segmentId: bigint | undefined,
  ) {
    if (this.resultReference !== undefined) {
      this.deleteAnnotation(this.resultReference);
      this.resultReference = undefined;
    }
    if (result === undefined || result.length < 2 || segmentId === undefined) {
      return;
    }

    const annotation: PolyLine = {
      id: "",
      type: AnnotationType.POLYLINE,
      points: result.map((node) => node.position),
      properties: [],
      relatedSegments: [BigUint64Array.of(segmentId)],
      description: SPATIAL_SKELETON_FIND_PATH_RESULT_DESCRIPTION,
    };
    this.resultReference = this.annotationSource.add(annotation);
  }

  private synchronize() {
    if (this.synchronizing) return;
    this.synchronizing = true;
    try {
      const { source, target, result } = this.options.state;
      this.renderedSource = this.synchronizeEndpoint(
        this.renderedSource,
        source,
        SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
      );
      this.renderedTarget = this.synchronizeEndpoint(
        this.renderedTarget,
        target,
        SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION,
      );
      this.synchronizeResult(result, source?.segmentId ?? target?.segmentId);
    } finally {
      this.synchronizing = false;
    }
  }

  private handleAnnotationDeleted(annotationId: string) {
    if (this.synchronizing) return;

    const { state } = this.options;
    if (this.renderedSource?.annotationReference.id === annotationId) {
      this.renderedSource.annotationReference.dispose();
      this.renderedSource = undefined;
      state.setSource(undefined);
      return;
    }
    if (this.renderedTarget?.annotationReference.id === annotationId) {
      this.renderedTarget.annotationReference.dispose();
      this.renderedTarget = undefined;
      state.setTarget(undefined);
      return;
    }
    if (this.resultReference?.id === annotationId) {
      this.resultReference.dispose();
      this.resultReference = undefined;
      state.clear();
    }
  }

  disposed() {
    this.synchronizing = true;
    this.renderedSource?.annotationReference.dispose();
    this.renderedTarget?.annotationReference.dispose();
    this.resultReference?.dispose();
    this.renderedSource = undefined;
    this.renderedTarget = undefined;
    this.resultReference = undefined;
    super.disposed();
  }
}
