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

export interface SpatialSkeletonSourceDensityInput<T> {
  source: T;
  index: number;
  physicalVolume: number;
  limit: number;
  sliceFraction: number;
}

export interface SpatialSkeletonSourceDensitySelection<T>
  extends SpatialSkeletonSourceDensityInput<T> {
  physicalDensity: number;
  totalPhysicalDensity: number;
  physicalSpacing: number;
  pixelSpacing: number;
}

export function selectSpatialSkeletonSourcesByLimit<T>(
  sources: readonly SpatialSkeletonSourceDensityInput<T>[],
  physicalDensityTarget: number,
  effectiveVolume: number,
  viewportArea: number,
): SpatialSkeletonSourceDensitySelection<T>[] {
  const orderedSources = [...sources].sort(
    (a, b) => b.physicalVolume - a.physicalVolume || a.index - b.index,
  );
  const selected: SpatialSkeletonSourceDensitySelection<T>[] = [];
  let totalPhysicalDensity = 0;
  for (const source of orderedSources) {
    if (
      totalPhysicalDensity > 0 &&
      totalPhysicalDensity >= physicalDensityTarget
    ) {
      break;
    }
    const physicalDensity =
      source.limit > 0
        ? (source.limit * source.sliceFraction) / source.physicalVolume
        : 0;
    const newTotalPhysicalDensity = totalPhysicalDensity + physicalDensity;
    selected.push({
      ...source,
      physicalDensity,
      totalPhysicalDensity: newTotalPhysicalDensity,
      physicalSpacing:
        newTotalPhysicalDensity > 0
          ? (1 / newTotalPhysicalDensity) ** (1 / 3)
          : Number.POSITIVE_INFINITY,
      pixelSpacing:
        newTotalPhysicalDensity > 0
          ? Math.sqrt(
              viewportArea / (newTotalPhysicalDensity * effectiveVolume),
            )
          : Number.POSITIVE_INFINITY,
    });
    totalPhysicalDensity = newTotalPhysicalDensity;
  }
  return selected;
}
