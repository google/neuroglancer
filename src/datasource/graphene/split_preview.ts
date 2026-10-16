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

import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import {
  parseArray,
  parseUint64,
  verifyBoolean,
  verifyObjectProperty,
} from "#src/util/json.js";

export interface GrapheneSplitPreview {
  connectedComponents: bigint[][];
  isSplitIllegal: boolean;
}

export function parseGrapheneSplitPreviewResponse(
  response: unknown,
): GrapheneSplitPreview {
  const connectedComponents = verifyObjectProperty(
    response,
    "supervoxel_connected_components",
    (value) =>
      parseArray(value, (component) => parseArray(component, parseUint64)),
  );
  const isSplitIllegal = verifyObjectProperty(
    response,
    "illegal_split",
    verifyBoolean,
  );
  return {
    connectedComponents,
    isSplitIllegal,
  };
}

export class MulticutSplitPreviewState {
  connectedComponents: bigint[][] = [];
  isSplitIllegal = false;
  previewActive = false;
  previewPending = false;
  hasCachedPreview = false;

  invalidate() {
    const changed =
      this.previewActive ||
      this.previewPending ||
      this.hasCachedPreview ||
      this.isSplitIllegal ||
      this.connectedComponents.length !== 0;
    this.connectedComponents = [];
    this.isSplitIllegal = false;
    this.previewActive = false;
    this.previewPending = false;
    this.hasCachedPreview = false;
    return changed;
  }

  setPending(value: boolean) {
    if (this.previewPending === value) return false;
    this.previewPending = value;
    return true;
  }

  setPreviewActive(value: boolean) {
    if (value && !this.hasCachedPreview) return false;
    if (this.previewActive === value) return false;
    this.previewActive = value;
    return true;
  }

  cachePreview(preview: GrapheneSplitPreview) {
    this.connectedComponents = preview.connectedComponents.map((component) => [
      ...component,
    ]);
    this.isSplitIllegal = preview.isSplitIllegal;
    this.hasCachedPreview = true;
    this.previewPending = false;
    this.previewActive = true;
  }
}

export function applySplitPreviewToTemporaryState(
  state: VisibleSegmentsState,
  connectedComponents: readonly (readonly bigint[])[],
  preservedVisibleSegments: readonly bigint[] = [],
) {
  const representatives: bigint[] = [];
  const tempVisibleSegments = state.temporaryVisibleSegments;
  const tempEquivalences = state.temporarySegmentEquivalences;
  tempVisibleSegments.clear();
  tempEquivalences.clear();
  state.useTemporaryVisibleSegments.value = true;
  state.useTemporarySegmentEquivalences.value = true;
  for (const segment of preservedVisibleSegments) {
    tempVisibleSegments.add(segment);
  }
  for (const component of connectedComponents) {
    if (component.length === 0) continue;
    tempEquivalences.linkAll([...component]);
    const representative = tempEquivalences.get(component[0]);
    tempVisibleSegments.add(representative);
    representatives.push(representative);
  }
  return representatives;
}
