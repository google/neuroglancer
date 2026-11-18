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

import { describe, expect, it } from "vitest";

import { AnnotationType } from "#src/annotation/index.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type { SkeletonFindPathEndpoint } from "#src/skeleton/find_path/find_path.js";
import { SkeletonFindPathState } from "#src/skeleton/find_path/find_path.js";
import {
  SpatialSkeletonFindPathAnnotations,
  SPATIAL_SKELETON_FIND_PATH_RESULT_DESCRIPTION,
  SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
  SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION,
} from "#src/skeleton/find_path/find_path_annotations.js";

function endpoint(
  nodeId: number,
  segmentId = 100,
  position: readonly number[] = [nodeId, nodeId + 1, nodeId + 2],
): SkeletonFindPathEndpoint {
  return {
    nodeId: BigInt(nodeId),
    segmentId: BigInt(segmentId),
    position: new Float32Array(position),
  };
}

function setResolvedPath(state: SkeletonFindPathState) {
  state.setEndpoints(endpoint(1), endpoint(3));
  state.setResult([
    { nodeId: 1n, position: new Float32Array([1, 2, 3]) },
    { nodeId: 2n, position: new Float32Array([2, 3, 4]) },
    { nodeId: 3n, position: new Float32Array([3, 4, 5]) },
  ]);
}

function makeTransform() {
  return new WatchableCoordinateSpaceTransform(
    makeIdentityTransform(
      makeCoordinateSpace({
        names: ["x", "y", "z"],
        units: ["m", "m", "m"],
        scales: Float64Array.of(1, 1, 1),
      }),
    ),
  );
}

function makeFixture(state: SkeletonFindPathState) {
  const transform = makeTransform();
  return {
    findPathAnnotations: new SpatialSkeletonFindPathAnnotations(
      transform,
      state,
    ),
    transform,
  };
}

describe("SpatialSkeletonFindPathAnnotations", () => {
  it("renders labeled endpoints and the ordered route for its source", () => {
    const state = new SkeletonFindPathState();
    setResolvedPath(state);
    const { findPathAnnotations } = makeFixture(state);

    const annotations = Array.from(findPathAnnotations.annotationSource);
    expect(annotations).toHaveLength(3);
    const source = annotations.find(
      (annotation) =>
        annotation.description ===
        SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
    );
    const target = annotations.find(
      (annotation) =>
        annotation.description ===
        SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION,
    );
    const result = annotations.find(
      (annotation) =>
        annotation.description ===
        SPATIAL_SKELETON_FIND_PATH_RESULT_DESCRIPTION,
    );
    expect(source?.type).toBe(AnnotationType.POINT);
    expect(target?.type).toBe(AnnotationType.POINT);
    expect(result?.type).toBe(AnnotationType.POLYLINE);
    if (
      source?.type !== AnnotationType.POINT ||
      target?.type !== AnnotationType.POINT ||
      result?.type !== AnnotationType.POLYLINE
    ) {
      throw new Error("Expected source, target, and result annotations.");
    }
    expect(Array.from(source.point)).toEqual([1, 2, 3]);
    expect(Array.from(target.point)).toEqual([3, 4, 5]);
    expect(result.points.map((point) => Array.from(point))).toEqual([
      [1, 2, 3],
      [2, 3, 4],
      [3, 4, 5],
    ]);
    for (const annotation of annotations) {
      expect(annotation.id).not.toBe("");
      expect(
        annotation.relatedSegments?.map((segments) => Array.from(segments)),
      ).toEqual([[100n]]);
    }
    expect(state.toJSON()).not.toHaveProperty("annotationReference");

    findPathAnnotations.dispose();
    state.dispose();
  });

  it("each data source shows only its own Find Path markers", () => {
    const firstState = new SkeletonFindPathState();
    const secondState = new SkeletonFindPathState();
    firstState.setSource(endpoint(1, 100, [1, 2, 3]));
    secondState.setSource(endpoint(8, 200, [8, 9, 10]));
    const first = makeFixture(firstState);
    const second = makeFixture(secondState);

    const firstAnnotation = Array.from(
      first.findPathAnnotations.annotationSource,
    )[0];
    const secondAnnotation = Array.from(
      second.findPathAnnotations.annotationSource,
    )[0];
    expect(firstAnnotation.type).toBe(AnnotationType.POINT);
    expect(secondAnnotation.type).toBe(AnnotationType.POINT);
    if (
      firstAnnotation.type !== AnnotationType.POINT ||
      secondAnnotation.type !== AnnotationType.POINT
    ) {
      throw new Error("Expected isolated source point annotations.");
    }
    expect(Array.from(firstAnnotation.point)).toEqual([1, 2, 3]);
    expect(Array.from(secondAnnotation.point)).toEqual([8, 9, 10]);
    expect(first.findPathAnnotations.annotationSource.watchableTransform).toBe(
      first.transform,
    );
    expect(second.findPathAnnotations.annotationSource.watchableTransform).toBe(
      second.transform,
    );
    expect(
      first.findPathAnnotations.annotationSource.watchableTransform,
    ).not.toBe(second.findPathAnnotations.annotationSource.watchableTransform);

    first.findPathAnnotations.dispose();
    second.findPathAnnotations.dispose();
    firstState.dispose();
    secondState.dispose();
  });

  it("replaces an endpoint annotation when its state changes", () => {
    const state = new SkeletonFindPathState();
    setResolvedPath(state);
    const { findPathAnnotations } = makeFixture(state);
    const sourceBefore = Array.from(findPathAnnotations.annotationSource).find(
      (annotation) =>
        annotation.description ===
        SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
    );
    expect(sourceBefore).toBeDefined();

    state.setSource(endpoint(11, 100, [11, 12, 13]));
    const sourceAfter = Array.from(findPathAnnotations.annotationSource).find(
      (annotation) =>
        annotation.description ===
        SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
    );
    expect(sourceAfter?.id).not.toBe(sourceBefore?.id);
    expect(sourceAfter?.type).toBe(AnnotationType.POINT);
    if (sourceAfter?.type !== AnnotationType.POINT) {
      throw new Error("Expected the replacement source point annotation.");
    }
    expect(Array.from(sourceAfter.point)).toEqual([11, 12, 13]);
    expect(state.target?.nodeId).toBe(3n);

    findPathAnnotations.dispose();
    state.dispose();
  });

  it("deleting a Find Path marker clears that endpoint or the route", () => {
    const state = new SkeletonFindPathState();
    setResolvedPath(state);
    const { findPathAnnotations } = makeFixture(state);

    const sourceAnnotation = Array.from(
      findPathAnnotations.annotationSource,
    ).find(
      (annotation) =>
        annotation.description ===
        SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
    )!;
    const sourceReference = findPathAnnotations.annotationSource.getReference(
      sourceAnnotation.id,
    );
    findPathAnnotations.annotationSource.delete(sourceReference);
    sourceReference.dispose();
    expect(state.source).toBeUndefined();
    expect(state.target?.nodeId).toBe(3n);
    expect(state.result).toBeUndefined();
    expect(
      Array.from(findPathAnnotations.annotationSource).map(
        (annotation) => annotation.description,
      ),
    ).toEqual([SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION]);

    state.setSource(endpoint(1));
    state.setResult([
      { nodeId: 1n, position: new Float32Array([1, 2, 3]) },
      { nodeId: 3n, position: new Float32Array([3, 4, 5]) },
    ]);
    const resultAnnotation = Array.from(
      findPathAnnotations.annotationSource,
    ).find(
      (annotation) =>
        annotation.description ===
        SPATIAL_SKELETON_FIND_PATH_RESULT_DESCRIPTION,
    )!;
    const resultReference = findPathAnnotations.annotationSource.getReference(
      resultAnnotation.id,
    );
    findPathAnnotations.annotationSource.delete(resultReference);
    resultReference.dispose();
    expect(state.source).toBeUndefined();
    expect(state.target).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(Array.from(findPathAnnotations.annotationSource)).toHaveLength(0);

    findPathAnnotations.dispose();
    state.dispose();
  });

  it("does not clear persisted state on disposal", () => {
    const state = new SkeletonFindPathState();
    setResolvedPath(state);
    const persistedState = state.toJSON();
    const { findPathAnnotations } = makeFixture(state);

    findPathAnnotations.dispose();

    expect(state.toJSON()).toEqual(persistedState);
    state.dispose();
  });
});
