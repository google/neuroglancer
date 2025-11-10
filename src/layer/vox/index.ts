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
  WatchableCoordinateSpaceTransform
} from "#src/coordinate_transform.js";
import type { DataSourceSpecification } from "#src/datasource/index.js";
import { LocalDataSource, localVoxelAnnotationsUrl } from "#src/datasource/local.js";
import {
  type ManagedUserLayer,
  type MouseSelectionState,
  registerLayerType,
  registerLayerTypeDetector,
  UserLayer
} from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { getWatchableRenderLayerTransform } from "#src/render_coordinate_transform.js";
import { RenderScaleHistogram, trackableRenderScaleTarget } from "#src/render_scale_statistics.js";
import { registerVoxelAnnotationTools, VoxelBrushLegacyTool, VoxelPixelLegacyTool } from "#src/ui/voxel_annotations.js";
import type { Borrowed } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";
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
    const b = this.layer.voxUpperBound;

    // Unit helpers
    const unitFactor: Record<string, number> = { m: 1, mm: 1e-3, "µm": 1e-6, nm: 1e-9 };
    const currentUnit = this.layer.voxScaleUnit in unitFactor ? this.layer.voxScaleUnit : "m";
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

    const bx = makeNumberInput(b[0], "1");
    const by = makeNumberInput(b[1], "1");
    const bz = makeNumberInput(b[2], "1");

    element.appendChild(row("Scale (x,y,z)", [sx, sy, sz]));
    element.appendChild(row("Scale unit", [unitSel]));
    element.appendChild(row("Upper bounds (x,y,z)", [bx, by, bz]));

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
    apply.textContent = "Apply";
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
      const nb = new Float32Array([
        Math.max(1, Math.floor(Number(bx.value) || this.layer.voxUpperBound[0])),
        Math.max(1, Math.floor(Number(by.value) || this.layer.voxUpperBound[1])),
        Math.max(1, Math.floor(Number(bz.value) || this.layer.voxUpperBound[2])),
      ]);
      this.layer.applyVoxSettings(ns, u, nb);
    });
    element.appendChild(apply);
  }
}

class VoxToolTab extends Tab {
  constructor(public layer: VoxUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-vox-tools-tab");
    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-vox-toolbox";

    const pixelButton = document.createElement("button");
    pixelButton.textContent = "Pixel";
    pixelButton.title = "ctrl+click to paint a pixel";
    pixelButton.addEventListener("click", () => {
      this.layer.tool.value = new VoxelPixelLegacyTool(this.layer);
    });
    toolbox.appendChild(pixelButton);

    const brushButton = document.createElement("button");
    brushButton.textContent = "Brush";
    brushButton.title = "ctrl+click to paint a small sphere";
    brushButton.addEventListener("click", () => {
      this.layer.tool.value = new VoxelBrushLegacyTool(this.layer);
    });
    toolbox.appendChild(brushButton);

    // Brush size control
    const sizeWrap = document.createElement("div");
    sizeWrap.style.display = "inline-flex";
    sizeWrap.style.alignItems = "center";
    sizeWrap.style.gap = "4px";
    const sizeLabel = document.createElement("label");
    sizeLabel.textContent = "Brush size";
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "1";
    sizeInput.step = "1";
    sizeInput.value = String(this.layer.voxBrushRadius ?? 3);
    sizeInput.addEventListener("change", () => {
      const v = Math.max(1, Math.floor(Number(sizeInput.value) || 1));
      this.layer.voxBrushRadius = v;
      sizeInput.value = String(v);
    });
    sizeWrap.appendChild(sizeLabel);
    sizeWrap.appendChild(sizeInput);
    toolbox.appendChild(sizeWrap);

    // Eraser toggle
    const erWrap = document.createElement("div");
    erWrap.style.display = "inline-flex";
    erWrap.style.alignItems = "center";
    erWrap.style.gap = "4px";
    const erLabel = document.createElement("label");
    erLabel.textContent = "Eraser";
    const erChk = document.createElement("input");
    erChk.type = "checkbox";
    erChk.checked = !!this.layer.voxEraseMode;
    erChk.addEventListener("change", () => {
      this.layer.voxEraseMode = !!erChk.checked;
    });
    erWrap.appendChild(erLabel);
    erWrap.appendChild(erChk);
    toolbox.appendChild(erWrap);

    // Brush shape selector
    const shapeWrap = document.createElement("div");
    shapeWrap.style.display = "inline-flex";
    shapeWrap.style.alignItems = "center";
    shapeWrap.style.gap = "4px";
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
    shapeSel.value = (this.layer.voxBrushShape === 'sphere') ? 'sphere' : 'disk';
    shapeSel.addEventListener("change", () => {
      const v = shapeSel.value === 'sphere' ? 'sphere' : 'disk';
      this.layer.voxBrushShape = v;
      shapeSel.value = v;
    });
    shapeWrap.appendChild(shapeLabel);
    shapeWrap.appendChild(shapeSel);
    toolbox.appendChild(shapeWrap);

    element.appendChild(toolbox);
  }
}


export class VoxUserLayer extends UserLayer {
  // Match Image/Segmentation layers: provide a per-layer cross-section render scale target/histogram.
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
  static type = "vox";
  static typeAbbreviation = "vox";
  voxEditController?: VoxelEditController;

  // Settings state
  voxScale: Float64Array = new Float64Array([
    0.00000008, 0.00000008, 0.00000008,
  ]);
  voxScaleUnit: string = "nm";
  voxUpperBound: Float32Array = new Float32Array([
    1_000_000, 1_000_000, 1_000_000,
  ]);
  // Draw tool state
  voxBrushRadius: number = 3;
  voxEraseMode: boolean = false;
  voxBrushShape: 'disk' | 'sphere' = 'disk';
  private voxLoadedSubsource?: LoadedDataSubsource;

  constructor(managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.tabs.add("vox", {
      label: "Voxel",
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
    upperBound: Float32Array,
  ) {
    // Update and rebuild if values changed.
    let changed = false;
    for (let i = 0; i < 3; ++i) {
      if (this.voxScale[i] !== scale[i]) {
        this.voxScale[i] = scale[i];
        changed = true;
      }
      if (this.voxUpperBound[i] !== upperBound[i]) {
        this.voxUpperBound[i] = upperBound[i];
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

  getVoxelPositionFromMouse(
    mouseState: MouseSelectionState,
  ): Float32Array | undefined {
    try {
      if (!mouseState?.active || !mouseState?.position) return undefined;

      // There might be a simpler way to retrieve global transform?
      const identity3D = this.createIdentity3D();
      const watchable = getWatchableRenderLayerTransform(
        this.manager.root.coordinateSpace,
        this.localPosition.coordinateSpace,
        identity3D,
        undefined,
      );
      const tOrError = watchable.value as any;
      if (tOrError?.error) return undefined;

      const p = mouseState.position;

      return vec3.transformMat4(
        vec3.create(),
        vec3.fromValues(p[0], p[1], p[2]),
        mat4.invert(mat4.create(), tOrError.modelToRenderLayerTransform) ||
          mat4.identity(mat4.create()),
      );
    } catch {
      return undefined;
    }
  }

  private buildOrRebuildVoxLayer() {
    const ls = this.voxLoadedSubsource;
    if (!ls) return;
    const guardScale = Array.from(this.voxScale);
    const guardBounds = Array.from(this.voxUpperBound);
    const guardUnit = this.voxScaleUnit;
    ls.activate(
      () => {
        const dummySource = new VoxMultiscaleVolumeChunkSource(
          this.manager.chunkManager,
          {
            chunkDataSize: new Uint32Array([64, 64, 64]),
            upperVoxelBound: this.voxUpperBound,
          },
        );
        // Expose a controller so tools can paint voxels via the source.
        this.voxEditController = new VoxelEditController(dummySource);

        // Build transform with current scale and units.
        const identity3D = this.createIdentity3D();
        const transform = getWatchableRenderLayerTransform(
          this.manager.root.coordinateSpace,
          this.localPosition.coordinateSpace,
          identity3D,
          undefined,
        );

        ls.addRenderLayer(
          new VoxelAnnotationRenderLayer(dummySource, {
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
