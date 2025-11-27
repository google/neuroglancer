import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
} from "#src/coordinate_transform.js";
import { getDefaultCredentialsManager } from "#src/credentials_provider/default_manager.js";
import { SharedCredentialsManager } from "#src/credentials_provider/shared.js";
import { DataManagementContext } from "#src/data_management_context.js";
import {
  DataSourceRegistry,
  makeEmptyDataSourceSpecification,
} from "#src/datasource/index.js";
import { DisplayContext } from "#src/display_context.js";
import { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  LayerManager,
  LayerSelectedValues,
  ManagedUserLayer,
  MouseSelectionState,
  SelectedLayerState,
  TopLevelLayerListSpecification,
  TrackableDataSelectionState,
} from "#src/layer/index.js";
import {
  LayerDataSource,
  LoadedDataSubsource,
  LoadedLayerDataSource,
} from "#src/layer/layer_data_source.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { Position } from "#src/navigation_state.js";
import {
  DataType,
  VolumeType,
  makeVolumeChunkSpecification,
} from "#src/sliceview/volume/base.js";
import {
  InMemoryVolumeChunkSource,
  MultiscaleVolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { WatchableValue } from "#src/trackable_value.js";
import { GlobalToolBinder } from "#src/ui/tool.js";
import { mat4, vec3 } from "#src/util/geom.js";
import "#src/sliceview/uncompressed_chunk_format.js";

class TestMultiscaleSource extends MultiscaleVolumeChunkSource {
  constructor(
    chunkManager: ChunkManager,
    public dataType: DataType,
  ) {
    super(chunkManager);
  }
  get volumeType() {
    return VolumeType.SEGMENTATION;
  }
  get rank() {
    return 3;
  }
  getSources(options: any) {
    void options;
    const spec = makeVolumeChunkSpecification({
      dataType: this.dataType,
      chunkDataSize: Uint32Array.from([32, 32, 32]),
      lowerVoxelBound: Float32Array.from([0, 0, 0]),
      upperVoxelBound: Float32Array.from([100, 100, 100]),
      rank: 3,
    });
    const chunkSource = this.chunkManager.getChunkSource(
      InMemoryVolumeChunkSource,
      { spec },
    );
    return [
      [
        {
          chunkSource,
          chunkToMultiscaleTransform: new Float32Array([
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
          ]),
        },
      ],
    ];
  }
}

describe("Voxel Editing Utilities", () => {
  let display: DisplayContext;
  let dataContext: DataManagementContext;

  const createLayer = (
    dataType: DataType = DataType.UINT64,
    modelTransform?: CoordinateSpaceTransform,
  ) => {
    const credentialsManager = new SharedCredentialsManager(
      getDefaultCredentialsManager(),
      dataContext.rpc,
    );
    const kvStoreContext = new SharedKvStoreContext(
      dataContext.chunkManager,
      credentialsManager,
    );
    const dataSourceProvider = new DataSourceRegistry(kvStoreContext);

    const layerManager = new LayerManager();
    const layerSelectedValues = new LayerSelectedValues(
      layerManager,
      new MouseSelectionState(),
    );
    const coordinateSpace = new WatchableValue(
      makeCoordinateSpace({
        names: ["x", "y", "z"],
        units: ["m", "m", "m"],
        scales: Float64Array.of(1, 1, 1),
      }),
    );
    const selectionState = new TrackableDataSelectionState(
      coordinateSpace,
      layerSelectedValues,
    );
    const selectedLayer = new SelectedLayerState(layerManager);
    const globalPosition = new Position(coordinateSpace);
    const toolBinder = new GlobalToolBinder(() => {}, {} as any);

    const layerSpecification = new TopLevelLayerListSpecification(
      display,
      dataSourceProvider,
      layerManager,
      dataContext.chunkManager,
      selectionState,
      selectedLayer,
      coordinateSpace,
      globalPosition,
      toolBinder,
    );

    const managedLayer = new ManagedUserLayer("test-layer", layerSpecification);
    const userLayer = new SegmentationUserLayer(managedLayer);
    managedLayer.layer = userLayer;

    const multiscaleSource = new TestMultiscaleSource(
      dataContext.chunkManager,
      dataType,
    );

    const dataSource = new LayerDataSource(userLayer);
    const loadedLayerDataSource = new LoadedLayerDataSource(
      dataSource,
      {
        canonicalUrl: "test",
        modelTransform:
          modelTransform ??
          makeIdentityTransform(
            makeCoordinateSpace({
              names: ["x", "y", "z"],
              scales: Float64Array.of(1, 1, 1),
              units: ["m", "m", "m"],
            }),
          ),
        subsources: [],
      } as any,
      makeEmptyDataSourceSpecification(),
    );

    userLayer.addCoordinateSpace(loadedLayerDataSource.transform.outputSpace);

    const subsourceEntry = {
      id: "default",
      default: true,
      subsource: { volume: multiscaleSource },
    };

    const loadedSubsource = new LoadedDataSubsource(
      loadedLayerDataSource,
      subsourceEntry,
      undefined,
      0,
      true,
    );

    let renderLayer: SegmentationRenderLayer | undefined;

    loadedSubsource.activate(() => {
      const transform = loadedSubsource.getRenderLayerTransform();
      renderLayer = new SegmentationRenderLayer(multiscaleSource, {
        ...userLayer.displayState,
        transform,
        renderScaleTarget: userLayer.sliceViewRenderScaleTarget,
        renderScaleHistogram: userLayer.sliceViewRenderScaleHistogram,
        localPosition: userLayer.localPosition,
      });
      loadedSubsource.addRenderLayer(renderLayer);

      loadedSubsource.writable.value = true;
      userLayer.initializeVoxelEditingForSubsource(
        loadedSubsource,
        renderLayer,
      );
    });

    if (!renderLayer) throw new Error("Failed to create renderLayer");

    return { userLayer, loadedSubsource, renderLayer };
  };

  beforeEach(() => {
    display = new DisplayContext(document.createElement("div"));
    dataContext = new DataManagementContext(display.gl, display);
  });

  afterEach(() => {
    display.dispose();
    dataContext.dispose();
  });

  describe("getVoxelPositionFromMouse", () => {
    it("Success: returns mapped voxel position", () => {
      const space = makeCoordinateSpace({
        names: ["x", "y", "z"],
        scales: Float64Array.of(1, 1, 1),
        units: ["m", "m", "m"],
      });
      const transform = new Float32Array(16);
      mat4.identity(transform as unknown as mat4);
      mat4.translate(
        transform as unknown as mat4,
        transform as unknown as mat4,
        [10, 5, 0],
      );
      mat4.scale(
        transform as unknown as mat4,
        transform as unknown as mat4,
        [2, 0.5, 1],
      );

      const modelTransform = {
        inputSpace: space,
        outputSpace: space,
        transform: transform as unknown as Float64Array,
        rank: 3,
        sourceRank: 3,
      };

      const { userLayer, loadedSubsource } = createLayer(
        DataType.UINT64,
        modelTransform,
      );
      const context = userLayer.editingContexts.get(loadedSubsource)!;

      const mouseState = new MouseSelectionState();
      mouseState.unsnappedPosition = Float32Array.of(20, 10, 5);

      const result = context.getVoxelPositionFromMouse(mouseState);

      expect(result).toBeDefined();
      expect(result![0]).toBeCloseTo(5);
      expect(result![1]).toBeCloseTo(10);
      expect(result![2]).toBeCloseTo(5);
    });

    it("Transform Error: returns undefined", () => {
      const { userLayer, loadedSubsource, renderLayer } = createLayer(
        DataType.UINT64,
      );
      const context = userLayer.editingContexts.get(loadedSubsource)!;

      renderLayer.transform.value = { error: "Transform error" } as any;

      const mouseState = new MouseSelectionState();
      mouseState.unsnappedPosition = Float32Array.of(10, 10, 10);

      const result = context.getVoxelPositionFromMouse(mouseState);
      expect(result).toBeUndefined();
    });

    it("Out of Bounds: returns coordinate", () => {
      const { userLayer, loadedSubsource } = createLayer(DataType.UINT64);
      const context = userLayer.editingContexts.get(loadedSubsource)!;

      const mouseState = new MouseSelectionState();
      mouseState.unsnappedPosition = Float32Array.of(1000, 2000, 3000);

      const result = context.getVoxelPositionFromMouse(mouseState);
      expect(result).toBeDefined();
      expect(result![0]).toBeCloseTo(1000);
      expect(result![1]).toBeCloseTo(2000);
      expect(result![2]).toBeCloseTo(3000);
    });
  });

  describe("transformGlobalToVoxelNormal", () => {
    it("Uninitialized Cache: throws error", () => {
      const { userLayer, loadedSubsource } = createLayer(DataType.UINT64);
      const context = userLayer.editingContexts.get(loadedSubsource)!;
      expect(() => {
        context.transformGlobalToVoxelNormal(vec3.create());
      }).toThrow("Chunk transform not computed");
    });

    it("Identity Transform: returns same vector", () => {
      const { userLayer, loadedSubsource } = createLayer(DataType.UINT64);
      const context = userLayer.editingContexts.get(loadedSubsource)!;

      const mouseState = new MouseSelectionState();
      mouseState.unsnappedPosition = Float32Array.of(10, 10, 10);
      context.getVoxelPositionFromMouse(mouseState);

      const globalNormal = vec3.fromValues(1, 0, 0);
      const result = context.transformGlobalToVoxelNormal(globalNormal);

      expect(result).toEqual(globalNormal);
    });

    it("Rotation/Permutation: transforms vector", () => {
      const space = makeCoordinateSpace({
        names: ["x", "y", "z"],
        scales: Float64Array.of(1, 1, 1),
        units: ["m", "m", "m"],
      });

      const transform = new Float64Array([
        0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);

      const modelTransform = {
        inputSpace: space,
        outputSpace: space,
        transform: transform,
        rank: 3,
        sourceRank: 3,
      };

      const { userLayer, loadedSubsource } = createLayer(
        DataType.UINT64,
        modelTransform,
      );
      const context = userLayer.editingContexts.get(loadedSubsource)!;

      const mouseState = new MouseSelectionState();
      mouseState.unsnappedPosition = Float32Array.of(10, 10, 10);
      context.getVoxelPositionFromMouse(mouseState);

      const globalNormal = vec3.fromValues(1, 0, 0);
      const result = context.transformGlobalToVoxelNormal(globalNormal);

      expect(result[0]).toBeCloseTo(0);
      expect(result[1]).toBeCloseTo(1);
      expect(result[2]).toBeCloseTo(0);
    });

    it("Non-aligned Normal with Scaling: correctly transforms and normalizes", () => {
      const space = makeCoordinateSpace({
        names: ["x", "y", "z"],
        scales: Float64Array.of(1, 1, 1),
        units: ["m", "m", "m"],
      });

      const transform = new Float64Array([
        2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);

      const modelTransform = {
        inputSpace: space,
        outputSpace: space,
        transform: transform,
        rank: 3,
        sourceRank: 3,
      };

      const { userLayer, loadedSubsource } = createLayer(
        DataType.UINT64,
        modelTransform,
      );
      const context = userLayer.editingContexts.get(loadedSubsource)!;

      const mouseState = new MouseSelectionState();
      mouseState.unsnappedPosition = Float32Array.of(10, 10, 10);
      context.getVoxelPositionFromMouse(mouseState);

      const inputLen = Math.sqrt(2);
      const globalNormal = vec3.fromValues(1 / inputLen, 1 / inputLen, 0);

      const result = context.transformGlobalToVoxelNormal(globalNormal);

      // transform(2,1,1) * (1,1,0) -> (2,1,0). Normalized -> (2,1,0)/sqrt(5).
      const expectedX = 1 / Math.sqrt(5);
      const expectedY = 2 / Math.sqrt(5);

      expect(result[0]).toBeCloseTo(expectedX);
      expect(result[1]).toBeCloseTo(expectedY);
      expect(result[2]).toBeCloseTo(0);
    });
  });

  describe("setVoxelPaintValue", () => {
    it("UINT8: Clamps and wraps", () => {
      const { userLayer } = createLayer(DataType.UINT8);
      expect(userLayer.setVoxelPaintValue(255)).toBe(255n);
      expect(userLayer.setVoxelPaintValue(256)).toBe(0n);
      expect(userLayer.setVoxelPaintValue(-1)).toBe(255n);
    });

    it("INT8: Signed wrapping", () => {
      const { userLayer } = createLayer(DataType.INT8);
      expect(userLayer.setVoxelPaintValue(127)).toBe(127n);
      expect(userLayer.setVoxelPaintValue(128)).toBe(-128n);
      expect(userLayer.setVoxelPaintValue(-129)).toBe(127n);
    });

    it("UINT64: Handles BigInts", () => {
      const { userLayer } = createLayer(DataType.UINT64);
      const bigVal = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
      expect(userLayer.setVoxelPaintValue(bigVal)).toBe(bigVal);
    });

    it("No Context: Fails", () => {
      const { userLayer } = createLayer(DataType.UINT64);
      userLayer.editingContexts.clear();
      expect(() => userLayer.setVoxelPaintValue(1)).toThrow();
    });
  });
});
