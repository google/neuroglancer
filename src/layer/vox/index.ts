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
import { getWatchableRenderLayerTransform } from "#src/render_coordinate_transform.js";
import {
  RenderScaleHistogram,
  trackableRenderScaleTarget,
} from "#src/render_scale_statistics.js";
import { SegmentColorHash } from "#src/segment_color.js";
import {
  registerVoxelAnnotationTools,
  VoxelBrushLegacyTool,
  VoxelPixelLegacyTool,
} from "#src/ui/voxel_annotations.js";
import type { Borrowed } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
import { toScaleKey } from "#src/voxel_annotation/index.js";
import { VoxelAnnotationRenderLayer } from "#src/voxel_annotation/renderlayer.js";
import { VoxMultiscaleVolumeChunkSource } from "#src/voxel_annotation/volume_chunk_source.js";
import { Tab } from "#src/widget/tab_view.js";

class VoxSettingsTab extends Tab {
  constructor(public layer: VoxUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-vox-settings-tab");

    const row = (label: string, inputs: HTMLElement[]) => {
      const div = document.createElement("div");
      div.className = "neuroglancer-vox-row";
      const lab = document.createElement("label");
      lab.textContent = label;
      lab.style.display = "inline-block";
      lab.style.width = "140px";
      div.appendChild(lab);
      for (const inp of inputs) {
        inp.classList.add("neuroglancer-vox-input");
        inp.setAttribute("size", "8");
        div.appendChild(inp);
      }
      return div;
    };

    const makeNumberInput = (value: number, step: string) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = step;
      inp.value = String(value);
      return inp;
    };

    const sMeters = this.layer.voxScale; // stored in meters
    const a = this.layer.voxCornerA;
    const c = this.layer.voxCornerB;

    // Unit helpers
    const unitFactor: Record<string, number> = {
      m: 1,
      mm: 1e-3,
      µm: 1e-6,
      nm: 1e-9,
    };
    const currentUnit =
      this.layer.voxScaleUnit in unitFactor ? this.layer.voxScaleUnit : "m";
    const factor = (u: string) => unitFactor[u] ?? 1;

    // Prepare UI elements
    const unitSel = document.createElement("select");
    for (const u of ["m", "mm", "µm", "nm"]) {
      const opt = document.createElement("option");
      opt.value = u;
      opt.textContent = u;
      if (u === currentUnit) opt.selected = true;
      unitSel.appendChild(opt);
    }
    let prevUnit = currentUnit;

    // Show scale values in the chosen unit for convenience
    const sx = makeNumberInput(sMeters[0] / factor(currentUnit), "any");
    const sy = makeNumberInput(sMeters[1] / factor(currentUnit), "any");
    const sz = makeNumberInput(sMeters[2] / factor(currentUnit), "any");

    const ax = makeNumberInput(a[0], "1");
    const ay = makeNumberInput(a[1], "1");
    const az = makeNumberInput(a[2], "1");

    const bx = makeNumberInput(c[0], "1");
    const by = makeNumberInput(c[1], "1");
    const bz = makeNumberInput(c[2], "1");

    element.appendChild(row("Scale (x,y,z)", [sx, sy, sz]));
    element.appendChild(row("Scale unit", [unitSel]));
    element.appendChild(row("Corner A (x,y,z)", [ax, ay, az]));
    element.appendChild(row("Corner B (x,y,z)", [bx, by, bz]));

    // When unit changes, rescale the displayed numbers to preserve physical value in meters
    unitSel.addEventListener("change", () => {
      const newU = unitSel.value;
      const conv = factor(prevUnit) / factor(newU);
      // Update the input values in-place
      const x = Number.parseFloat(sx.value);
      const y = Number.parseFloat(sy.value);
      const z = Number.parseFloat(sz.value);
      if (Number.isFinite(x)) sx.value = String(x * conv);
      if (Number.isFinite(y)) sy.value = String(y * conv);
      if (Number.isFinite(z)) sz.value = String(z * conv);
      prevUnit = newU;
    });

    const apply = document.createElement("button");
    apply.textContent = "Regen source";
    apply.title =
      "Regenerate the source volume with the new settings, warning old local source will be deleted";
    apply.addEventListener("click", () => {
      const u = unitSel.value || currentUnit;
      const f = factor(u);
      // Convert user-entered values back to meters
      const sxNum = Number.parseFloat(sx.value);
      const syNum = Number.parseFloat(sy.value);
      const szNum = Number.parseFloat(sz.value);
      const ns = new Float64Array([
        Number.isFinite(sxNum) ? sxNum * f : sMeters[0],
        Number.isFinite(syNum) ? syNum * f : sMeters[1],
        Number.isFinite(szNum) ? szNum * f : sMeters[2],
      ]);
      const ca = new Float32Array([
        Math.floor(Number(ax.value) || this.layer.voxCornerA[0]),
        Math.floor(Number(ay.value) || this.layer.voxCornerA[1]),
        Math.floor(Number(az.value) || this.layer.voxCornerA[2]),
      ]);
      const cb = new Float32Array([
        Math.floor(Number(bx.value) || this.layer.voxCornerB[0]),
        Math.floor(Number(by.value) || this.layer.voxCornerB[1]),
        Math.floor(Number(bz.value) || this.layer.voxCornerB[2]),
      ]);
      this.layer.applyVoxSettings(ns, u, ca, cb);
    });
    element.appendChild(apply);
  }
}

class VoxToolTab extends Tab {
  public requestRenderLabels() {
    this.renderLabels();
  }
  private labelsContainer!: HTMLDivElement;
  private renderLabels() {
    const cont = this.labelsContainer;
    cont.innerHTML = "";
    const labels = this.layer.voxLabels;
    const selected = this.layer.voxSelectedLabelId;
    for (const lab of labels) {
      const row = document.createElement("div");
      row.className = "neuroglancer-vox-label-row";
      row.style.display = "grid";
      row.style.gridTemplateColumns = "16px 1fr";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      // color swatch
      const sw = document.createElement("div");
      sw.style.width = "16px";
      sw.style.height = "16px";
      sw.style.borderRadius = "3px";
      sw.style.border = "1px solid rgba(0,0,0,0.2)";
      sw.style.background = this.layer.colorForValue(lab.id);
      // id text (monospace)
      const txt = document.createElement("div");
      txt.textContent = String(lab.id >>> 0);
      txt.style.fontFamily = "monospace";
      txt.style.whiteSpace = "nowrap";
      txt.style.overflow = "hidden";
      txt.style.textOverflow = "ellipsis";
      row.appendChild(sw);
      row.appendChild(txt);
      // selection styling
      const isSel = lab.id === selected;
      row.style.cursor = "pointer";
      row.style.padding = "2px 4px";
      row.style.borderRadius = "4px";
      if (isSel) {
        row.style.background = "rgba(100,150,255,0.15)";
        row.style.outline = "1px solid rgba(100,150,255,0.6)";
      }
      row.addEventListener("click", () => {
        this.layer.selectVoxLabel(lab.id);
        this.renderLabels();
      });
      cont.appendChild(row);
    }
  }
  constructor(public layer: VoxUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-vox-tools-tab");
    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-vox-toolbox";

    // Section: Tool selection
    const toolsRow = document.createElement("div");
    toolsRow.className = "neuroglancer-vox-row";
    const toolsLabel = document.createElement("label");
    toolsLabel.textContent = "Tool";
    const toolsWrap = document.createElement("div");
    toolsWrap.style.display = "flex";
    toolsWrap.style.gap = "8px";

    const pixelButton = document.createElement("button");
    pixelButton.textContent = "Pixel";
    pixelButton.title = "ctrl+click to paint a pixel";
    pixelButton.addEventListener("click", () => {
      this.layer.tool.value = new VoxelPixelLegacyTool(this.layer);
    });

    const brushButton = document.createElement("button");
    brushButton.textContent = "Brush";
    brushButton.title = "ctrl+click to paint a small sphere";
    brushButton.addEventListener("click", () => {
      this.layer.tool.value = new VoxelBrushLegacyTool(this.layer);
    });

    toolsWrap.appendChild(pixelButton);
    toolsWrap.appendChild(brushButton);
    toolsRow.appendChild(toolsLabel);
    toolsRow.appendChild(toolsWrap);
    toolbox.appendChild(toolsRow);

    // Section: Brush settings
    const brushRow = document.createElement("div");
    brushRow.className = "neuroglancer-vox-row";

    // Brush size as slider + number readout
    const sizeLabel = document.createElement("label");
    sizeLabel.textContent = "Brush size";
    const sizeControls = document.createElement("div");
    sizeControls.style.display = "flex";
    sizeControls.style.alignItems = "center";
    sizeControls.style.gap = "8px";

    const sizeSlider = document.createElement("input");
    sizeSlider.type = "range";
    sizeSlider.min = "1";
    sizeSlider.max = "64";
    sizeSlider.step = "1";
    sizeSlider.value = String(this.layer.voxBrushRadius ?? 3);

    const sizeNumber = document.createElement("input");
    sizeNumber.type = "number";
    sizeNumber.className = "neuroglancer-vox-input";
    sizeNumber.min = "1";
    sizeNumber.step = "1";
    sizeNumber.value = String(this.layer.voxBrushRadius ?? 3);

    const syncSize = (v: number) => {
      const clamped = Math.max(1, Math.min(256, Math.floor(v)));
      this.layer.voxBrushRadius = clamped;
      sizeSlider.value = String(clamped);
      sizeNumber.value = String(clamped);
    };

    sizeSlider.addEventListener("input", () => {
      syncSize(Number(sizeSlider.value) || 1);
    });
    sizeNumber.addEventListener("change", () => {
      syncSize(Number(sizeNumber.value) || 1);
    });

    sizeControls.appendChild(sizeSlider);
    sizeControls.appendChild(sizeNumber);

    // Eraser toggle
    const erLabel = document.createElement("label");
    erLabel.textContent = "Eraser";
    const erChk = document.createElement("input");
    erChk.type = "checkbox";
    erChk.checked = !!this.layer.voxEraseMode;
    erChk.addEventListener("change", () => {
      this.layer.voxEraseMode = !!erChk.checked;
    });

    // Brush shape selector
    const shapeLabel = document.createElement("label");
    shapeLabel.textContent = "Brush shape";
    const shapeSel = document.createElement("select");
    const optDisk = document.createElement("option");
    optDisk.value = "disk";
    optDisk.textContent = "disk";
    const optSphere = document.createElement("option");
    optSphere.value = "sphere";
    optSphere.textContent = "sphere";
    shapeSel.appendChild(optDisk);
    shapeSel.appendChild(optSphere);
    shapeSel.value = this.layer.voxBrushShape === "sphere" ? "sphere" : "disk";
    shapeSel.addEventListener("change", () => {
      const v = shapeSel.value === "sphere" ? "sphere" : "disk";
      this.layer.voxBrushShape = v;
      shapeSel.value = v;
    });

    // Layout within the brushRow: size controls, shape, eraser
    const group = document.createElement("div");
    group.style.display = "grid";
    group.style.gridTemplateColumns = "minmax(120px,auto) 1fr";
    group.style.columnGap = "8px";
    group.style.rowGap = "8px";

    // Row 1: Brush size
    const sizeLabelCell = document.createElement("div");
    sizeLabelCell.appendChild(sizeLabel);
    const sizeControlsCell = document.createElement("div");
    sizeControlsCell.appendChild(sizeControls);

    // Row 2: Brush shape
    const shapeLabelCell = document.createElement("div");
    shapeLabelCell.appendChild(shapeLabel);
    const shapeControlCell = document.createElement("div");
    shapeControlCell.appendChild(shapeSel);

    // Row 3: Eraser
    const erLabelCell = document.createElement("div");
    erLabelCell.appendChild(erLabel);
    const erControlCell = document.createElement("div");
    erControlCell.appendChild(erChk);

    group.appendChild(sizeLabelCell);
    group.appendChild(sizeControlsCell);
    group.appendChild(shapeLabelCell);
    group.appendChild(shapeControlCell);
    group.appendChild(erLabelCell);
    group.appendChild(erControlCell);

    brushRow.appendChild(group);
    toolbox.appendChild(brushRow);

    // Section: Labels (moved to end, title on top for full width)
    const labelsSection = document.createElement("div");
    labelsSection.style.display = "flex";
    labelsSection.style.flexDirection = "column";
    labelsSection.style.gap = "6px";
    labelsSection.style.marginTop = "8px";

    const labelsTitle = document.createElement("div");
    labelsTitle.textContent = "Labels";
    labelsTitle.style.fontWeight = "600";

    const buttonsRow = document.createElement("div");
    buttonsRow.style.display = "flex";
    buttonsRow.style.gap = "8px";

    const createBtn = document.createElement("button");
    createBtn.textContent = "New label";
    createBtn.addEventListener("click", () => {
      this.layer.createVoxLabel();
      // Rendering will be triggered by layer via onLabelsChanged callback.
    });
    buttonsRow.appendChild(createBtn);

    this.labelsContainer = document.createElement("div");
    this.labelsContainer.className = "neuroglancer-vox-labels";
    this.labelsContainer.style.display = "flex";
    this.labelsContainer.style.flexDirection = "column";
    this.labelsContainer.style.gap = "4px";
    this.labelsContainer.style.maxHeight = "180px";
    this.labelsContainer.style.overflowY = "auto";

    labelsSection.appendChild(labelsTitle);
    labelsSection.appendChild(buttonsRow);
    labelsSection.appendChild(this.labelsContainer);

    toolbox.appendChild(labelsSection);

    this.layer.onLabelsChanged = () => this.requestRenderLabels();
    this.renderLabels();

    element.appendChild(toolbox);
  }
}

export class VoxUserLayer extends UserLayer {
  onLabelsChanged?: () => void;
  private voxMapId: string | undefined;
  // Label state for painting: only store ids; colors are hashed from id on the fly
  voxLabels: { id: number }[] = [];
  voxSelectedLabelId: number | undefined = undefined;
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
  private async saveLabels() {
    try {
      const ids = this.voxLabels.map((l) => l.id >>> 0);
      await this.voxEditController?.setLabelIds(ids);
    } catch {
      // ignore persistence failures
    }
  }
  private async loadLabels() {
    try {
      const arr = await this.voxEditController?.getLabelIds();
      const existing = new Set(this.voxLabels.map((l) => l.id >>> 0));
      if (arr && Array.isArray(arr) && arr.length > 0) {
        // Merge previously created labels (before init) with stored ones.
        const mergedIds = new Set<number>(arr.map((id) => id >>> 0));
        for (const id of existing) mergedIds.add(id);
        this.voxLabels = Array.from(mergedIds).map((id) => ({ id }));
        // Ensure selected label is valid
        const sel = this.voxSelectedLabelId;
        if (!sel || !this.voxLabels.some((l) => l.id === sel)) {
          this.voxSelectedLabelId = this.voxLabels[0].id;
        }
        // Write back merged set to keep in sync.
        await this.saveLabels();
      } else {
        // Nothing stored: if any labels were created pre-init, persist them; otherwise, create one.
        if (this.voxLabels.length === 0) this.ensureDefaultLabel();
        await this.saveLabels();
      }
    } catch {
      // Fallback to default if load fails
      if (this.voxLabels.length === 0) this.ensureDefaultLabel();
    } finally {
      // Ensure UI reflects the loaded/merged labels.
      try {
        this.onLabelsChanged?.();
      } catch {
        /* ignore */
      }
    }
  }

  ensureDefaultLabel() {
    if (this.voxLabels.length > 0) return;
    this.createVoxLabel();
  }
  async createVoxLabel() {
    const id = this.genId(); // unique uint32
    this.voxLabels.push({ id });
    this.voxSelectedLabelId = id;
    // Persist immediately once the source/controller is available.
    if (this.voxEditController) {
      try {
        await this.saveLabels();
      } catch {
        /* ignore */
      }
    }
    // Notify UI to re-render labels list whenever a label is created.
    try {
      this.onLabelsChanged?.();
    } catch {
      /* ignore */
    }
  }
  selectVoxLabel(id: number) {
    const found = this.voxLabels.find((l) => l.id === id);
    if (found) this.voxSelectedLabelId = id;
  }
  getCurrentLabelValue(): number {
    if (this.voxEraseMode) return 0;
    if (!this.voxSelectedLabelId) this.ensureDefaultLabel();
    const cur =
      this.voxLabels.find((l) => l.id === this.voxSelectedLabelId) ||
      this.voxLabels[0];
    return cur ? cur.id >>> 0 : 0;
  }

  constructor(managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    // Do not create/save default label yet; wait for map init and load.
    this.tabs.add("vox_settings", {
      label: "Settings",
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

  private buildOrRebuildVoxLayer() {
    const ls = this.voxLoadedSubsource;
    if (!ls) return;
    const guardScale = Array.from(this.voxScale);
    // Derive region from corners for guard and source
    const lower = new Float32Array(3);
    const upper = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      const lo = Math.floor(Math.min(this.voxCornerA[i], this.voxCornerB[i]));
      const up = Math.ceil(Math.max(this.voxCornerA[i], this.voxCornerB[i]));
      lower[i] = lo;
      upper[i] = Math.max(up, lo + 1);
    }
    const guardBounds = Array.from(upper);
    const guardUnit = this.voxScaleUnit;
    ls.activate(
      () => {
        const voxSource = new VoxMultiscaleVolumeChunkSource(
          this.manager.chunkManager,
          {
            chunkDataSize: new Uint32Array([64, 64, 64]),
            baseVoxelOffset: lower,
            upperVoxelBound: upper,
          },
        );
        // Expose a controller so tools can paint voxels via the source.
        this.voxEditController = new VoxelEditController(voxSource);

        // Initialize worker-side map persistence for this source (best-effort, fire-and-forget).
        const sources2D = voxSource.getSources({} as any);
        const base = sources2D[0][0];
        const source = base.chunkSource as any;
        // Compute deterministic identifiers on the frontend to avoid relying on an RPC return value.
        const cfgCds = new Uint32Array(
          Array.from((voxSource as any)["cfgChunkDataSize"] ?? [64, 64, 64]),
        );
        const lowerArr: Float32Array = lower;
        const upperArr: Float32Array = upper;
        const scaleKey = toScaleKey(cfgCds, lowerArr, upperArr);
        // mapId can be any stable string; default to 'local' unless already set.
        if (!this.voxMapId) this.voxMapId = "local";
        // Initialize backend map first, then load labels from the chosen datasource.
        source.initializeMap({
          mapId: this.voxMapId,
          dataType: voxSource.dataType,
          chunkDataSize: cfgCds,
          baseVoxelOffset: lowerArr,
          upperVoxelBound: upperArr,
          unit: this.voxScaleUnit,
          scaleKey,
        });
        this.loadLabels();

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
      if (subsource.local === LocalDataSource.voxelAnnotations) {
        // Accept this data source; remember it and build the layer from current settings.
        this.voxLoadedSubsource = loadedSubsource;
        this.buildOrRebuildVoxLayer();
        continue;
      }
      loadedSubsource.deactivate(
        "Not compatible with vox layer; only local://voxel-annotations is supported",
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
  return undefined;
});
