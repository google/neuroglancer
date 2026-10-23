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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChunkManager } from "#src/chunk_manager/frontend.js";
import {
  emptyValidCoordinateSpace,
  makeCoordinateSpace,
} from "#src/coordinate_transform.js";
import { VisibleLayerInfo } from "#src/layer/index.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import {
  getRenderLayerTransform,
  type RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import {
  RENDERED_VIEW_ADD_LAYER_RPC_ID,
  RENDERED_VIEW_REMOVE_LAYER_RPC_ID,
} from "#src/render_layer_common.js";
import { SpatiallyIndexedSkeletonRenderLayerBackend } from "#src/skeleton/spatial/backend.js";
import {
  MultiscaleSpatiallyIndexedSkeletonSource,
  SpatiallyIndexedSkeletonSource,
} from "#src/skeleton/spatial/frontend.js";
import {
  attachSpatiallyIndexedSkeletonLayer,
  type SpatiallyIndexedSkeletonLayer,
} from "#src/skeleton/spatial/skeleton_render_layer.js";
import type { SliceViewChunkSource } from "#src/sliceview/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { mat4 } from "#src/util/geom.js";
import { StringMemoize } from "#src/util/memoize.js";
import { NullarySignal } from "#src/util/signal.js";
import {
  registerSharedObject,
  registerSharedObjectOwner,
  RPC,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

const TEST_CHUNK_SOURCE_RPC_ID = "test/spatial_skeleton_render_layer/source";

@registerSharedObject(TEST_CHUNK_SOURCE_RPC_ID)
class TestChunkSourceBackend extends SharedObjectCounterpart {
  readonly spec: unknown;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
  }
}
TestChunkSourceBackend;

@registerSharedObjectOwner(TEST_CHUNK_SOURCE_RPC_ID)
class TestChunkSource extends SpatiallyIndexedSkeletonSource {}

class TestMultiscaleSource extends MultiscaleSpatiallyIndexedSkeletonSource {
  readonly fragmentSource = {} as any;
  readonly editableSource = undefined;

  getSources() {
    return [
      this.getLevelSpecs().map((spec) => ({
        chunkSource: this.chunkManager.getChunkSource(TestChunkSource, {
          spec,
        }),
        chunkToMultiscaleTransform: mat4.create(),
      })),
    ];
  }
}

const coordinateSpace = makeCoordinateSpace({
  names: ["x", "y", "z"],
  units: ["m", "m", "m"],
  scales: Float64Array.of(1e-9, 1e-9, 1e-9),
  boundingBoxes: [
    {
      box: {
        lowerBounds: Float64Array.of(0, 0, 0),
        upperBounds: Float64Array.of(120, 120, 120),
      },
      transform: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0),
    },
  ],
});

const displayDimensionRenderInfo: DisplayDimensionRenderInfo = {
  globalRank: 3,
  globalDimensionNames: ["x", "y", "z"],
  displayRank: 3,
  displayDimensionIndices: Int32Array.of(0, 1, 2),
  displayDimensionUnits: ["m", "m", "m"],
  displayDimensionScales: Float64Array.of(1e-9, 1e-9, 1e-9),
  canonicalVoxelFactors: Float64Array.of(1, 1, 1),
  voxelPhysicalScales: Float64Array.of(1e-9, 1e-9, 1e-9),
  canonicalVoxelPhysicalSize: 1e-9,
};

function makeConnectedRpcs() {
  const frontendTarget = {
    postMessage: (data: any) => backendTarget.onmessage!({ data } as any),
    onmessage: null as ((event: MessageEvent) => any) | null,
  };
  const backendTarget = {
    postMessage: (data: any) => frontendTarget.onmessage!({ data } as any),
    onmessage: null as ((event: MessageEvent) => any) | null,
  };
  return {
    frontendRpc: new RPC(frontendTarget, false),
    backendRpc: new RPC(backendTarget, false),
  };
}

function makeTransform(translation: number): RenderLayerTransformOrError {
  return getRenderLayerTransform(
    coordinateSpace,
    emptyValidCoordinateSpace,
    {
      rank: 3,
      sourceRank: 3,
      inputSpace: coordinateSpace,
      outputSpace: coordinateSpace,
      transform: Float64Array.of(
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        translation,
        0,
        0,
        1,
      ),
    },
    undefined,
  );
}

function makeAttachedLayer() {
  const { frontendRpc, backendRpc } = makeConnectedRpcs();
  const chunkManager = Object.assign(Object.create(ChunkManager.prototype), {
    rpc: frontendRpc,
    rpcId: frontendRpc.newId(),
    memoize: new StringMemoize(),
  }) as ChunkManager;
  const multiscaleSource = new TestMultiscaleSource(chunkManager, {
    modelSpace: coordinateSpace,
    levels: [
      { chunkSize: [60, 60, 60], limit: 10 },
      { chunkSize: [30, 30, 30], limit: 0 },
    ],
  });
  const transform = new WatchableValue(makeTransform(0));
  const base = {
    multiscaleSource,
    chunkManager,
    displayState: { transform },
  } as unknown as SpatiallyIndexedSkeletonLayer;

  const viewId = frontendRpc.newId();
  backendRpc.set(viewId, {
    projectionParameters: {
      changed: new NullarySignal(),
      value: { displayDimensionRenderInfo },
    },
    visibility: { changed: new NullarySignal() },
  });
  const backendChunkManagerId = chunkManager.rpcId!;
  backendRpc.set(backendChunkManagerId, {
    recomputeChunkPriorities: new NullarySignal(),
    scheduleUpdateChunkPriorities: () => {},
  });
  const sharedValueIds = [false, 0, new Float32Array(3)].map((value) => {
    const id = frontendRpc.newId();
    backendRpc.set(id, new WatchableValue(value));
    return id;
  });
  const layerId = frontendRpc.newId();
  new SpatiallyIndexedSkeletonRenderLayerBackend(backendRpc, {
    id: layerId,
    chunkManager: backendChunkManagerId,
    browseChunksNeeded: sharedValueIds[0],
    spacingTarget: sharedValueIds[1],
    localPosition: sharedValueIds[2],
  });
  frontendRpc.invoke(RENDERED_VIEW_ADD_LAYER_RPC_ID, {
    view: viewId,
    layer: layerId,
  });

  const renderLayer = {
    transformedSources: [] as any[][],
    redrawNeeded: new NullarySignal(),
    backend: { rpcId: layerId },
  };
  const attachment = new VisibleLayerInfo({
    rpcId: viewId,
    displayDimensionRenderInfo: new WatchableValue(displayDimensionRenderInfo),
    flushBackendProjectionParameters: () => {},
  } as any);
  attachSpatiallyIndexedSkeletonLayer(
    base,
    renderLayer as any,
    attachment as any,
  );

  return {
    multiscaleSource,
    transform,
    renderedChunkSources: () =>
      renderLayer.transformedSources.flatMap((scales) =>
        scales.map(({ source }) => source as SliceViewChunkSource),
      ),
    removeLayer: () => {
      attachment.dispose();
      frontendRpc.invoke(RENDERED_VIEW_REMOVE_LAYER_RPC_ID, {
        view: viewId,
        layer: layerId,
      });
    },
  };
}

describe("spatially indexed skeleton render layer chunk sources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the same chunk sources while the transform changes", () => {
    const layer = makeAttachedLayer();
    const initialSources = layer.renderedChunkSources();
    expect(initialSources).toHaveLength(2);

    for (const translation of [10, 20, 30]) {
      layer.transform.value = makeTransform(translation);
      vi.runAllTimers();
      const sources = layer.renderedChunkSources();
      expect(sources).toHaveLength(2);
      sources.forEach((source, index) => {
        expect(source).toBe(initialSources[index]);
      });
    }
    layer.removeLayer();
  });

  it("frees every level chunk source once the layer is removed", () => {
    const layer = makeAttachedLayer();
    const initialSources = layer.renderedChunkSources();
    for (const translation of [10, 20, 30]) {
      layer.transform.value = makeTransform(translation);
      vi.runAllTimers();
    }

    layer.removeLayer();

    expect(initialSources.map((source) => source.refCount)).toEqual([0, 0]);
    expect(initialSources.map((source) => source.wasDisposed)).toEqual([
      true,
      true,
    ]);
    const [nextSources] = layer.multiscaleSource.getSources();
    for (const { chunkSource } of nextSources) {
      expect(initialSources).not.toContain(chunkSource);
    }
  });
});
