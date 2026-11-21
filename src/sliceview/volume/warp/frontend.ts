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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import { makeIdentityTransform } from "#src/coordinate_transform.js";
import type { DataSource, DataSubsourceEntry } from "#src/datasource/index.js";
import { makeWarpedMeshSource } from "#src/mesh/warp/frontend.js";
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
import type { DisplacementFieldAccess } from "#src/sliceview/volume/warp/base.js";
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
  getWarpGeometry,
  inverseAffine4,
  movingModelToOutput,
  mul4,
  fullRowMajor,
  spatialSubmatrix,
  splitChunkDims,
  zarrArrayAccess,
} from "#src/sliceview/volume/warp/field.js";

// Coarser warped scales are added until the warped grid is at most this many
// voxels across.
const MAX_COARSEST_EXTENT = 256;
const MIN_CHUNK_EDGE = 8;
const COARSE_CHUNK_SCALING = 1;

// Warped chunk shape (a single layout).
const WARPED_CHUNK_SHAPES = [[32, 32, 32]];

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
    return 3 + this.geometry.channelDims.length;
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
    const movingRank = movingTransform.sourceRank;
    const [movingScales, ...otherAlternatives] = this.moving.getSources(
      canonicalSourceOptions(movingRank),
    );
    for (const alternative of otherAlternatives) {
      for (const s of alternative) s.chunkSource.dispose();
    }
    const modelToOutput = movingModelToOutput(movingTransform, geometry);
    // Moving chunk dimensions that are spatial (natural order) and channels.
    const { spatialChunkDims, channelChunkDims } = splitChunkDims(
      movingScales[0].chunkToMultiscaleTransform,
      movingRank,
      geometry.spatialInputDims,
    );
    const chunkToModelOf = (
      movingScale: SliceViewSingleResolutionSource<VolumeChunkSource>,
    ) =>
      mul4(
        modelToOutput,
        spatialSubmatrix(
          fullRowMajor(movingScale.chunkToMultiscaleTransform, movingRank),
          movingRank,
          geometry.spatialInputDims,
          spatialChunkDims,
        ),
      );
    // Channels are carried whole in every warped chunk.
    const movingSpec = movingScales[0].chunkSource.spec;
    const channelLower = channelChunkDims.map(
      (d) => movingSpec.lowerVoxelBound[d],
    );
    const channelExtent = channelChunkDims.map(
      (d) => movingSpec.upperVoxelBound[d] - movingSpec.lowerVoxelBound[d],
    );
    const rank = 3 + channelChunkDims.length;
    const voxelSizeOf = (chunkToModel: number[]) =>
      [0, 1, 2].map((i) =>
        Math.hypot(
          chunkToModel[i * 4],
          chunkToModel[i * 4 + 1],
          chunkToModel[i * 4 + 2],
        ),
      );
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
          ...[0, 1, 2].map(
            (i) => (geometry.upper[i] - geometry.lower[i]) / (size[i] * factor),
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
      // Voxel size of this scale along each output axis.
      const voxelSize = voxelSizeOf(chunkToModel).map((v) => v * factor);
      const upperVoxelBound = Float32Array.from([
        ...[0, 1, 2].map((i) =>
          Math.max(
            1,
            Math.ceil((geometry.upper[i] - geometry.lower[i]) / voxelSize[i]),
          ),
        ),
        ...channelExtent,
      ]);
      const warpedToOutput = [
        voxelSize[0],
        0,
        0,
        geometry.lower[0],
        0,
        voxelSize[1],
        0,
        geometry.lower[1],
        0,
        0,
        voxelSize[2],
        geometry.lower[2],
        0,
        0,
        0,
        1,
      ];
      // Column-major (rank + 1)^2: the spatial block, then identity channels
      // (offset to the moving volume's channel lower bounds).
      const chunkToMultiscaleTransform = new Float32Array((rank + 1) ** 2);
      const at = (i: number, j: number) =>
        (j === 3 ? rank : j) * (rank + 1) + (i === 3 ? rank : i);
      for (let i = 0; i < 4; ++i) {
        for (let j = 0; j < 4; ++j) {
          chunkToMultiscaleTransform[at(i, j)] = warpedToOutput[i * 4 + j];
        }
      }
      channelExtent.forEach((_, c) => {
        chunkToMultiscaleTransform[(3 + c) * (rank + 1) + 3 + c] = 1;
        chunkToMultiscaleTransform[rank * (rank + 1) + 3 + c] = channelLower[c];
      });
      const movingSource = movingScale.chunkSource;
      // The coarsest field level accurate enough for this scale: its measured
      // interpolation error is at most half a voxel (or, if not measured, its
      // spacing is at most a voxel).
      const warpedVoxelMeters = Math.max(
        ...voxelSize.map((v, i) => v * geometry.scales[i]),
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
      const fieldVolume = field.fields[level];
      const parameters = (
        fieldSource: VolumeChunkSource,
        boundsSource: VolumeChunkSource | undefined,
      ): WarpedVolumeChunkSourceParameters => ({
        movingSource: movingSource.rpcId!,
        movingSpatialDims: spatialChunkDims,
        movingChannelDims: channelChunkDims,
        outputToMoving: inverseAffine4(chunkToModel),
        warpedToOutput,
        field: {
          array: zarrArrayAccess(fieldVolume, fieldSource),
          vectorAxis: field.metadata.vectorAxis,
          outputToIndex: geometry.levels[level].outputToIndex,
          vectorToOutput: geometry.vectorToOutput,
          bounds:
            boundsSource === undefined
              ? undefined
              : {
                  array: zarrArrayAccess(field.bounds!, boundsSource),
                  blockShape: field.metadata.bounds!.blockShape,
                  outputToIndex: geometry.levels[0].outputToIndex,
                  unitToOutput: geometry.scales.map(
                    (s) => field.metadata.unitMeters / s,
                  ),
                },
        } satisfies DisplacementFieldAccess,
        // Labels are never interpolated. Segmentation layers request their
        // sources with discreteValues; the volume type alone is not enough
        // (zarr, for one, reports label arrays as images).
        interpolation:
          options.discreteValues || this.volumeType === VolumeType.SEGMENTATION
            ? WarpInterpolation.NEAREST
            : WarpInterpolation.LINEAR,
      });
      // One alternative per orientation: chunks thin along one axis, so that a
      // cross section only computes (and fetches moving data for) a thin slab.
      return WARPED_CHUNK_SHAPES.map((chunkDataSize, alternative) => {
        const spec = makeDefaultVolumeChunkSpecifications({
          rank,
          chunkToMultiscaleTransform,
          dataType: this.dataType,
          upperVoxelBound,
          volumeType: this.volumeType,
          // Scales added above the moving ones keep the base scale's physical
          // chunk size (down to a minimum edge), so a cross section still
          // needs only a thin slab of moving data.
          chunkDataSizes: [
            Uint32Array.from([
              ...chunkDataSize.map((c) =>
                Math.max(
                  MIN_CHUNK_EDGE,
                  Math.round(c / (factor * COARSE_CHUNK_SCALING)),
                ),
              ),
              ...channelExtent,
            ]),
          ],
          volumeSourceOptions: options,
        })[0];
        // Each alternative holds its own references to its dependencies.
        if (alternative > 0) movingSource.addRef();
        const fieldSource = fieldVolume.getSources(
          canonicalSourceOptions(4),
        )[0][0].chunkSource;
        const boundsSource =
          field.bounds === undefined || field.metadata.bounds === undefined
            ? undefined
            : field.bounds.getSources(canonicalSourceOptions(4))[0][0]
                .chunkSource;
        const dependencies = [movingSource, fieldSource];
        if (boundsSource !== undefined) dependencies.push(boundsSource);
        const chunkSource = this.chunkManager.getChunkSource(
          WarpedVolumeChunkSource,
          { spec, parameters: parameters(fieldSource, boundsSource) },
        );
        // The warped source keeps its dependencies alive; a memoized one
        // already holds its own references.
        if (chunkSource.dependencies === undefined) {
          chunkSource.dependencies = dependencies;
          for (const d of dependencies) chunkSource.registerDisposer(d);
        } else {
          for (const d of dependencies) d.dispose();
        }
        return { chunkSource, chunkToMultiscaleTransform };
      });
    });
    // [scale][alternative] -> [alternative][scale]
    return WARPED_CHUNK_SHAPES.map((_, a) => sources.map((s) => s[a]));
  }
}

/**
 * Wraps a loaded data source so that its volumes are shown in the space of a
 * displacement field. Multiscale meshes are warped too (one level of detail);
 * segment properties are kept; other subsources (annotations, ...) are
 * dropped.
 */
export function makeWarpedDataSource(
  chunkManager: ChunkManager,
  moving: DataSource,
  field: DisplacementField,
): DataSource {
  const geometry = getWarpGeometry(moving.modelTransform, field);
  const subsources: DataSubsourceEntry[] = [];
  for (const entry of moving.subsources) {
    const { volume, segmentPropertyMap, mesh } = entry.subsource;
    if (mesh !== undefined) {
      const warpedMesh = makeWarpedMeshSource(
        chunkManager,
        mesh,
        entry.subsourceToModelSubspaceTransform,
        moving.modelTransform,
        field,
        geometry,
      );
      if (warpedMesh !== undefined) {
        subsources.push({
          id: entry.id,
          default: entry.default,
          subsource: { mesh: warpedMesh },
        });
      }
      continue;
    }
    if (volume === undefined) {
      if (segmentPropertyMap !== undefined) {
        subsources.push({
          id: entry.id,
          default: entry.default,
          subsource: { segmentPropertyMap },
        });
      }
      continue;
    }
    const warped = new WarpedMultiscaleVolumeChunkSource(
      chunkManager,
      volume,
      moving.modelTransform,
      field,
      geometry,
    );
    subsources.push({
      id: entry.id,
      default: entry.default,
      subsource: { volume: warped },
    });
  }
  if (!subsources.some((s) => s.subsource.volume !== undefined)) {
    throw new Error("warp: the data source has no volume to warp");
  }
  return {
    subsources,
    modelTransform: makeIdentityTransform(geometry.modelSpace),
    channelMetadata: moving.channelMetadata,
  };
}

registerWarpedDataSourceFactory(makeWarpedDataSource);
