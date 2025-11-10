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

import type { LayerActionContext, MouseSelectionState, UserLayer } from "#src/layer/index.js"
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
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import type {
  VolumeType,
} from "#src/sliceview/volume/base.js";
import type {
  MultiscaleVolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import type { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import type { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type {
  WatchableValueInterface} from "#src/trackable_value.js";
import {
  TrackableValue,
  WatchableValue
} from "#src/trackable_value.js";
import type {
  UserLayerWithAnnotations,
} from "#src/ui/annotations.js";
import { RefCounted } from "#src/util/disposable.js";
import { verifyFiniteFloat, verifyInt } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";
import { VoxelPreviewMultiscaleSource } from "#src/voxel_annotation/PreviewMultiscaleChunkSource.js";
import type { VoxelEditControllerHost } from "#src/voxel_annotation/edit_controller.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
import { LabelsManager } from "#src/voxel_annotation/labels.js";

export enum BrushShape {
  DISK = 0,
  SPHERE = 1,
}

export class VoxelEditingContext
  extends RefCounted
  implements VoxelEditControllerHost
{
  controller: VoxelEditController;

  private cachedChunkTransform: ChunkTransformParameters | undefined;
  private cachedTransformGeneration: number = -1;
  private cachedVoxelPosition: Float32Array = new Float32Array(3);


  constructor(
    public hostLayer: UserLayerWithVoxelEditing,
    public primarySource: MultiscaleVolumeChunkSource,
    public previewSource: VoxelPreviewMultiscaleSource,
    public optimisticRenderLayer: ImageRenderLayer | SegmentationRenderLayer,
  ) {
    super();
    this.controller = new VoxelEditController(this);
    //this.registerDisposer(optimisticRenderLayer);
  }

  // VoxelEditControllerHost implementation
  get labelsManager(): LabelsManager {
    return this.hostLayer.voxLabelsManager!;
  }
  get rpc() {
    return this.hostLayer.manager.chunkManager.rpc!;
  }
  setDrawErrorMessage(message: string | undefined): void {
    this.hostLayer.setDrawErrorMessage(message);
  }

  disposed() {
    this.controller.dispose();
    super.disposed();
  }

  getVoxelPositionFromMouse(
    mouseState: MouseSelectionState,
  ): Float32Array | undefined {
    const renderLayer = this.optimisticRenderLayer;
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


  get voxRenderLayerInstance():
    | ImageRenderLayer
    | SegmentationRenderLayer
    | undefined {
    // TODO
    return undefined;
  }
}

export declare abstract class UserLayerWithVoxelEditing extends UserLayer {
  voxLabelsManager?: LabelsManager;
  labelsChanged: NullarySignal;
  isEditable: WatchableValue<boolean>;
  onDrawMessageChanged?: () => void;
  voxDrawErrorMessage: string | undefined;

  voxBrushRadius: TrackableValue<number>;
  voxEraseMode: TrackableBoolean;
  voxBrushShape: TrackableEnum<BrushShape>;
  voxFloodMaxVoxels: TrackableValue<number>;

  editingContexts: Map<LoadedDataSubsource, VoxelEditingContext>;

  abstract _createVoxelRenderLayer(
    source: MultiscaleVolumeChunkSource,
    transform: WatchableValueInterface<RenderLayerTransformOrError>,
  ): ImageRenderLayer | SegmentationRenderLayer;

  initializeVoxelEditingForSubsource(loadedSubsource: LoadedDataSubsource, volumeType: VolumeType): void;
  deinitializeVoxelEditingForSubsource(
    loadedSubsource: LoadedDataSubsource,
  ): void;

  getIdentitySliceViewSourceOptions(): SliceViewSourceOptions;
  setDrawErrorMessage(message: string | undefined): void;
  handleVoxAction(action: string, context: LayerActionContext): void;
}

export function UserLayerWithVoxelEditingMixin<
  TBase extends { new (...args: any[]): UserLayerWithAnnotations },
>(Base: TBase) {
  abstract class C extends Base implements UserLayerWithVoxelEditing {
    editingContexts = new Map<LoadedDataSubsource, VoxelEditingContext>();
    voxLabelsManager?: LabelsManager;
    labelsChanged = new NullarySignal();
    isEditable = new WatchableValue<boolean>(false);

    // Brush properties
    voxBrushRadius = new TrackableValue<number>(3, verifyInt);
    voxEraseMode = new TrackableBoolean(false);
    voxBrushShape = new TrackableEnum(BrushShape, BrushShape.DISK);
    voxFloodMaxVoxels = new TrackableValue<number>(10000, verifyFiniteFloat);


    voxDrawErrorMessage: string | undefined = undefined;
    onDrawMessageChanged?: () => void;
    setDrawErrorMessage(message: string | undefined): void {
      this.voxDrawErrorMessage = message;
      this.onDrawMessageChanged?.();
    }

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
      this.tabs.add("Draw", {
        label: "Draw",
        order: 20,
        getter: () => new VoxToolTab(this),
      });
    }

    abstract _createVoxelRenderLayer(
      source: MultiscaleVolumeChunkSource,
      transform: WatchableValueInterface<RenderLayerTransformOrError>,
    ): ImageRenderLayer | SegmentationRenderLayer;


    initializeVoxelEditingForSubsource(loadedSubsource: LoadedDataSubsource) {
      if (this.editingContexts.has(loadedSubsource)) return;

      const primarySource = loadedSubsource.subsourceEntry.subsource
        .volume as MultiscaleVolumeChunkSource;
      const baseSpec = primarySource.getSources(
        this.getIdentitySliceViewSourceOptions(),
      )[0][0]!.chunkSource.spec;

      if (this.voxLabelsManager === undefined) {
        this.voxLabelsManager = new LabelsManager(
          baseSpec.dataType,
          this.labelsChanged.dispatch,
        );
      }

      const previewSource = new VoxelPreviewMultiscaleSource(
        this.manager.chunkManager,
        primarySource
      );

      const transform = loadedSubsource.getRenderLayerTransform();

      const optimisticRenderLayer = this._createVoxelRenderLayer(
        previewSource,
        transform,
      );

      const context = new VoxelEditingContext(
        this,
        primarySource,
        previewSource,
        optimisticRenderLayer,
      );
      this.editingContexts.set(loadedSubsource, context);
      this.addRenderLayer(optimisticRenderLayer);
    }


    deinitializeVoxelEditingForSubsource(loadedSubsource: LoadedDataSubsource) {
      const context = this.editingContexts.get(loadedSubsource);
      if (context) {
        this.removeRenderLayer(context.optimisticRenderLayer);
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

    handleVoxAction(action: string, context: LayerActionContext): void {
      super.handleAction(action, context);
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
        case "new-label":
          this.voxLabelsManager?.createNewLabel();
          break;
      }
    }
  }
  return C;
}
