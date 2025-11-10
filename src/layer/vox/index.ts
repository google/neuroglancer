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
  RenderScaleHistogram,
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
import { RemoteVoxSource } from "#src/voxel_annotation/remote_source.js";
import { VoxelAnnotationRenderLayer } from "#src/voxel_annotation/renderlayer.js";
import { VoxMultiscaleVolumeChunkSource } from "#src/voxel_annotation/volume_chunk_source.js";

export class VoxUserLayer extends UserLayer {
  // While drawing, we keep a reference to the vox render layer to control temporary LOD locks.
  private voxRenderLayerInstance?: VoxelAnnotationRenderLayer;
  // Match Image/Segmentation layers: provide a per-layer cross-section render scale target/histogram.
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
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

  // Labels manager integration proxies
  get onLabelsChanged(): (() => void) | undefined {
    return this.voxLabelsManager.onLabelsChanged;
  }
  set onLabelsChanged(cb: (() => void) | undefined) {
    this.voxLabelsManager.onLabelsChanged = cb;
  }

  get voxLabels(): { id: number }[] {
    return this.voxLabelsManager.labels;
  }
  get voxSelectedLabelId(): number | undefined {
    return this.voxLabelsManager.selectedLabelId;
  }
  get voxLabelsError(): string | undefined {
    return this.voxLabelsManager.labelsError;
  }

  colorForValue(v: number): string {
    return this.voxLabelsManager.colorForValue(v);
  }
  createVoxLabel(): void {
    this.voxLabelsManager.createVoxLabel(this.voxEditController);
  }
  selectVoxLabel(id: number): void {
    this.voxLabelsManager.selectVoxLabel(id);
  }
  getCurrentLabelValue(): number {
    return this.voxLabelsManager.getCurrentLabelValue(!!this.voxEraseMode);
  }

  private async loadLabels(): Promise<void> {
    const ctrl = this.voxEditController;
    if (!ctrl) return;
    await this.voxLabelsManager.initialize(ctrl);
  }

  // Remote server configuration when using vox+http(s):// data sources
  voxServerUrl?: string;
  voxServerToken?: string;

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

  /** Returns in-plane basis vectors (u, v) for the current slice plane in voxel coordinates.
   *  Uses MouseSelectionState.displayDimensions to select the two displayed axes, then maps unit
   *  vectors along those axes through the renderLayer->voxel transform.
   *  TODO: this is not working, ai are dogshit at 3d stuffs.
   */
  getBrushPlaneBasis(
    mouseState?: MouseSelectionState,
  ): { u: Float32Array; v: Float32Array } | undefined {
    try {
      const inv = this.getModelToVoxTransform();
      if (!inv) return undefined;
      const di = mouseState?.displayDimensions?.displayDimensionIndices;
      const rank = mouseState?.displayDimensions?.displayRank ?? 0;
      const i0 = di && rank >= 2 ? di[0] : 0;
      const i1 = di && rank >= 2 ? di[1] : 1;

      // Build origin and unit vectors in model/render-layer coordinate space aligned to displayed axes.
      const p0 = vec3.transformMat4(
        vec3.create(),
        vec3.fromValues(0, 0, 0),
        inv,
      );
      const uModel = [0, 0, 0] as number[];
      const vModel = [0, 0, 0] as number[];
      if (i0 >= 0 && i0 < 3) uModel[i0] = 1;
      if (i1 >= 0 && i1 < 3) vModel[i1] = 1;
      const pU = vec3.transformMat4(
        vec3.create(),
        vec3.fromValues(uModel[0], uModel[1], uModel[2]),
        inv,
      );
      const pV = vec3.transformMat4(
        vec3.create(),
        vec3.fromValues(vModel[0], vModel[1], vModel[2]),
        inv,
      );

      // Compute direction vectors and normalize.
      const ux = pU[0] - p0[0];
      const uy = pU[1] - p0[1];
      const uz = pU[2] - p0[2];
      const vx = pV[0] - p0[0];
      const vy = pV[1] - p0[1];
      const vz = pV[2] - p0[2];

      const ul = Math.hypot(ux, uy, uz);
      const vl = Math.hypot(vx, vy, vz);
      if (!Number.isFinite(ul) || ul === 0 || !Number.isFinite(vl) || vl === 0)
        return undefined;

      const u = new Float32Array([ux / ul, uy / ul, uz / ul]);
      const v = new Float32Array([vx / vl, vy / vl, vz / vl]);
      return { u, v };
    } catch {
      return undefined;
    }
  }


  private parseVoxRemoteUrl(url: string): { scheme: string; baseUrl: string; token?: string } | undefined {
    const m = url.match(/^(vox\+https?):\/\/(.+)$/);
    if (!m) return undefined;
    const scheme = m[1]; // vox+http or vox+https
    const rest = m[2];
    // Build a temporary URL for parsing. Always ensure there is a protocol.
    const proto = scheme.substring(4); // http or https
    // If rest already contains a path/query, URL will parse it.
    let tmp: URL;
    try {
      tmp = new URL(`${proto}://${rest}`);
    } catch {
      return undefined;
    }
    const baseUrl = `${proto}://${tmp.host}`;
    const token = tmp.searchParams.get("token") || undefined;
    return { scheme, baseUrl, token };
  }

  private async verifyVoxRemote(baseUrl: string, token?: string): Promise<void> {
    // Delegate verification to VoxSource: attempt to list maps via RemoteVoxSource.
    const src = new RemoteVoxSource(baseUrl, token);
    await src.listMaps();
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
      const urlStr = loadedSubsource.loadedDataSource.layerDataSource.spec.url;

      if (isLocalVox) {
        // Local in-memory vox datasource.
        this.voxServerUrl = undefined;
        this.voxServerToken = undefined;
        this.voxLoadedSubsource = loadedSubsource;
        continue;
      }

      // Non-local: only accept vox+http(s) schemes.
      const parsed = this.parseVoxRemoteUrl(urlStr);
      if (parsed) {
        // Verify the remote server before activation.
        (async () => {
          try {
            await this.verifyVoxRemote(parsed.baseUrl, parsed.token);
            this.voxServerUrl = parsed.baseUrl;
            this.voxServerToken = parsed.token;
            this.voxLoadedSubsource = loadedSubsource;
          } catch (e: any) {
            const msg = `Vox remote source check failed: ${e?.message || e}`;
            loadedSubsource.deactivate(msg);
          }
        })();
        continue;
      }

      // Reject anything else.
      loadedSubsource.deactivate(
        "Not compatible with vox layer; supported sources: local://voxel-annotations, vox+http://host[:port]/(?token=TOKEN), vox+https://host[:port]/(?token=TOKEN)",
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
