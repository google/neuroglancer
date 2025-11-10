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
import { SegmentColorHash } from "#src/segment_color.js";
import {
  registerVoxelAnnotationTools,
} from "#src/ui/voxel_annotations.js";
import type { Borrowed } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
import { RemoteVoxSource } from "#src/voxel_annotation/index.js";
import { VoxMapRegistry } from "#src/voxel_annotation/map.js";
import { VoxelAnnotationRenderLayer } from "#src/voxel_annotation/renderlayer.js";
import { VoxMultiscaleVolumeChunkSource } from "#src/voxel_annotation/volume_chunk_source.js";

export class VoxUserLayer extends UserLayer {
  onLabelsChanged?: () => void;
  voxMapId: string | undefined;
  // Label state for painting: only store ids; colors are hashed from id on the fly
  voxLabels: { id: number }[] = [];
  voxSelectedLabelId: number | undefined = undefined;
  voxLabelsError: string | undefined = undefined;
  // Indicates whether an initial labels load attempt has completed.
  private voxLabelsInitialized: boolean = false;
  segmentColorHash = SegmentColorHash.getDefault();
  // Match Image/Segmentation layers: provide a per-layer cross-section render scale target/histogram.
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
  static type = "vox";
  static typeAbbreviation = "vox";
  voxEditController?: VoxelEditController;

  // Settings state
  voxScale: Float64Array = new Float64Array([
    0.000000008, 0.000000008, 0.000000008,
  ]);
  voxScaleUnit: string = "nm";
  // Region selection via corners
  voxCornerA: Float32Array = new Float32Array([0, 0, 0]);
  voxCornerB: Float32Array = new Float32Array([
    1_000_000, 1_000_000, 1_000_000,
  ]);
  // Draw tool state
  voxBrushRadius: number = 3;
  voxEraseMode: boolean = false;
  voxBrushShape: "disk" | "sphere" = "disk";
  private voxLoadedSubsource?: LoadedDataSubsource;

  // Remote server configuration when using vox+http(s):// data sources
  voxServerUrl?: string;
  voxServerToken?: string;

  // --- Label helpers ---
  private genId(): number {
    // Generate a unique uint32 per layer session. Try crypto.getRandomValues; fallback to Math.random.
    let id = 0;
    const used = new Set(this.voxLabels.map((l) => l.id));
    for (let attempts = 0; attempts < 10_000; attempts++) {
      if (typeof crypto !== "undefined" && (crypto as any).getRandomValues) {
        const a = new Uint32Array(1);
        (crypto as any).getRandomValues(a);
        id = a[0] >>> 0;
      } else {
        id = Math.floor(Math.random() * 0xffffffff) >>> 0;
      }
      if (id !== 0 && !used.has(id)) return id;
    }
    // As an ultimate fallback, probe sequentially from a time-based seed.
    const base = (Date.now() ^ ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
    id = base || 1;
    while (used.has(id)) id = (id + 1) >>> 0;
    return id >>> 0;
  }
  colorForValue(v: number): string {
    // Use segmentation-like color from SegmentColorHash seeded on numeric value
    return this.segmentColorHash.computeCssColor(BigInt(v >>> 0));
  }

  // --- Labels persistence (via VoxSource) ---
  private async loadLabels() {
    try {
      const arr = await this.voxEditController?.getLabelIds();
      if (arr && Array.isArray(arr)) {
        if (arr.length > 0) {
          this.voxLabels = arr.map((id) => ({ id: id >>> 0 }));
          const sel = this.voxSelectedLabelId;
          if (!sel || !this.voxLabels.some((l) => l.id === sel)) {
            this.voxSelectedLabelId = this.voxLabels[0].id;
          }
        } else {
          this.voxLabels = [];
          this.voxSelectedLabelId = undefined;
        }
      } else {
        throw new Error("Invalid labels response");
      }
    } catch (e: any) {
      const msg = `Failed to load labels: ${e?.message || e}`;
      console.error(msg);
      this.voxLabelsError = msg;
    } finally {
      // Mark labels as initialized; UI/painting should not trigger default creation before this point.
      this.voxLabelsInitialized = true;
      try {
        this.onLabelsChanged?.();
      } catch {
        /* ignore */
      }
    }
  }

  async createVoxLabel() {
    const id = this.genId(); // unique uint32
    if (!this.voxEditController) {
      const msg = "Labels backend not ready; please try again after source initializes.";
      console.error(msg);
      this.voxLabelsError = msg;
      return;
    }
    try {
      const updated = await this.voxEditController.addLabel(id);
      this.voxLabels = updated.map((x) => ({ id: x >>> 0 }));
      // Prefer to select the last label from the updated list (likely the one just added).
      const last = this.voxLabels[this.voxLabels.length - 1]?.id;
      this.voxSelectedLabelId = last ?? id;
      this.voxLabelsError = undefined;
      try {
        this.onLabelsChanged?.();
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      const msg = `Failed to create label: ${e?.message || e}`;
      console.error(msg);
      this.voxLabelsError = msg;
      try {
        this.onLabelsChanged?.();
      } catch {
        /* ignore */
      }
    }
  }
  selectVoxLabel(id: number) {
    const found = this.voxLabels.find((l) => l.id === id);
    if (found) this.voxSelectedLabelId = id;
  }
  getCurrentLabelValue(): number {
    if (this.voxEraseMode) return 0;
    // Avoid triggering default creation during initialization.
    if (!this.voxLabelsInitialized) return 0;
    // Ensure we have a valid selection if labels exist.
    if (!this.voxSelectedLabelId && this.voxLabels.length > 0) {
      this.voxSelectedLabelId = this.voxLabels[0].id;
    }
    const cur =
      this.voxLabels.find((l) => l.id === this.voxSelectedLabelId) ||
      this.voxLabels[0];
    return cur ? cur.id >>> 0 : 0;
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

  applyVoxSettings(
    scale: Float64Array,
    unit: string,
    cornerA: Float32Array,
    cornerB: Float32Array,
  ) {
    // Update and rebuild if values changed.
    let changed = false;
    // Update scale
    for (let i = 0; i < 3; ++i) {
      if (this.voxScale[i] !== scale[i]) {
        this.voxScale[i] = scale[i];
        changed = true;
      }
    }
    // Normalize corners to an axis-aligned [lower, upper) box
    const lower = new Float32Array(3);
    const upper = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      const lo = Math.floor(Math.min(cornerA[i], cornerB[i]));
      const up = Math.ceil(Math.max(cornerA[i], cornerB[i]));
      lower[i] = lo;
      upper[i] = Math.max(up, lo + 1); // enforce non-empty
    }
    // Update stored corners and derived upper bound
    for (let i = 0; i < 3; ++i) {
      if (this.voxCornerA[i] !== cornerA[i]) {
        this.voxCornerA[i] = cornerA[i];
        changed = true;
      }
      if (this.voxCornerB[i] !== cornerB[i]) {
        this.voxCornerB[i] = cornerB[i];
        changed = true;
      }
    }
    if (this.voxScaleUnit !== unit) {
      this.voxScaleUnit = unit;
      changed = true;
    }
    if (changed) this.buildOrRebuildVoxLayer();
  }

  private createIdentity3D() {
    const units = [
      this.voxScaleUnit,
      this.voxScaleUnit,
      this.voxScaleUnit,
    ] as string[];

    return new WatchableCoordinateSpaceTransform(
      makeIdentityTransform(
        makeCoordinateSpace({
          rank: 3,
          names: ["x", "y", "z"],
          units,
          scales: new Float64Array(this.voxScale),
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

    console.log("buildOrRebuildVoxLayer");
    // Require an explicit map selection/creation
    const map = VoxMapRegistry.getCurrent();
    if (!map) return;

    const guardScale = Array.from(this.voxScale);
    // Use map bounds for guard and source
    const upper = new Float32Array(map.upperVoxelBound as any);
    const guardBounds = Array.from(upper);
    const guardUnit = map.unit || this.voxScaleUnit;

    ls.activate(
      () => {
        console.log("buildOrRebuildVoxLayer: activate source", map.id);
        const voxSource = new VoxMultiscaleVolumeChunkSource(
          this.manager.chunkManager,
          {
            map: map as any,
          },
        );
        // Expose a controller so tools can paint voxels via the source.
        this.voxEditController = new VoxelEditController(voxSource);

        // Initialize worker-side map persistence for this source (best-effort, fire-and-forget).
        const sources2D = voxSource.getSources({} as any);
        const base = sources2D[0]?.[0];
        if (base) {
          const source = base.chunkSource as any;
          // Ensure we have a stable id on the map for persistence purposes.
          const mapId = map.id || this.voxMapId || "local";
          this.voxMapId = mapId;
          const mapForInit = {
            ...map,
            id: mapId,
            unit: guardUnit,
            serverUrl: map.serverUrl ?? this.voxServerUrl,
            token: map.token ?? this.voxServerToken,
            dataType: map.dataType ?? voxSource.dataType,
          } as any;
          // Initialize backend map first, then load labels from the chosen datasource.
          source.initializeMap(mapForInit);
          this.loadLabels();
        }

        // Build transform with current scale and units.
        const identity3D = this.createIdentity3D();
        const transform = getWatchableRenderLayerTransform(
          this.manager.root.coordinateSpace,
          this.localPosition.coordinateSpace,
          identity3D,
          undefined,
        );

        ls.addRenderLayer(
          new VoxelAnnotationRenderLayer(voxSource, {
            transform: transform as any,
            renderScaleTarget: this.sliceViewRenderScaleTarget,
            renderScaleHistogram: undefined,
            localPosition: this.localPosition,
          } as any),
        );
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
        this.voxMapId = "local";
        this.voxLoadedSubsource = loadedSubsource;
        this.buildOrRebuildVoxLayer();
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
            this.voxMapId = "remote";
            this.voxLoadedSubsource = loadedSubsource;
            this.buildOrRebuildVoxLayer();
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
