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

/**
 * @file Mirrors a Find Path state as local annotations in both directions, so
 * that deleting an annotation clears its endpoint or route.
 */

import {
  type AnnotationReference,
  AnnotationType,
  LocalAnnotationSource,
  type Point,
  type PolyLine,
} from "#src/annotation/index.js";
import type { WatchableCoordinateSpaceTransform } from "#src/coordinate_transform.js";
import type {
  SkeletonFindPathEndpoint,
  SkeletonFindPathResultNode,
  SkeletonFindPathState,
} from "#src/skeleton/find_path/find_path.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export const SKELETON_FIND_PATH_ASSOCIATED_SEGMENTS_RELATIONSHIP =
  "associated segments";

export const SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION = "find path source";
export const SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION = "find path target";
export const SPATIAL_SKELETON_FIND_PATH_RESULT_DESCRIPTION = "find path result";

interface RenderedEndpoint {
  endpoint: SkeletonFindPathEndpoint;
  annotationReference: AnnotationReference;
}

/**
 * Projects persisted spatial-skeleton Find Path state into local annotations.
 * Annotation references remain runtime-only.
 */
export class SpatialSkeletonFindPathAnnotations extends RefCounted {
  readonly annotationSource: LocalAnnotationSource;

  private renderedSource: RenderedEndpoint | undefined;
  private renderedTarget: RenderedEndpoint | undefined;
  private resultReference: AnnotationReference | undefined;
  private synchronizing = false;

  constructor(
    transform: WatchableCoordinateSpaceTransform,
    private readonly state: SkeletonFindPathState,
  ) {
    super();
    this.annotationSource = this.registerDisposer(
      new LocalAnnotationSource(transform, new WatchableValue([]), [
        SKELETON_FIND_PATH_ASSOCIATED_SEGMENTS_RELATIONSHIP,
      ]),
    );
    this.registerDisposer(
      this.annotationSource.childDeleted.add((annotationId) => {
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
      const { source, target, result } = this.state;
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

    const { state } = this;
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
