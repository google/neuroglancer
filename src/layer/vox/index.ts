/**
 * @license
 * Copyright 2025.
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

import "#src/layer/vox/style.css";

import type { CoordinateTransformSpecification } from "#src/coordinate_transform.js";
import type { DataSourceSpecification } from "#src/datasource/index.js";
import {
  LocalDataSource,
  localVoxelAnnotationsUrl,
} from "#src/datasource/local.js";
import {
  type ManagedUserLayer,
  type MouseSelectionState,
  registerLayerType,
  registerLayerTypeDetector,
  UserLayer,
} from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { VoxToolTab } from "#src/layer/vox/tabs/tools.js";
import {
  getChunkPositionFromCombinedGlobalLocalPositions,
  getChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
import {
  trackableRenderScaleTarget,
} from "#src/render_scale_statistics.js";
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import { DataType } from "#src/sliceview/base.js";
import { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import {
  constantWatchableValue,
} from "#src/trackable_value.js";
import {
  registerVoxelAnnotationTools,
} from "#src/ui/voxel_annotations.js";
import type { Borrowed } from "#src/util/disposable.js";
import * as matrix from "#src/util/matrix.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
import { LabelsManager } from "#src/voxel_annotation/labels.js";
import { VoxelAnnotationRenderLayer } from "#src/voxel_annotation/renderlayer.js";

export class VoxUserLayer extends UserLayer {
  // While drawing, we keep a reference to the vox render layer to control temporary LOD locks.
  private voxRenderLayerInstance?: VoxelAnnotationRenderLayer;
  // Match Image/Segmentation layers: provide a per-layer cross-section render scale target/histogram.
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
  static type = "vox";
  static typeAbbreviation = "vox";
  voxEditController?: VoxelEditController;
  voxLabelsManager = new LabelsManager();

  // Draw tool state
  voxBrushRadius: number = 3;
  voxEraseMode: boolean = false;
  voxBrushShape: "disk" | "sphere" = "disk";

  // Draw tab error messaging
  voxDrawErrorMessage: string | undefined = undefined;
  onDrawMessageChanged?: () => void;
  setDrawErrorMessage(message: string | undefined): void {
    this.voxDrawErrorMessage = message;
    try {
      this.onDrawMessageChanged?.();
    } catch {
      /* ignore */
    }
  }

  beginRenderLodLock(lockedIndex: number): void {
    if (!Number.isInteger(lockedIndex) || lockedIndex < 0) {
      throw new Error("beginRenderLodLock: lockedIndex must be a non-negative integer");
    }
    const rl = this.voxRenderLayerInstance;
    if (!rl) {
      throw new Error("beginRenderLodLock: render layer is not ready");
    }
    // Validate against available levels in current pyramid.
    const { multiscaleSource } = rl;
    const rank = multiscaleSource.rank;
    const options: SliceViewSourceOptions = {
      displayRank: rank,
      multiscaleToViewTransform: new Float32Array(rank * rank),
      modelChannelDimensionIndices: [],
    };
    // Create an identity transform matrix.
    for (let i = 0; i < rank; ++i) {
      options.multiscaleToViewTransform[i * rank + i] = 1;
    }
    const sources2D = multiscaleSource.getSources(options);
    const levels = sources2D?.[0]?.length ?? 0;
    if (levels <= 0) {
      throw new Error("beginRenderLodLock: multiscale source has no levels");
    }
    if (lockedIndex >= levels) {
      throw new Error(
        `beginRenderLodLock: requested LOD ${lockedIndex} exceeds available levels (${levels})`,
      );
    }
    rl.setForcedSourceIndexLock(lockedIndex);
    console.log("beginRenderLodLock: lockedIndex", lockedIndex);
  }

  endRenderLodLock(): void {
    const rl = this.voxRenderLayerInstance;
    if (!rl) return;
    rl.setForcedSourceIndexLock(undefined);
    console.log("endRenderLodLock");
  }

  constructor(managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.tabs.add("vox_tools", {
      label: "Draw",
      order: 1,
      getter: () => new VoxToolTab(this),
    });
    this.tabs.default = "vox_tools";
  }

  getVoxelPositionFromMouse(
    mouseState: MouseSelectionState,
  ): Float32Array | undefined {
    const renderLayer = this.voxRenderLayerInstance;
    if (renderLayer === undefined) {
      return undefined;
    }

    const renderLayerTransform = renderLayer.transform.value;
    if (renderLayerTransform.error !== undefined) {
      console.error("Render layer transform error:", renderLayerTransform.error);
      return undefined;
    }

    const multiscaleSource = renderLayer.multiscaleSource;
    const options: SliceViewSourceOptions = {
      displayRank: multiscaleSource.rank,
      multiscaleToViewTransform: matrix.createIdentity(Float32Array, multiscaleSource.rank * multiscaleSource.rank),
      modelChannelDimensionIndices: [],
    };
    const sources = multiscaleSource.getSources(options);
    if (sources.length === 0 || sources[0].length === 0) return undefined;
    const baseSource = sources[0][0];

    try {
      const chunkTransform = getChunkTransformParameters(
        renderLayerTransform,
        baseSource.chunkToMultiscaleTransform,
      );

      const chunkPosition = new Float32Array(chunkTransform.modelTransform.unpaddedRank);

      if (!getChunkPositionFromCombinedGlobalLocalPositions(
        chunkPosition,
        mouseState.unsnappedPosition, // Use unsnapped for higher precision
        this.localPosition.value,
        chunkTransform.layerRank,
        chunkTransform.combinedGlobalLocalToChunkTransform,
      )) {
        return undefined;
      }

      return chunkPosition;
    } catch (e) {
      console.error("Error computing voxel position:", e);
      return undefined;
    }
  }

  getLegacyDataSourceSpecifications(
    sourceSpec: string | undefined,
    layerSpec: any,
    legacyTransform: CoordinateTransformSpecification | undefined,
    explicitSpecs: DataSourceSpecification[],
  ): DataSourceSpecification[] {
    if (Object.prototype.hasOwnProperty.call(layerSpec, "source")) {
      // Respect explicit source definitions.
      return super.getLegacyDataSourceSpecifications(
        sourceSpec,
        layerSpec,
        legacyTransform,
        explicitSpecs,
      );
    }
    // Default to the special local voxel annotations data source.
    return [
      {
        url: localVoxelAnnotationsUrl,
        transform: legacyTransform,
        enableDefaultSubsources: true,
        subsources: new Map(),
      },
    ];
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>): void {
    for (const loadedSubsource of subsources) {
      const { volume } =
        loadedSubsource.subsourceEntry.subsource;
      if (volume instanceof MultiscaleVolumeChunkSource) {
        if (volume === undefined) {
          loadedSubsource.deactivate("No volume source");
          continue;
        }
        switch (volume.dataType) {
          case DataType.FLOAT32:
            loadedSubsource.deactivate(
              "Data type not compatible with segmentation layer",
            );
            continue;
        }
        this.voxEditController = new VoxelEditController(volume);
        loadedSubsource.activate(
            () => {
              const renderLayer = new VoxelAnnotationRenderLayer(volume, {
                transform: loadedSubsource.getRenderLayerTransform(),
                renderScaleTarget: this.sliceViewRenderScaleTarget,
                localPosition: this.localPosition,
                shaderParameters: constantWatchableValue({})
              });

              this.voxRenderLayerInstance = renderLayer;
              loadedSubsource.addRenderLayer(renderLayer);

              try {
                this.voxLabelsManager.initialize(this.voxEditController!);
              } catch (e) {
                console.warn("VoxUserLayer: labels initialization failed", e);
              }
            }
        );
        continue;
      }

      // Reject anything else.
      loadedSubsource.deactivate(
        "Not compatible with vox layer",
      );
    }
  }
}

registerVoxelAnnotationTools();
registerLayerType(VoxUserLayer);
registerLayerTypeDetector((subsource) => {
  if (subsource.local === LocalDataSource.voxelAnnotations) {
    return { layerConstructor: VoxUserLayer, priority: 100 };
  }
  // Accept non-local datasources at low priority to avoid interfering with other layers.
  if (subsource.local === undefined) {
    return { layerConstructor: VoxUserLayer, priority: 0 };
  }
  return undefined;
});
