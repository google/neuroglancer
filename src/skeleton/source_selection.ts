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

export interface SpatialSkeletonSourceLimitInput {
  limit: number;
}

export interface SpatialSkeletonSourceDensityInput<T>
  extends SpatialSkeletonSourceLimitInput {
  source: T;
  index: number;
  physicalVolume: number;
  sliceFraction: number;
}

export interface SpatialSkeletonSourceDensitySelection<T>
  extends SpatialSkeletonSourceDensityInput<T> {
  physicalDensity: number;
  totalPhysicalDensity: number;
  physicalSpacing: number;
  pixelSpacing: number;
}

export const SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR =
  "Spatial skeleton limit: 0 is only supported on the finest source level.";

function validateSpatialSkeletonLimitZeroOnlyFinalSource<
  T extends SpatialSkeletonSourceLimitInput,
>(sources: readonly T[]) {
  for (let i = 0; i < sources.length - 1; ++i) {
    if (sources[i].limit === 0) {
      throw new Error(SPATIAL_SKELETON_ZERO_LIMIT_FINEST_ERROR);
    }
  }
}

function makeSpatialSkeletonSourceSelection<T>(
  source: SpatialSkeletonSourceDensityInput<T>,
  physicalDensity: number,
  effectiveVolume: number,
  viewportArea: number,
): SpatialSkeletonSourceDensitySelection<T> {
  const hasKnownDensity =
    Number.isFinite(physicalDensity) && physicalDensity > 0;
  return {
    ...source,
    physicalDensity,
    totalPhysicalDensity: physicalDensity,
    physicalSpacing: hasKnownDensity
      ? (1 / physicalDensity) ** (1 / 3)
      : Number.POSITIVE_INFINITY,
    pixelSpacing: hasKnownDensity
      ? Math.sqrt(viewportArea / (physicalDensity * effectiveVolume))
      : Number.POSITIVE_INFINITY,
  };
}

export function selectSpatialSkeletonSourceByLimit<T>(
  sources: readonly SpatialSkeletonSourceDensityInput<T>[],
  physicalDensityTarget: number,
  effectiveVolume: number,
  viewportArea: number,
): SpatialSkeletonSourceDensitySelection<T> | undefined {
  if (sources.length === 0) return undefined;
  validateSpatialSkeletonLimitZeroOnlyFinalSource(sources);

  for (const source of sources) {
    if (source.limit === 0) {
      continue;
    }
    const physicalDensity =
      (source.limit * source.sliceFraction) / source.physicalVolume;
    if (physicalDensity >= physicalDensityTarget) {
      return makeSpatialSkeletonSourceSelection(
        source,
        physicalDensity,
        effectiveVolume,
        viewportArea,
      );
    }
  }

  const finestSource = sources[sources.length - 1];
  if (finestSource.limit === 0) {
    return makeSpatialSkeletonSourceSelection(
      finestSource,
      Number.POSITIVE_INFINITY,
      effectiveVolume,
      viewportArea,
    );
  }
  const physicalDensity =
    (finestSource.limit * finestSource.sliceFraction) /
    finestSource.physicalVolume;
  return makeSpatialSkeletonSourceSelection(
    finestSource,
    physicalDensity,
    effectiveVolume,
    viewportArea,
  );
}

export function getSpatialSkeletonSourceScalesByLimit<T>(
  sources: readonly SpatialSkeletonSourceDensityInput<T>[],
  effectiveVolume: number,
  viewportArea: number,
): SpatialSkeletonSourceDensitySelection<T>[] {
  validateSpatialSkeletonLimitZeroOnlyFinalSource(sources);
  return sources.map((source) => {
    const physicalDensity =
      source.limit === 0
        ? Number.POSITIVE_INFINITY
        : (source.limit * source.sliceFraction) / source.physicalVolume;
    return makeSpatialSkeletonSourceSelection(
      source,
      physicalDensity,
      effectiveVolume,
      viewportArea,
    );
  });
}

export function validateSpatialSkeletonLimitZeroOnlyFinest<
  T extends SpatialSkeletonSourceLimitInput,
>(sources: readonly T[]) {
  validateSpatialSkeletonLimitZeroOnlyFinalSource(sources);
}
