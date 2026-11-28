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
 * @file A derived displacement field, frontend side (see `derived_field.ts`):
 * the field of the inverse transformation of a stored OME-Zarr displacement
 * field, as a displacement field like any other. Each level is a volume on the
 * lattice of the stored level it inverts, shifted to cover where that level
 * maps to, whose chunks are computed in the worker.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import { DataType } from "#src/sliceview/base.js";
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
} from "#src/sliceview/volume/warp/affine.js";
import type {
  DerivedFieldParameters,
  StoredFieldLevel,
} from "#src/sliceview/volume/warp/derived_field.js";
import {
  assumedLevelError,
  DERIVED_FIELD_DOMAIN_RPC_ID,
  DerivedFieldChunkSourceParameters,
} from "#src/sliceview/volume/warp/derived_field.js";
import type {
  DerivedFieldFactory,
  DisplacementFieldMetadata,
} from "#src/sliceview/volume/warp/field.js";
import {
  assembleWarpfieldField,
  canonicalSourceOptions,
  registerDerivedFieldFactory,
} from "#src/sliceview/volume/warp/field.js";
import { attachDependencies } from "#src/sliceview/volume/warp/point_warp_frontend.js";
import type { RPC, SharedObject } from "#src/worker_rpc.js";

// Derived chunk edge along displaced dimensions (one sample thick along
// passed-through ones): a 64^3 chunk takes about 70 ms to invert.
const DERIVED_CHUNK_EDGE = 64;

class DerivedFieldChunkSource extends WithParameters(
  VolumeChunkSource,
  DerivedFieldChunkSourceParameters,
) {
  dependencies: VolumeChunkSource[] | undefined;

  initializeCounterpart(rpc: RPC, options: any) {
    // The worker holds the stored sources by counted references: its cache of
    // their chunks must keep them alive there (`SharedObject`).
    options.storedRefs = this.parameters.sources.map((id) =>
      (rpc.get(id) as SharedObject).addCounterpartRef(),
    );
    super.initializeCounterpart(rpc, options);
  }
}

type DerivedLevelParameters = Omit<
  DerivedFieldChunkSourceParameters,
  "sources"
>;

class DerivedFieldMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return DataType.FLOAT32;
  }
  volumeType = VolumeType.IMAGE;
  get rank() {
    return this.upperVoxelBound.length;
  }

  constructor(
    chunkManager: ChunkManager,
    // The stored field's levels (all of them: the search reads coarser ones).
    public stored: MultiscaleVolumeChunkSource[],
    public parameters: DerivedLevelParameters,
    // Chunk dimensions (the stored level's layout).
    public upperVoxelBound: number[],
    public chunkDataSize: number[],
    public chunkToMultiscaleTransform: Float32Array,
  ) {
    super(chunkManager);
  }

  getSources(
    options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    const entries = this.stored.map(
      (v) => v.getSources(canonicalSourceOptions(v.rank))[0][0],
    );
    const { rank, chunkToMultiscaleTransform } = this;
    const spec = makeDefaultVolumeChunkSpecifications({
      rank,
      chunkToMultiscaleTransform,
      dataType: DataType.FLOAT32,
      upperVoxelBound: Float32Array.from(this.upperVoxelBound),
      volumeType: this.volumeType,
      chunkDataSizes: [Uint32Array.from(this.chunkDataSize)],
      volumeSourceOptions: options,
    })[0];
    const chunkSource = this.chunkManager.getChunkSource(
      DerivedFieldChunkSource,
      {
        spec,
        parameters: {
          ...this.parameters,
          sources: entries.map((e) => e.chunkSource.rpcId!),
        },
      },
    );
    attachDependencies(
      chunkSource,
      entries.map((e) => e.chunkSource),
    );
    return [[{ chunkSource, chunkToMultiscaleTransform }]];
  }
}

/**
 * How the worker reads the stored field: per level, its chunk layout and its
 * place on the finest level's lattice (in chunk dimensions; zarr volumes
 * permute the array axes).
 */
export function derivedFieldParameters(
  metadata: DisplacementFieldMetadata,
  entries: SliceViewSingleResolutionSource<VolumeChunkSource>[],
): DerivedFieldParameters {
  const { spatialAxes, vectorAxis, scales } = metadata;
  if (spatialAxes.length !== 3) {
    throw new Error(
      `warp: deriving a field needs 3 spatial axes, not ${spatialAxes.length}`,
    );
  }
  const chunkDimsOf = (
    entry: SliceViewSingleResolutionSource<VolumeChunkSource>,
  ) => {
    const { rank } = entry.chunkSource.spec;
    const c2m = fullRowMajor(entry.chunkToMultiscaleTransform, rank);
    const chunkOfModel = new Array<number>(rank).fill(-1);
    for (let d = 0; d < rank; ++d) {
      for (let m = 0; m < rank; ++m) {
        const a = c2m[m * (rank + 1) + d];
        if (a === 0) continue;
        if (a !== 1 || c2m[m * (rank + 1) + rank] !== 0) {
          throw new Error("warp: unsupported displacement field chunk layout");
        }
        chunkOfModel[m] = d;
      }
    }
    return chunkOfModel;
  };
  const chunkOfModel = chunkDimsOf(entries[0]);
  const spatialDims = spatialAxes.map((a) => chunkOfModel[a]);
  const vectorDim = chunkOfModel[vectorAxis];
  const rank = entries[0].chunkSource.spec.rank;
  const numComponents =
    entries[0].chunkSource.spec.upperVoxelBound[vectorDim] -
    entries[0].chunkSource.spec.lowerVoxelBound[vectorDim];
  const { displacedAxes, spatialAxisNames } = metadata;
  const displaced = spatialAxisNames.map(
    (name) => displacedAxes === undefined || displacedAxes.includes(name),
  );
  const fine0 = scales[0].indexToSystem;
  // Field system spacing of the finest level along each array axis.
  const spacing = [0, 1, 2].map((i) =>
    Math.hypot(...fine0.map((row) => row[i])),
  );
  const toFine = invertAffine(fine0);
  const levels = entries.map((entry, l): StoredFieldLevel => {
    const own = chunkDimsOf(entry);
    if (own.some((d, m) => d !== chunkOfModel[m])) {
      throw new Error("warp: the field's levels have different chunk layouts");
    }
    const m = composeAffine(toFine, scales[l].indexToSystem);
    const scale = [0, 1, 2].map((i) => m[i][i]);
    if (
      m.some((row, i) =>
        row.slice(0, 3).some((v, j) => j !== i && Math.abs(v) > 1e-9),
      ) ||
      scale.some((v) => !(v > 0))
    ) {
      throw new Error(
        "warp: deriving a field needs levels on axis-aligned lattices",
      );
    }
    const { spec } = entry.chunkSource;
    const bound = scales[l].maxErrorBound;
    return {
      rank,
      chunkDataSize: Array.from(spec.chunkDataSize),
      baseVoxelOffset: Array.from(spec.baseVoxelOffset),
      lowerVoxelBound: Array.from(spec.lowerVoxelBound),
      upperVoxelBound: Array.from(spec.upperVoxelBound),
      scale,
      offset: [0, 1, 2].map((i) => m[i][3]),
      error:
        l === 0
          ? undefined
          : bound === undefined
            ? assumedLevelError(scale, displaced)
            : spacing.map((s) => bound / s),
      errorAssumed: l > 0 && bound === undefined,
    };
  });
  // Component k displaces field system axis k (as for drawing; see
  // `vectorToOutput`): in finest index units, the inverse of the linear part.
  const componentsToFine = toFine.flatMap((row) => row.slice(0, 3));
  return {
    levels,
    vectorDim,
    spatialDims,
    numComponents,
    displaced,
    componentsToFine,
  };
}

/** The stored field's inverse, derived (see `DerivedFieldFactory`). */
const makeDerivedField: DerivedFieldFactory = async ({
  url,
  metadata,
  spec,
  volumes,
  options,
}) => {
  const chunkManager = volumes[0].chunkManager;
  const entries = volumes.map(
    (v) => v.getSources(canonicalSourceOptions(v.rank))[0][0],
  );
  let derived: DerivedFieldParameters;
  let domain: { lo: number[]; hi: number[] };
  try {
    derived = derivedFieldParameters(metadata, entries);
    domain = await chunkManager.rpc!.promiseInvoke<{
      lo: number[];
      hi: number[];
    }>(
      DERIVED_FIELD_DOMAIN_RPC_ID,
      {
        chunkManager: chunkManager.rpcId,
        derived,
        // Counted references, released by the worker (see
        // `DerivedFieldChunkSource`).
        sources: entries.map((e) => e.chunkSource.addCounterpartRef()),
      },
      { signal: options.signal },
    );
  } finally {
    for (const e of entries) e.chunkSource.dispose();
  }
  const { spatialDims, vectorDim, numComponents, levels } = derived;
  const rank = levels[0].rank;
  const shifted = (rows: number[][], offset: number[]) =>
    rows.map((row) => {
      const out = row.slice();
      for (let i = 0; i < 3; ++i) out[3] += row[i] * offset[i];
      return out;
    });
  const derivedScales: DisplacementFieldMetadata["scales"] = [];
  const derivedVolumes: MultiscaleVolumeChunkSource[] = [];
  let finestShape: number[] = [];
  levels.forEach((level, l) => {
    // This level's lattice, over the domain (one sample of margin).
    const offset: number[] = [];
    const size: number[] = [];
    for (let i = 0; i < 3; ++i) {
      const d = spatialDims[i];
      if (!derived.displaced[i]) {
        offset.push(level.lowerVoxelBound[d]);
        size.push(level.upperVoxelBound[d] - level.lowerVoxelBound[d]);
        continue;
      }
      const a = (domain.lo[i] - level.offset[i]) / level.scale[i];
      const b = (domain.hi[i] - level.offset[i]) / level.scale[i];
      const o = Math.floor(a) - 1;
      offset.push(o);
      size.push(Math.ceil(b) + 1 - o + 1);
    }
    const upperVoxelBound = new Array<number>(rank).fill(1);
    const chunkDataSize = new Array<number>(rank).fill(1);
    upperVoxelBound[vectorDim] = numComponents;
    chunkDataSize[vectorDim] = numComponents;
    spatialDims.forEach((d, i) => {
      upperVoxelBound[d] = size[i];
      chunkDataSize[d] = derived.displaced[i]
        ? Math.min(DERIVED_CHUNK_EDGE, size[i])
        : 1;
    });
    const entry = volumes[l].getSources(canonicalSourceOptions(rank))[0][0];
    const chunkToMultiscaleTransform = Float32Array.from(
      entry.chunkToMultiscaleTransform,
    );
    entry.chunkSource.dispose();
    derivedVolumes.push(
      new DerivedFieldMultiscaleVolumeChunkSource(
        chunkManager,
        volumes,
        { derived, level: l, offset },
        upperVoxelBound,
        chunkDataSize,
        chunkToMultiscaleTransform,
      ),
    );
    const s = metadata.scales[l];
    derivedScales.push({
      ...s,
      indexToOutput: shifted(s.indexToOutput, offset),
      indexToSystem: shifted(s.indexToSystem, offset),
    });
    if (l === 0) {
      finestShape = new Array<number>(rank).fill(1);
      finestShape[metadata.vectorAxis] = numComponents;
      metadata.spatialAxes.forEach((a, i) => {
        finestShape[a] = size[i];
      });
    }
  });
  const field = assembleWarpfieldField(
    url,
    {
      ...metadata,
      scales: derivedScales,
      indexToOutput: derivedScales[0].indexToOutput,
    },
    spec,
    derivedVolumes,
    finestShape,
  );
  field.messages = derivedFieldWarnings(url, metadata, derived);
  return field;
};

// A single-level field with more chunks than this gets a warning: each
// derived chunk reads all of them.
const MAX_QUIET_WHOLE_LEVEL_CHUNKS = 64;

/** Warnings about how exactly, and how fast, the inverse is derived. */
export function derivedFieldWarnings(
  url: string,
  metadata: DisplacementFieldMetadata,
  derived: DerivedFieldParameters,
): string[] {
  const messages: string[] = [];
  const assumed = derived.levels
    .map((level, l) => (level.errorAssumed ? metadata.scales[l].path : ""))
    .filter((path) => path !== "");
  if (assumed.length > 0) {
    messages.push(
      `warp: ${url} gives no maximum interpolation error for levels ` +
        `${assumed.join(", ")}, so its inverse is derived assuming each is ` +
        "within one of its samples of the finest level. Where the field " +
        "deviates more (tears, folds), the inverse may have small gaps. " +
        "attributes.warpfield.levels[].interpolation_error.max makes it exact.",
    );
  }
  if (derived.levels.length === 1) {
    const level = derived.levels[0];
    const chunks = derived.spatialDims.reduce(
      (n, d) =>
        n *
        Math.ceil(
          (level.upperVoxelBound[d] - level.lowerVoxelBound[d]) /
            level.chunkDataSize[d],
        ),
      1,
    );
    if (chunks > MAX_QUIET_WHOLE_LEVEL_CHUNKS) {
      messages.push(
        `warp: ${url} has one level, so each chunk of its inverse reads the ` +
          `whole field (${chunks} chunks). A multiscale field, or storing ` +
          "the inverse field too, avoids this.",
      );
    }
  }
  return messages;
}

registerDerivedFieldFactory(makeDerivedField);
