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

import { vec3 } from "gl-matrix";
import type { CoordinateTransformSpecification } from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
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
import { VoxSettingsTab } from "#src/layer/vox/tabs/settings.js";
import { VoxToolTab } from "#src/layer/vox/tabs/tools.js";
import { getWatchableRenderLayerTransform } from "#src/render_coordinate_transform.js";
import {
  trackableRenderScaleTarget,
} from "#src/render_scale_statistics.js";
import {
  registerVoxelAnnotationTools,
} from "#src/ui/voxel_annotations.js";
import type { Borrowed } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
import { LabelsManager } from "#src/voxel_annotation/labels.js";
import { VoxMapRegistry } from "#src/voxel_annotation/map.js";
import { VoxelAnnotationRenderLayer } from "#src/voxel_annotation/renderlayer.js";
import { VoxMultiscaleVolumeChunkSource } from "#src/voxel_annotation/volume_chunk_source.js";

export class VoxUserLayer extends UserLayer {
  // While drawing, we keep a reference to the vox render layer to control temporary LOD locks.
  private voxRenderLayerInstance?: VoxelAnnotationRenderLayer;
  // Match Image/Segmentation layers: provide a per-layer cross-section render scale target/histogram.
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
  static type = "vox";
  static typeAbbreviation = "vox";
  voxEditController?: VoxelEditController;
  voxLabelsManager = new LabelsManager();
  voxMapRegistry = new VoxMapRegistry();

  // Draw tool state
  voxBrushRadius: number = 3;
  voxEraseMode: boolean = false;
  voxBrushShape: "disk" | "sphere" = "disk";
  private voxLoadedSubsource?: LoadedDataSubsource;

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
    const sources2D = rl.multiscaleSource.getSources({} as any);
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
    this.tabs.add("vox_settings", {
      label: "Map",
      order: 0,
      getter: () => new VoxSettingsTab(this),
    });
    this.tabs.add("vox_tools", {
      label: "Draw",
      order: 1,
      getter: () => new VoxToolTab(this),
    });
    this.tabs.default = "vox";
  }

  private createIdentity3D() {
    const map = this.voxMapRegistry.getCurrent();
    if (!map || !map.scaleMeters || !map.unit) {
      console.log("debug: ", map)
      throw new Error("createIdentity3D: no map selected or missing properties");
    }
    
    const units = [
      map.unit,
      map.unit,
      map.unit,
    ] as string[];

    return new WatchableCoordinateSpaceTransform(
      makeIdentityTransform(
        makeCoordinateSpace({
          rank: 3,
          names: ["x", "y", "z"],
          units,
          scales: new Float64Array(map.scaleMeters as number[]),
        }),
      ),
    );
  }

  private getModelToVoxTransform(): mat4 | undefined {
    const identity3D = this.createIdentity3D();
    const watchable = getWatchableRenderLayerTransform(
      this.manager.root.coordinateSpace,
      this.localPosition.coordinateSpace,
      identity3D,
      undefined,
    );
    const tOrError = watchable.value as any;
    if (tOrError?.error) return undefined;
    return (
      mat4.invert(mat4.create(), tOrError.modelToRenderLayerTransform) ||
      mat4.identity(mat4.create())
    );
  }

  getVoxelPositionFromMouse(
    mouseState: MouseSelectionState,
  ): Float32Array | undefined {
    try {
      if (!mouseState?.active || !mouseState?.position) return undefined;
      const inv = this.getModelToVoxTransform();
      if (!inv) return undefined;
      const p = mouseState.position;
      return vec3.transformMat4(
        vec3.create(),
        vec3.fromValues(p[0], p[1], p[2]),
        inv,
      );
    } catch {
      return undefined;
    }
  }

  private async loadLabels(): Promise<void> {
    const controller = this.voxEditController;
    if (!controller) return;
    await this.voxLabelsManager.initialize(controller);
  }

  buildOrRebuildVoxLayer() {
    const ls = this.voxLoadedSubsource;
    if (!ls) return;

    // Require an explicit map selection/creation
    const map = this.voxMapRegistry.getCurrent();
    if (!map) return;

    const guardScale = Array.from(map?.scaleMeters || [1, 1, 1]);
    // Use map bounds for guard and source
    const upper = new Float32Array(map.upperVoxelBound as number[]);
    const guardBounds = Array.from(upper);
    const guardUnit = map.unit;

    ls.activate(
      () => {
        const voxSource = new VoxMultiscaleVolumeChunkSource(
          this.manager.chunkManager,
          {
            map: map,
          },
        );
        // Expose a controller so tools can paint voxels via the source.
        this.voxEditController = new VoxelEditController(voxSource);
        this.voxEditController.initializeMap(map);

        const sources2D = voxSource.getSources({} as any);
        for (const level of (sources2D[0] ?? [])) {
          (level.chunkSource as any).initializeMap(map);
        }
        this.loadLabels();

        // Build transform with current scale and units.
        const identity3D = this.createIdentity3D();
        const transform = getWatchableRenderLayerTransform(
          this.manager.root.coordinateSpace,
          this.localPosition.coordinateSpace,
          identity3D,
          undefined,
        );

        const renderLayer = new VoxelAnnotationRenderLayer(voxSource, {
          transform: transform as any,
          renderScaleTarget: this.sliceViewRenderScaleTarget,
          renderScaleHistogram: undefined,
          localPosition: this.localPosition,
        } as any);
        this.voxRenderLayerInstance = renderLayer;
        ls.addRenderLayer(renderLayer);
      },
      guardScale,
      guardBounds,
      guardUnit,
    );
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
      const { subsourceEntry } = loadedSubsource;
      const { subsource } = subsourceEntry;
      const isLocalVox = subsource.local === LocalDataSource.voxelAnnotations;

      if (isLocalVox) {
        // Local in-memory vox datasource.
        this.voxLoadedSubsource = loadedSubsource;
        continue;
      }

      // Reject anything else.
      loadedSubsource.deactivate(
        "Not compatible with vox layer; supported sources: local://voxel-annotations",
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
