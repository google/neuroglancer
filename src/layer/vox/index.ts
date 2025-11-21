/**
 * @license
 * Copyright 2025 Google Inc.
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

import type {
  LayerActionContext,
  MouseSelectionState,
} from "#src/layer/index.js";
import { UserLayer } from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { VoxToolTab } from "#src/layer/vox/tabs/tools.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import {
  getChunkPositionFromCombinedGlobalLocalPositions,
  getChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
import type {
  SliceViewBase,
  SliceViewSourceOptions,
  TransformedSource,
} from "#src/sliceview/base.js";
import { DataType } from "#src/sliceview/base.js";
import type { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import type { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { StatusMessage } from "#src/status.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeDerivedWatchableValue,
  TrackableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { randomUint64 } from "#src/util/bigint.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import {
  parseUint64,
  verifyFiniteFloat,
  verifyInt,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";
import { VoxelPreviewMultiscaleSource } from "#src/voxel_annotation/PreviewMultiscaleChunkSource.js";
import type { VoxelEditControllerHost } from "#src/voxel_annotation/base.js";
import { BrushShape } from "#src/voxel_annotation/base.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";

const BRUSH_SIZE_JSON_KEY = "brushSize";
const ERASE_MODE_JSON_KEY = "eraseMode";
const BRUSH_SHAPE_JSON_KEY = "brushShape";
const FLOOD_FILL_MAX_VOXELS_JSON_KEY = "floodFillMaxVoxels";
const PAINT_VALUE_JSON_KEY = "paintValue";

const DATA_TYPE_BIT_INFO = {
  [DataType.UINT8]: { bits: 8, signed: false },
  [DataType.INT8]: { bits: 8, signed: true },
  [DataType.UINT16]: { bits: 16, signed: false },
  [DataType.INT16]: { bits: 16, signed: true },
  [DataType.UINT32]: { bits: 32, signed: false },
  [DataType.INT32]: { bits: 32, signed: true },
  [DataType.UINT64]: { bits: 64, signed: false },
};

export class VoxelEditingContext
  extends RefCounted
  implements VoxelEditControllerHost
{
  controller: VoxelEditController | undefined = undefined;

  private cachedChunkTransform: ChunkTransformParameters | undefined;
  private cachedTransformGeneration: number = -1;
  private cachedVoxelPosition: Float32Array = new Float32Array(3);
  optimisticRenderLayer:
    | ImageRenderLayer
    | SegmentationRenderLayer
    | undefined = undefined;
  previewSource: VoxelPreviewMultiscaleSource | undefined = undefined;

  constructor(
    public hostLayer: UserLayerWithVoxelEditing,
    public primarySource: MultiscaleVolumeChunkSource,
    public primaryRenderLayer: ImageRenderLayer | SegmentationRenderLayer,
    public writable: boolean,
  ) {
    super();

    if (!writable) return;

    // NOTE: each of the following 3 checks may be removed if support for the checked contraint is added
    if (primarySource.rank !== 3) {
      throw new Error(
        `Voxel annotation only supports rank 3 volumes (got ${primarySource.rank}).`,
      );
    }
    if (primarySource.dataType === DataType.FLOAT32) {
      throw new Error(`Voxel annotation does not support Float32 datasets.`);
    }
    this.validateHierarchy(primarySource);

    this.previewSource = new VoxelPreviewMultiscaleSource(
      this.hostLayer.manager.chunkManager,
      primarySource,
    );

    const transform = primaryRenderLayer.transform;

    this.optimisticRenderLayer = this.hostLayer._createVoxelRenderLayer(
      this.previewSource,
      transform,
    );

    // since we only allow drawing at max res, we can lock the optimistic render layer to it
    this.optimisticRenderLayer.filterVisibleSources = function* (
      this: SliceViewRenderLayer,
      _sliceView: SliceViewBase,
      sources: readonly TransformedSource[],
    ): Iterable<TransformedSource> {
      if (sources.length > 0) {
        yield sources[0];
      }
    };

    this.hostLayer.addRenderLayer(this.optimisticRenderLayer);

    this.controller = new VoxelEditController(this);
  }

  get rpc() {
    return this.hostLayer.manager.chunkManager.rpc!;
  }

  disposed() {
    if (this.controller) this.controller.dispose();
    if (this.optimisticRenderLayer)
      this.hostLayer.removeRenderLayer(this.optimisticRenderLayer);
    super.disposed();
  }

  /**
   * Verifies that the size of a parent chunk is an integer multiple
   * of the size of a child chunk.
   */
  private validateHierarchy(primarySource: MultiscaleVolumeChunkSource) {
    const rank = primarySource.rank;

    const identityOptions = this.hostLayer.getIdentitySliceViewSourceOptions();
    const scales = primarySource.getSources(identityOptions)[0];

    if (!scales || scales.length < 2) return;

    const getPhysicalChunkExtent = (lodIndex: number) => {
      const source = scales[lodIndex];
      const transform = source.chunkToMultiscaleTransform;
      const chunkVoxels = source.chunkSource.spec.chunkDataSize;

      const extent = new Float32Array(rank);

      for (let i = 0; i < rank; i++) {
        let sumSq = 0;
        for (let row = 0; row < rank; row++) {
          const val = transform[i * (rank + 1) + row];
          sumSq += val * val;
        }
        const scaleFactor = Math.sqrt(sumSq);
        extent[i] = chunkVoxels[i] * scaleFactor;
      }
      return extent;
    };

    for (let i = 0; i < scales.length - 1; i++) {
      const childExtents = getPhysicalChunkExtent(i);
      const parentExtents = getPhysicalChunkExtent(i + 1);

      for (let d = 0; d < rank; d++) {
        const ratio = parentExtents[d] / childExtents[d];
        const isInteger = Math.abs(ratio - Math.round(ratio)) < 0.001;

        if (!isInteger) {
          throw new Error(
            `Hierarchy mismatch between LOD ${i} and ${i + 1}. ` +
              `Parent chunk must contain a whole number of child chunks. ` +
              `Ratio dim ${d}: ${ratio.toFixed(3)}`,
          );
        }
      }
    }
  }

  getVoxelPositionFromMouse(
    mouseState: MouseSelectionState,
  ): Float32Array | undefined {
    const renderLayer = this.primaryRenderLayer;
    const renderLayerTransform = renderLayer.transform.value;
    if (renderLayerTransform.error !== undefined) {
      return undefined;
    }

    const transformGeneration = renderLayer.transform.changed.count;
    if (this.cachedTransformGeneration !== transformGeneration) {
      this.cachedChunkTransform = undefined;
      try {
        this.cachedChunkTransform = getChunkTransformParameters(
          renderLayerTransform,
          this.primarySource.getSources(
            this.hostLayer.getIdentitySliceViewSourceOptions(),
          )[0][0]!.chunkToMultiscaleTransform,
        );
        this.cachedTransformGeneration = transformGeneration;
      } catch (e) {
        this.cachedTransformGeneration = -1;
        console.error("Error computing chunk transform parameters:", e);
        return undefined;
      }
    }

    const chunkTransform = this.cachedChunkTransform;
    if (chunkTransform === undefined) return undefined;

    if (
      this.cachedVoxelPosition.length !==
      chunkTransform.modelTransform.unpaddedRank
    ) {
      this.cachedVoxelPosition = new Float32Array(
        chunkTransform.modelTransform.unpaddedRank,
      );
    }

    const ok = getChunkPositionFromCombinedGlobalLocalPositions(
      this.cachedVoxelPosition,
      mouseState.unsnappedPosition,
      this.hostLayer.localPosition.value,
      chunkTransform.layerRank,
      chunkTransform.combinedGlobalLocalToChunkTransform,
    );
    if (!ok) return undefined;
    return this.cachedVoxelPosition;
  }

  transformGlobalToVoxelNormal(globalNormal: vec3): vec3 {
    const chunkTransform = this.cachedChunkTransform;
    if (chunkTransform === undefined)
      throw new Error("Chunk transform not computed");
    const { modelTransform, layerToChunkTransform, layerRank } = chunkTransform;
    const { globalToRenderLayerDimensions } = modelTransform;
    const globalRank = globalToRenderLayerDimensions.length;
    const voxelNormal = vec3.create();

    for (let chunkDim = 0; chunkDim < 3; ++chunkDim) {
      let sum = 0;
      for (
        let globalDim = 0;
        globalDim < Math.min(globalRank, 3);
        ++globalDim
      ) {
        const layerDim = globalToRenderLayerDimensions[globalDim];
        if (layerDim !== -1) {
          sum +=
            layerToChunkTransform[chunkDim + layerDim * (layerRank + 1)] *
            globalNormal[globalDim];
        }
      }
      voxelNormal[chunkDim] = sum;
    }
    vec3.normalize(voxelNormal, voxelNormal);
    return voxelNormal;
  }
}

export declare abstract class UserLayerWithVoxelEditing extends UserLayer {
  isEditable: WatchableValue<boolean>;

  voxBrushRadius: TrackableValue<number>;
  voxEraseMode: TrackableBoolean;
  voxBrushShape: TrackableEnum<BrushShape>;
  voxFloodMaxVoxels: TrackableValue<number>;
  paintValue: TrackableValue<bigint>;

  editingContexts: Map<LoadedDataSubsource, VoxelEditingContext>;

  abstract _createVoxelRenderLayer(
    source: MultiscaleVolumeChunkSource,
    transform: WatchableValueInterface<RenderLayerTransformOrError>,
  ): ImageRenderLayer | SegmentationRenderLayer;
  abstract getVoxelPaintValue(erase: boolean): bigint;
  abstract setVoxelPaintValue(value: any): bigint;

  initializeVoxelEditingForSubsource(
    loadedSubsource: LoadedDataSubsource,
    renderlayer: SegmentationRenderLayer | ImageRenderLayer,
  ): void;
  deinitializeVoxelEditingForSubsource(
    loadedSubsource: LoadedDataSubsource,
  ): void;

  getIdentitySliceViewSourceOptions(): SliceViewSourceOptions;
  handleVoxAction(action: string, context: LayerActionContext): void;
}

export function UserLayerWithVoxelEditingMixin<
  TBase extends { new (...args: any[]): UserLayerWithAnnotations },
>(Base: TBase) {
  abstract class C extends Base implements UserLayerWithVoxelEditing {
    editingContexts = new Map<LoadedDataSubsource, VoxelEditingContext>();
    isEditable = new WatchableValue<boolean>(false);
    paintValue = new TrackableValue<bigint>(1n, (x) => parseUint64(x));

    // Brush properties
    voxBrushRadius = new TrackableValue<number>(3, verifyInt);
    voxEraseMode = new TrackableBoolean(false);
    voxBrushShape = new TrackableEnum(BrushShape, BrushShape.DISK);
    voxFloodMaxVoxels = new TrackableValue<number>(10000, verifyFiniteFloat);

    constructor(...args: any[]) {
      super(...args);
      this.registerDisposer(() => {
        for (const context of this.editingContexts.values()) {
          context.dispose();
        }
        this.editingContexts.clear();
      });
      this.voxBrushRadius.changed.add(this.specificationChanged.dispatch);
      this.voxEraseMode.changed.add(this.specificationChanged.dispatch);
      this.voxBrushShape.changed.add(this.specificationChanged.dispatch);
      this.voxFloodMaxVoxels.changed.add(this.specificationChanged.dispatch);
      this.paintValue.changed.add(this.specificationChanged.dispatch);
      this.tabs.add("Draw", {
        label: "Draw",
        order: 20,
        hidden: makeDerivedWatchableValue(
          (editable) => !editable,
          this.isEditable,
        ),
        getter: () => new VoxToolTab(this),
      });
    }

    toJSON() {
      const json = super.toJSON();
      json[BRUSH_SIZE_JSON_KEY] = this.voxBrushRadius.toJSON();
      json[ERASE_MODE_JSON_KEY] = this.voxEraseMode.toJSON();
      json[BRUSH_SHAPE_JSON_KEY] = this.voxBrushShape.toJSON();
      json[FLOOD_FILL_MAX_VOXELS_JSON_KEY] = this.voxFloodMaxVoxels.toJSON();
      json[PAINT_VALUE_JSON_KEY] = this.paintValue.toJSON();
      return json;
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      verifyOptionalObjectProperty(specification, BRUSH_SIZE_JSON_KEY, (v) =>
        this.voxBrushRadius.restoreState(v),
      );
      verifyOptionalObjectProperty(specification, ERASE_MODE_JSON_KEY, (v) =>
        this.voxEraseMode.restoreState(v),
      );
      verifyOptionalObjectProperty(specification, BRUSH_SHAPE_JSON_KEY, (v) =>
        this.voxBrushShape.restoreState(v),
      );
      verifyOptionalObjectProperty(
        specification,
        FLOOD_FILL_MAX_VOXELS_JSON_KEY,
        (v) => this.voxFloodMaxVoxels.restoreState(v),
      );
      verifyOptionalObjectProperty(specification, PAINT_VALUE_JSON_KEY, (v) =>
        this.paintValue.restoreState(v),
      );
    }

    getVoxelPaintValue(erase: boolean): bigint {
      if (erase) return 0n;
      return this.paintValue.value;
    }

    setVoxelPaintValue(x: any) {
      const editContext = this.editingContexts.values().next().value;
      const dataType = editContext.primarySource.dataType;
      let value: bigint;

      if (dataType === DataType.FLOAT32) {
        const floatValue = parseFloat(String(x));
        value = BigInt(Math.round(floatValue));
      } else {
        value = BigInt(x);
      }

      const info =
        DATA_TYPE_BIT_INFO[dataType as keyof typeof DATA_TYPE_BIT_INFO];
      if (!info) {
        this.paintValue.value = value;
        return value;
      }

      const { bits, signed } = info;
      const mask = (1n << BigInt(bits)) - 1n;
      let truncated = value & mask;

      if (signed) {
        const signBit = 1n << BigInt(bits - 1);
        if ((truncated & signBit) !== 0n) {
          truncated -= 1n << BigInt(bits);
        }
      }

      this.paintValue.value = truncated;
      return truncated;
    }

    abstract _createVoxelRenderLayer(
      source: MultiscaleVolumeChunkSource,
      transform: WatchableValueInterface<RenderLayerTransformOrError>,
    ): ImageRenderLayer | SegmentationRenderLayer;

    initializeVoxelEditingForSubsource(
      loadedSubsource: LoadedDataSubsource,
      renderlayer: SegmentationRenderLayer | ImageRenderLayer,
      writable: boolean = true,
    ): void {
      if (this.editingContexts.has(loadedSubsource)) return;

      const primarySource = loadedSubsource.subsourceEntry.subsource
        .volume as MultiscaleVolumeChunkSource;

      try {
        const context = new VoxelEditingContext(
          this,
          primarySource,
          renderlayer,
          writable,
        );
        this.editingContexts.set(loadedSubsource, context);
        this.isEditable.value = writable;
        this.setVoxelPaintValue(this.paintValue.value);
      } catch (e) {
        if (writable) {
          loadedSubsource.writable.value = false;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("Failed to initialize voxel editing:", msg);
          StatusMessage.showTemporaryMessage(msg, 5000);
        }
      }
    }

    deinitializeVoxelEditingForSubsource(loadedSubsource: LoadedDataSubsource) {
      const context = this.editingContexts.get(loadedSubsource);
      if (context) {
        context.dispose();
        this.editingContexts.delete(loadedSubsource);
      }
      if (this.editingContexts.size === 0 && this.isEditable.value) {
        this.isEditable.value = false;
      }
    }

    getIdentitySliceViewSourceOptions(): SliceViewSourceOptions {
      const rank = this.localCoordinateSpace.value.rank;
      const displayRank = rank;
      const multiscaleToViewTransform = new Float32Array(displayRank * rank);
      for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
        for (let displayDim = 0; displayDim < displayRank; ++displayDim) {
          multiscaleToViewTransform[displayRank * chunkDim + displayDim] =
            chunkDim === displayDim ? 1 : 0;
        }
      }
      return {
        displayRank,
        multiscaleToViewTransform,
        modelChannelDimensionIndices: [],
      };
    }

    handleVoxAction(action: string, _context: LayerActionContext): void {
      const firstContext = this.editingContexts.values().next().value;
      if (!firstContext) return;
      const controller = firstContext.controller;
      switch (action) {
        case "undo":
          controller.undo();
          break;
        case "redo":
          controller.redo();
          break;
        case "randomize-paint-value":
          this.setVoxelPaintValue(randomUint64());
          break;
      }
    }
  }
  return C;
}
