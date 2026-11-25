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
 * @file Warped volumes: view a moving volume in the space of a displacement
 * field, W(x) = M(x + u(x)), without making a copy of the data.
 *
 * The displacement field is an OME-Zarr 0.6 multiscale image with an axis of
 * type "displacement" (RFC-5; see `parseDisplacementFieldMetadata`). Each scale of the
 * moving volume becomes a scale of a warped volume on a grid aligned with the
 * output axes, whose chunks are computed in the worker
 * (`warp/backend.ts`) from field and moving chunks.
 */

import { makeWarpedAnnotationSource } from "#src/annotation/warp/frontend.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import { makeIdentityTransform } from "#src/coordinate_transform.js";
import type {
  DataSource,
  DataSubsource,
  DataSubsourceEntry,
} from "#src/datasource/index.js";
import { makeWarpedMeshSource } from "#src/mesh/warp/frontend.js";
import { SkeletonSource } from "#src/skeleton/frontend.js";
import { makeWarpedSkeletonSource } from "#src/skeleton/warp/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import {
  composeAffine,
  fullRowMajor,
  invertAffine,
  mul4,
  rowsOf4,
  spatialSubmatrix,
} from "#src/sliceview/volume/warp/affine.js";
import {
  WarpedVolumeChunkSourceParameters,
  WarpInterpolation,
} from "#src/sliceview/volume/warp/base.js";
import type {
  DisplacementField,
  WarpGeometry,
} from "#src/sliceview/volume/warp/field.js";
import {
  registerWarpedDataSourceFactory,
  canonicalSourceOptions,
  fieldLevelAccess,
  getWarpGeometry,
  movingModelToOutput,
  splitChunkDims,
} from "#src/sliceview/volume/warp/field.js";
import { attachDependencies } from "#src/sliceview/volume/warp/point_warp_frontend.js";

// Coarser warped scales are added until the warped grid is at most this many
// voxels across.
const MAX_COARSEST_EXTENT = 256;
const MIN_CHUNK_EDGE = 8;
const COARSE_CHUNK_SCALING = 1;

/**
 * Warped chunk edge along each displaced dimension: about 32^3 voxels per
 * chunk whatever the number of displaced dimensions (32 for 3).
 */
function warpedChunkEdge(numDisplaced: number) {
  return Math.min(1024, 2 ** Math.round(15 / Math.max(1, numDisplaced)));
}

class WarpedVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  WarpedVolumeChunkSourceParameters,
) {
  dependencies: VolumeChunkSource[] | undefined;
}

export class WarpedMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return this.moving.dataType;
  }
  get volumeType() {
    return this.moving.volumeType;
  }
  get rank() {
    return this.geometry.modelSpace.rank;
  }

  constructor(
    chunkManager: ChunkManager,
    public moving: MultiscaleVolumeChunkSource,
    public movingTransform: CoordinateSpaceTransform,
    public field: DisplacementField,
    public geometry: WarpGeometry,
  ) {
    super(chunkManager);
  }

  getSources(
    options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    const { field, geometry, movingTransform } = this;
    const F = geometry.numFieldDims;
    const movingRank = movingTransform.sourceRank;
    const [movingScales, ...otherAlternatives] = this.moving.getSources(
      canonicalSourceOptions(movingRank),
    );
    for (const alternative of otherAlternatives) {
      for (const s of alternative) s.chunkSource.dispose();
    }
    const modelToOutput = movingModelToOutput(movingTransform, geometry);
    // Moving chunk dimensions sampled through the field (natural order), and
    // the passthrough ones in the geometry's order.
    const { spatialChunkDims, channelChunkDims: otherChunkDims } =
      splitChunkDims(
        movingScales[0].chunkToMultiscaleTransform,
        movingRank,
        geometry.spatialInputDims,
      );
    const c2m0 = fullRowMajor(
      movingScales[0].chunkToMultiscaleTransform,
      movingRank,
    );
    const passChunkDims = geometry.passInputDims.map((j) => {
      const d = otherChunkDims.find(
        (d) => c2m0[j * (movingRank + 1) + d] !== 0,
      );
      if (d === undefined) {
        throw new Error("warp: unexpected moving chunk dimensions");
      }
      return d;
    });
    const n = spatialChunkDims.length;
    // Moving chunk voxel coordinates (spatialChunkDims) -> warped model
    // coordinates: rows per field dimension (zero for those it lacks).
    const chunkToModelOf = (
      movingScale: SliceViewSingleResolutionSource<VolumeChunkSource>,
    ): number[][] => {
      const c2m = fullRowMajor(
        movingScale.chunkToMultiscaleTransform,
        movingRank,
      );
      if (geometry.isSpatial3d) {
        return rowsOf4(
          mul4(
            modelToOutput,
            spatialSubmatrix(
              c2m,
              movingRank,
              geometry.spatialInputDims,
              spatialChunkDims,
            ),
          ),
        );
      }
      const sub = geometry.spatialInputDims.map((j) => [
        ...spatialChunkDims.map((d) => c2m[j * (movingRank + 1) + d]),
        c2m[j * (movingRank + 1) + movingRank],
      ]);
      const rows = [...Array(F).keys()].map((k) =>
        modelToOutput.slice(k * (n + 1), (k + 1) * (n + 1)),
      );
      return composeAffine(rows, sub);
    };
    // Passthrough dimensions: moving chunk voxel -> moving output coordinate
    // (scale a, offset b); the warped chunk keeps the moving voxel grid.
    const movingSpec = movingScales[0].chunkSource.spec;
    const fullMoving = fullRowMajor(
      movingTransform.transform,
      movingTransform.rank,
      movingRank,
    );
    const { inputSpace, outputSpace } = movingTransform;
    const passLower = passChunkDims.map((d) => movingSpec.lowerVoxelBound[d]);
    const passExtent = passChunkDims.map(
      (d) => movingSpec.upperVoxelBound[d] - movingSpec.lowerVoxelBound[d],
    );
    const passAffine = geometry.passOutputDims.map((o, p) => {
      const j = geometry.passInputDims[p];
      const d = passChunkDims[p];
      const coef =
        (fullMoving[o * (movingRank + 1) + j] * inputSpace.scales[j]) /
        outputSpace.scales[o];
      const a = coef * c2m0[j * (movingRank + 1) + d];
      const b =
        coef * c2m0[j * (movingRank + 1) + movingRank] +
        fullMoving[o * (movingRank + 1) + movingRank];
      return { a, b };
    });
    const rank = F + passChunkDims.length;
    const voxelSizeOf = (chunkToModel: number[][]) =>
      chunkToModel.map((row, k) =>
        geometry.movingOutputDims[k] === -1
          ? geometry.fieldSpacing[k]
          : Math.hypot(...row.slice(0, n)),
      );
    const numDisplaced = geometry.displaced.filter((d) => d).length;
    // Warped scales: one per moving scale, then coarser ones sampled from the
    // coarsest moving scale until the warped grid is small, so that zoomed-out
    // views compute few voxels even when the moving volume has one scale.
    const levels: {
      movingScale: SliceViewSingleResolutionSource<VolumeChunkSource>;
      factor: number;
    }[] = movingScales.map((movingScale) => ({ movingScale, factor: 1 }));
    {
      const coarsest = movingScales[movingScales.length - 1];
      const size = voxelSizeOf(chunkToModelOf(coarsest));
      const extent = (factor: number) =>
        Math.max(
          ...[...Array(F).keys()]
            .filter((i) => geometry.displaced[i])
            .map(
              (i) =>
                (geometry.upper[i] - geometry.lower[i]) / (size[i] * factor),
            ),
        );
      for (
        let factor = 2;
        extent(factor / 2) > MAX_COARSEST_EXTENT;
        factor *= 2
      ) {
        coarsest.chunkSource.addRef();
        levels.push({ movingScale: coarsest, factor });
      }
    }
    const sources = levels.map(({ movingScale, factor }) => {
      const chunkToModel = chunkToModelOf(movingScale);
      // Voxel size of this scale along each field dimension; coarser scales
      // coarsen the displaced dimensions only.
      const voxelSize = voxelSizeOf(chunkToModel).map((v, i) =>
        geometry.displaced[i] ? v * factor : v,
      );
      const upperVoxelBound = Float32Array.from([
        ...[...Array(F).keys()].map((i) =>
          Math.max(
            1,
            // Tolerate rounding (e.g. NIfTI's float32 spacing).
            Math.ceil(
              ((geometry.upper[i] - geometry.lower[i]) / voxelSize[i]) *
                (1 - 1e-6),
            ),
          ),
        ),
        ...passExtent,
      ]);
      // Row-major (F + 1)^2.
      const warpedToOutput = new Array<number>((F + 1) ** 2).fill(0);
      for (let i = 0; i < F; ++i) {
        warpedToOutput[i * (F + 1) + i] = voxelSize[i];
        warpedToOutput[i * (F + 1) + F] = geometry.lower[i];
      }
      warpedToOutput[F * (F + 1) + F] = 1;
      // Column-major (rank + 1)^2: the field block, then the passthrough
      // dimensions on the moving voxel grid.
      const chunkToMultiscaleTransform = new Float32Array((rank + 1) ** 2);
      const at = (i: number, j: number) =>
        (j === F ? rank : j) * (rank + 1) + (i === F ? rank : i);
      for (let i = 0; i <= F; ++i) {
        for (let j = 0; j <= F; ++j) {
          chunkToMultiscaleTransform[at(i, j)] =
            warpedToOutput[i * (F + 1) + j];
        }
      }
      passAffine.forEach(({ a, b }, p) => {
        chunkToMultiscaleTransform[(F + p) * (rank + 1) + F + p] = a;
        chunkToMultiscaleTransform[rank * (rank + 1) + F + p] =
          a * passLower[p] + b;
      });
      const movingSource = movingScale.chunkSource;
      // output (F dims) -> moving voxel coordinates of spatialChunkDims.
      const matched = [...Array(F).keys()].filter(
        (k) => geometry.movingOutputDims[k] !== -1,
      );
      const outputToMoving = invertAffine(
        matched.map((k) => chunkToModel[k]),
      ).flatMap((row) => {
        const out = new Array<number>(F + 1).fill(0);
        matched.forEach((k, c) => (out[k] = row[c]));
        out[F] = row[n];
        return out;
      });
      // The coarsest field level accurate enough for this scale: its measured
      // interpolation error is at most half a voxel (or, if not measured, its
      // spacing is at most a voxel).
      const lengths = voxelSize
        .map((v, i) => ({ v, i }))
        .filter(({ i }) => geometry.modelSpace.units[i] === "m");
      const warpedVoxelMeters = Math.max(
        ...lengths.map(({ v, i }) => v * geometry.scales[i]),
      );
      let level = 0;
      while (level + 1 < geometry.levels.length) {
        const next = geometry.levels[level + 1];
        const ok =
          next.maxErrorMeters !== undefined
            ? next.maxErrorMeters <= 0.5 * warpedVoxelMeters
            : next.spacingMeters <= warpedVoxelMeters * 1.0001;
        if (!ok) break;
        ++level;
      }
      const fieldVolume = field.levels[level].volume;
      const parameters = (
        fieldEntry: SliceViewSingleResolutionSource<VolumeChunkSource>,
      ): WarpedVolumeChunkSourceParameters => ({
        movingSource: movingSource.rpcId!,
        numFieldDims: F,
        movingSpatialDims: spatialChunkDims,
        movingPassDims: passChunkDims.map((dim, p) => ({
          dim,
          whole: geometry.passWhole[p],
          offset: passLower[p],
        })),
        outputToMoving,
        warpedToOutput,
        field: fieldLevelAccess(geometry, level, fieldEntry),
        // Labels are never interpolated. Segmentation layers request their
        // sources with discreteValues; the volume type alone is not enough
        // (zarr, for one, reports label arrays as images).
        interpolation:
          options.discreteValues || this.volumeType === VolumeType.SEGMENTATION
            ? WarpInterpolation.NEAREST
            : WarpInterpolation.LINEAR,
      });
      const edge = warpedChunkEdge(numDisplaced);
      const spec = makeDefaultVolumeChunkSpecifications({
        rank,
        chunkToMultiscaleTransform,
        dataType: this.dataType,
        upperVoxelBound,
        volumeType: this.volumeType,
        // Scales added above the moving ones keep the base scale's physical
        // chunk size (down to a minimum edge), so a cross section still
        // needs only a thin slab of moving data. Indexed and sliced
        // passthrough dimensions are one voxel thick.
        chunkDataSizes: [
          Uint32Array.from([
            ...[...Array(F).keys()].map((i) =>
              geometry.displaced[i]
                ? Math.max(
                    MIN_CHUNK_EDGE,
                    Math.round(edge / (factor * COARSE_CHUNK_SCALING)),
                  )
                : 1,
            ),
            ...passExtent.map((e, p) => (geometry.passWhole[p] ? e : 1)),
          ]),
        ],
        volumeSourceOptions: options,
      })[0];
      const fieldEntry = fieldVolume.getSources(
        canonicalSourceOptions(field.modelRank),
      )[0][0];
      const chunkSource = this.chunkManager.getChunkSource(
        WarpedVolumeChunkSource,
        { spec, parameters: parameters(fieldEntry) },
      );
      attachDependencies(chunkSource, [movingSource, fieldEntry.chunkSource]);
      return { chunkSource, chunkToMultiscaleTransform };
    });
    return [sources];
  }
}

/**
 * Wraps a loaded data source so that its volumes are shown in the space of a
 * displacement field. Multiscale meshes (one level of detail), skeletons and
 * annotations are warped too; segment properties are kept; other subsources
 * are dropped.
 */
export async function makeWarpedDataSource(
  chunkManager: ChunkManager,
  moving: DataSource,
  field: DisplacementField,
): Promise<{ source: DataSource; messages: string[] }> {
  const geometry = getWarpGeometry(moving.modelTransform, field);
  const messages = geometry.messages.slice();
  const subsources: DataSubsourceEntry[] = [];
  for (const entry of moving.subsources) {
    const { volume, segmentPropertyMap, mesh, annotation } = entry.subsource;
    const keep = (subsource: DataSubsource) =>
      subsources.push({ id: entry.id, default: entry.default, subsource });
    const placement = [
      entry.subsourceToModelSubspaceTransform,
      moving.modelTransform,
      field,
      geometry,
    ] as const;
    if (annotation !== undefined) {
      const warped = geometry.isSpatial3d
        ? await makeWarpedAnnotationSource(
            chunkManager,
            annotation,
            ...placement,
          )
        : undefined;
      if (warped === undefined) {
        messages.push(
          "warp: annotations are not warped (only 3-d precomputed-style " +
            "annotation sources, in a field that displaces the 3 spatial " +
            "dimensions, are)",
        );
      } else {
        keep({ annotation: warped });
      }
    } else if (mesh !== undefined) {
      // Meshes and skeletons move point by point through the field, which
      // needs the 3 spatial dimensions displaced.
      const isSkeleton = mesh instanceof SkeletonSource;
      if (!geometry.isSpatial3d) {
        messages.push(
          `warp: ${isSkeleton ? "skeletons" : "meshes"} are not warped (the ` +
            "field does not displace exactly the 3 spatial dimensions of the " +
            "source)",
        );
        continue;
      }
      const warped = isSkeleton
        ? makeWarpedSkeletonSource(chunkManager, mesh, ...placement)
        : makeWarpedMeshSource(chunkManager, mesh, ...placement);
      if (warped !== undefined) keep({ mesh: warped });
    } else if (volume !== undefined) {
      keep({
        volume: new WarpedMultiscaleVolumeChunkSource(
          chunkManager,
          volume,
          moving.modelTransform,
          field,
          geometry,
        ),
      });
    } else if (segmentPropertyMap !== undefined) {
      keep({ segmentPropertyMap });
    }
  }
  if (
    !subsources.some(
      (s) =>
        s.subsource.volume !== undefined ||
        s.subsource.mesh !== undefined ||
        s.subsource.annotation !== undefined,
    )
  ) {
    throw new Error("warp: the data source has nothing that can be warped");
  }
  return {
    source: {
      subsources,
      modelTransform: makeIdentityTransform(geometry.modelSpace),
      channelMetadata: moving.channelMetadata,
    },
    messages,
  };
}

registerWarpedDataSourceFactory(makeWarpedDataSource);
