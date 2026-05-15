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

export type SpatiallyIndexedSkeletonView = "2d" | "3d";

interface SpatiallyIndexedSkeletonParameterHolder {
  parameters?: {
    gridIndex?: unknown;
    view?: unknown;
  };
}

function isSpatiallyIndexedSkeletonParameterHolder(
  value: unknown,
): value is SpatiallyIndexedSkeletonParameterHolder {
  return typeof value === "object" && value !== null;
}

function getSpatiallyIndexedSkeletonParameterHolder(
  value: unknown,
): SpatiallyIndexedSkeletonParameterHolder | undefined {
  if (!isSpatiallyIndexedSkeletonParameterHolder(value)) {
    return undefined;
  }
  if ("chunkSource" in value && value.chunkSource !== undefined) {
    return isSpatiallyIndexedSkeletonParameterHolder(value.chunkSource)
      ? value.chunkSource
      : undefined;
  }
  if ("source" in value && value.source !== undefined) {
    return isSpatiallyIndexedSkeletonParameterHolder(value.source)
      ? value.source
      : undefined;
  }
  return value;
}

export function getSpatiallyIndexedSkeletonGridIndex<T extends object>(
  value: T,
): number | undefined {
  const gridIndex =
    getSpatiallyIndexedSkeletonParameterHolder(value)?.parameters?.gridIndex;
  return typeof gridIndex === "number" ? gridIndex : undefined;
}

export function getSpatiallyIndexedSkeletonSourceView<T extends object>(
  value: T,
): string | undefined {
  const sourceView =
    getSpatiallyIndexedSkeletonParameterHolder(value)?.parameters?.view;
  return typeof sourceView === "string" ? sourceView : undefined;
}

export function selectSpatiallyIndexedSkeletonEntriesByGrid<T>(
  entries: readonly T[],
  gridLevel: number | undefined,
  getGridIndex: (entry: T) => number | undefined,
) {
  if (entries.length === 0 || gridLevel === undefined) {
    return [...entries];
  }
  let exactMatch: T | undefined;
  let closestMatch: T | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    const gridIndex = getGridIndex(entry);
    if (gridIndex === undefined) {
      return [...entries];
    }
    if (exactMatch === undefined && gridIndex === gridLevel) {
      exactMatch = entry;
    }
    const distance = Math.abs(gridIndex - gridLevel);
    if (distance < bestDistance) {
      bestDistance = distance;
      closestMatch = entry;
    }
  }
  return [exactMatch ?? closestMatch!];
}

export function filterSpatiallyIndexedSkeletonEntriesByView<T>(
  entries: readonly T[],
  view: SpatiallyIndexedSkeletonView,
  getView: (entry: T) => string | undefined,
) {
  return entries.filter((entry) => {
    const sourceView = getView(entry);
    return sourceView === undefined || sourceView === view;
  });
}

export function selectSpatiallyIndexedSkeletonEntriesForView<T>(
  entries: readonly T[],
  view: SpatiallyIndexedSkeletonView,
  gridLevel: number | undefined,
  getView: (entry: T) => string | undefined,
  getGridIndex: (entry: T) => number | undefined,
) {
  const viewFiltered = filterSpatiallyIndexedSkeletonEntriesByView(
    entries,
    view,
    getView,
  );
  return selectSpatiallyIndexedSkeletonEntriesByGrid(
    viewFiltered,
    gridLevel,
    getGridIndex,
  );
}
