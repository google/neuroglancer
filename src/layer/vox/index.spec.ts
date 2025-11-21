import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";
import {
  getChunkPositionFromCombinedGlobalLocalPositions,
  getChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
import { WatchableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";

vi.mock("#src/render_coordinate_transform.js", () => ({
  getChunkTransformParameters: vi.fn(),
  getChunkPositionFromCombinedGlobalLocalPositions: vi.fn(),
}));

vi.mock("#src/voxel_annotation/edit_controller.js", () => ({
  VoxelEditController: class {
    dispose() {}
  },
}));

vi.mock("#src/voxel_annotation/PreviewMultiscaleChunkSource.js", () => ({
  VoxelPreviewMultiscaleSource: class {
    getSources() {
      return [[{ chunkToMultiscaleTransform: new Float32Array(16) }]];
    }
  },
}));

vi.mock("#src/layer/index.js", () => ({
  UserLayer: class {
    dataSources = [];
    layersChanged = { add: () => {}, remove: () => {}, dispatch: () => {} };
    messages = { addChild: () => {} };
    toJSON() {
      return {};
    }
    restoreState() {}
    dispose() {}
    registerDisposer() {}
  },
  LayerActionContext: class {},
}));

vi.mock("#src/layer/vox/tabs/tools.js", () => ({
  VoxToolTab: class {},
}));

vi.mock("#src/sliceview/volume/frontend.js", () => ({
  MultiscaleVolumeChunkSource: class {},
  InMemoryVolumeChunkSource: class {},
}));

let UserLayerWithVoxelEditingMixin: any;
let VoxelEditingContext: any;

beforeAll(async () => {
  if (typeof WebGL2RenderingContext === "undefined") {
    global.WebGL2RenderingContext = class {
      static VERTEX_SHADER = 0;
      static FRAGMENT_SHADER = 1;
      static ARRAY_BUFFER = 34962;
      static STATIC_DRAW = 35044;
    } as any;
  }
  if (typeof WebGLTexture === "undefined") {
    global.WebGLTexture = class {} as any;
  }

  const mod = await import("#src/layer/vox/index.js");
  UserLayerWithVoxelEditingMixin = mod.UserLayerWithVoxelEditingMixin;
  VoxelEditingContext = mod.VoxelEditingContext;
});

class MockBaseLayer extends RefCounted {
  manager = {
    chunkManager: {
      rpc: {},
    },
  };
  tabs = {
    add: vi.fn(),
  };
  specificationChanged = {
    dispatch: vi.fn(),
  };
  layersChanged = {
    dispatch: vi.fn(),
  };
  toJSON() {
    return {};
  }
  restoreState() {}
}

describe("VoxelEditingContext", () => {
  let hostLayer: any;
  let primarySource: any;
  let primaryRenderLayer: any;
  let context: any;
  let ConcreteVoxelLayer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ConcreteVoxelLayer = UserLayerWithVoxelEditingMixin(MockBaseLayer as any);

    hostLayer = new ConcreteVoxelLayer();
    hostLayer.localPosition = new WatchableValue(new Float32Array([0, 0, 0]));
    hostLayer._createVoxelRenderLayer = vi.fn().mockReturnValue({
      filterVisibleSources: vi.fn(),
      dispose: vi.fn(),
      messages: { addChild: vi.fn() },
      layerChanged: { add: vi.fn(), remove: vi.fn() },
    });
    hostLayer.addRenderLayer = vi.fn();
    hostLayer.removeRenderLayer = vi.fn();
    hostLayer.getIdentitySliceViewSourceOptions = vi.fn();

    primarySource = {
      rank: 3,
      getSources: vi
        .fn()
        .mockReturnValue([
          [{ chunkToMultiscaleTransform: new Float32Array(16) }],
        ]),
    };

    primaryRenderLayer = {
      transform: new WatchableValue({}),
    };

    context = new VoxelEditingContext(
      hostLayer,
      primarySource,
      primaryRenderLayer,
      true,
    );
  });

  afterEach(() => {
    if (context) context.dispose();
  });

  describe("getVoxelPositionFromMouse", () => {
    it("Success: returns mapped voxel position", () => {
      primaryRenderLayer.transform.value = {
        rank: 3,
        globalToRenderLayerDimensions: [0, 1, 2],
      };

      const mockChunkTransform = {
        modelTransform: { unpaddedRank: 3 },
        layerRank: 3,
        combinedGlobalLocalToChunkTransform: new Float32Array(16),
      };
      (getChunkTransformParameters as any).mockReturnValue(mockChunkTransform);

      (
        getChunkPositionFromCombinedGlobalLocalPositions as any
      ).mockImplementation((out: Float32Array) => {
        out[0] = 10;
        out[1] = 20;
        out[2] = 30;
        return true;
      });

      const mouseState = {
        unsnappedPosition: new Float32Array([100, 200, 300]),
      };

      const result = context.getVoxelPositionFromMouse(mouseState as any);

      expect(result).toBeDefined();
      expect(result![0]).toBe(10);
      expect(result![1]).toBe(20);
      expect(result![2]).toBe(30);
      expect(getChunkTransformParameters).toHaveBeenCalled();
    });

    it("Transform Error: returns undefined", () => {
      primaryRenderLayer.transform.value = { error: "Some error" };
      const mouseState = { unsnappedPosition: new Float32Array(3) };

      const result = context.getVoxelPositionFromMouse(mouseState as any);

      expect(result).toBeUndefined();
    });

    it("Calculation Failure (Throw): returns undefined", () => {
      primaryRenderLayer.transform.value = {};
      (getChunkTransformParameters as any).mockImplementation(() => {
        throw new Error("Calculation failed");
      });
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const mouseState = { unsnappedPosition: new Float32Array(3) };
      const result = context.getVoxelPositionFromMouse(mouseState as any);

      expect(result).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("Out of Bounds: returns undefined", () => {
      primaryRenderLayer.transform.value = {};
      (getChunkTransformParameters as any).mockReturnValue({
        modelTransform: { unpaddedRank: 3 },
      });
      (getChunkPositionFromCombinedGlobalLocalPositions as any).mockReturnValue(
        false,
      );

      const mouseState = { unsnappedPosition: new Float32Array(3) };
      const result = context.getVoxelPositionFromMouse(mouseState as any);

      expect(result).toBeUndefined();
    });
  });

  describe("transformGlobalToVoxelNormal", () => {
    it("Uninitialized Cache: throws error", () => {
      expect(() => {
        context.transformGlobalToVoxelNormal(vec3.create());
      }).toThrow("Chunk transform not computed");
    });

    it("Identity Transform: returns same vector", () => {
      primaryRenderLayer.transform.value = {};
      (getChunkTransformParameters as any).mockReturnValue({
        modelTransform: { globalToRenderLayerDimensions: [0, 1, 2] },
        layerToChunkTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        layerRank: 3,
        combinedGlobalLocalToChunkTransform: new Float32Array(16),
      });
      (getChunkPositionFromCombinedGlobalLocalPositions as any).mockReturnValue(
        true,
      );
      context.getVoxelPositionFromMouse({
        unsnappedPosition: new Float32Array(3),
      } as any);

      const globalNormal = vec3.fromValues(1, 0, 0);
      const result = context.transformGlobalToVoxelNormal(globalNormal);

      expect(result).toEqual(globalNormal);
    });

    it("Rotation/Permutation: transforms vector", () => {
      primaryRenderLayer.transform.value = {};
      const permMatrix = [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

      (getChunkTransformParameters as any).mockReturnValue({
        modelTransform: { globalToRenderLayerDimensions: [0, 1, 2] },
        layerToChunkTransform: permMatrix,
        layerRank: 3,
        combinedGlobalLocalToChunkTransform: new Float32Array(16),
      });
      (getChunkPositionFromCombinedGlobalLocalPositions as any).mockReturnValue(
        true,
      );
      context.getVoxelPositionFromMouse({
        unsnappedPosition: new Float32Array(3),
      } as any);

      const globalNormal = vec3.fromValues(1, 0, 0);
      const result = context.transformGlobalToVoxelNormal(globalNormal);

      expect(result[0]).toBeCloseTo(0);
      expect(result[1]).toBeCloseTo(1);
      expect(result[2]).toBeCloseTo(0);
    });
  });

  it("Non-aligned Normal with Scaling: correctly transforms and normalizes", () => {
    const scaleMatrix = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    (getChunkTransformParameters as any).mockReturnValue({
      modelTransform: { globalToRenderLayerDimensions: [0, 1, 2] },
      layerToChunkTransform: scaleMatrix,
      layerRank: 3,
      combinedGlobalLocalToChunkTransform: new Float32Array(16),
    });
    (getChunkPositionFromCombinedGlobalLocalPositions as any).mockReturnValue(
      true,
    );

    context.getVoxelPositionFromMouse({
      unsnappedPosition: new Float32Array(3),
    } as any);

    const inputLen = Math.sqrt(2);
    const globalNormal = vec3.fromValues(1 / inputLen, 1 / inputLen, 0);

    const result = context.transformGlobalToVoxelNormal(globalNormal);

    const expectedX = 2 / Math.sqrt(5);
    const expectedY = 1 / Math.sqrt(5);

    expect(result[0]).toBeCloseTo(expectedX);
    expect(result[1]).toBeCloseTo(expectedY);
    expect(result[2]).toBeCloseTo(0);
  });
});

describe("UserLayerWithVoxelEditingMixin: setVoxelPaintValue", () => {
  let layer: any;
  let mockContext: { primarySource: { dataType: DataType } };
  let ConcreteVoxelLayer: any;

  beforeEach(() => {
    ConcreteVoxelLayer = UserLayerWithVoxelEditingMixin(MockBaseLayer as any);
    layer = new ConcreteVoxelLayer();
    mockContext = { primarySource: { dataType: DataType.UINT8 } };
    layer.editingContexts.values = vi.fn().mockReturnValue({
      next: () => ({ value: mockContext }),
    });
  });

  it("UINT8: Clamps/Wraps correctly", () => {
    mockContext.primarySource.dataType = DataType.UINT8;

    expect(layer.setVoxelPaintValue(255)).toBe(255n);
    expect(layer.setVoxelPaintValue(256)).toBe(0n);
    expect(layer.setVoxelPaintValue(-1)).toBe(255n);
  });

  it("INT8: Signed wrapping", () => {
    mockContext.primarySource.dataType = DataType.INT8;

    expect(layer.setVoxelPaintValue(127)).toBe(127n);
    expect(layer.setVoxelPaintValue(128)).toBe(-128n);
    expect(layer.setVoxelPaintValue(-129)).toBe(127n);
  });

  it("FLOAT32: Parses and rounds", () => {
    mockContext.primarySource.dataType = DataType.FLOAT32;

    expect(layer.setVoxelPaintValue("10.6")).toBe(11n);
    expect(layer.setVoxelPaintValue(10.4)).toBe(10n);
  });

  it("UINT64: Handles BigInts", () => {
    mockContext.primarySource.dataType = DataType.UINT64;
    const bigVal = BigInt(Number.MAX_SAFE_INTEGER) + 10n;

    expect(layer.setVoxelPaintValue(bigVal)).toBe(bigVal);
  });

  it("No Context: Fails", () => {
    layer.editingContexts.values = vi.fn().mockReturnValue({
      next: () => ({ value: undefined }),
    });

    expect(() => layer.setVoxelPaintValue(1)).toThrow();
  });
});
