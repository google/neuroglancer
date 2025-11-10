/**
 * Vox Settings tab UI split from index.ts
 */
import type { VoxUserLayer } from "#src/layer/vox/index.js";
import { VoxMapRegistry, computeSteps } from "#src/voxel_annotation/map.js";
import { DataType } from "#src/util/data_type.js";
import { Tab } from "#src/widget/tab_view.js";

export class VoxSettingsTab extends Tab {
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

    // Map metadata inputs
    const mapIdInp = document.createElement("input");
    mapIdInp.type = "text";
    mapIdInp.placeholder = "map id";
    mapIdInp.value = this.layer.voxMapId || "";
    const mapNameInp = document.createElement("input");
    mapNameInp.type = "text";
    mapNameInp.placeholder = "map name";
    mapNameInp.value = "";
    element.appendChild(row("Map id/name", [mapIdInp, mapNameInp]));

    // Existing maps list
    const mapsSel = document.createElement("select");
    const refreshMaps = () => {
      mapsSel.innerHTML = "";
      const maps = VoxMapRegistry.list();
      for (const m of maps) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name || m.id}`;
        mapsSel.appendChild(opt);
      }
    };
    refreshMaps();
    element.appendChild(row("Existing maps", [mapsSel]));

    // Attempt to fetch existing maps via VoxSource implementation (local or remote)
    (async () => {
      try {
        // Dynamically use the appropriate VoxSource
        let maps: any[] = [];
        if (this.layer.voxServerUrl) {
          const { RemoteVoxSource } = await import("#src/voxel_annotation/index.js");
          const src = new RemoteVoxSource(this.layer.voxServerUrl, this.layer.voxServerToken);
          maps = await src.listMaps();
        } else {
          const { LocalVoxSource } = await import("#src/voxel_annotation/index.js");
          const src = new LocalVoxSource();
          maps = await src.listMaps();
        }
        for (const m of maps) VoxMapRegistry.upsert(m as any);
        refreshMaps();
      } catch {
        // ignore
      }
    })();

    const createBtn = document.createElement("button");
    createBtn.textContent = "Create / Init Map";
    createBtn.title = "Create a map with the provided id, bounds, scale, and precomputed steps";
    createBtn.addEventListener("click", () => {
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

      // Normalize bounds
      const lower = new Float32Array(3);
      const upper = new Float32Array(3);
      for (let i = 0; i < 3; ++i) {
        const lo = Math.floor(Math.min(ca[i], cb[i]));
        const up = Math.ceil(Math.max(ca[i], cb[i]));
        lower[i] = lo;
        upper[i] = Math.max(up, lo + 1);
      }
      const bounds = [
        upper[0] - lower[0],
        upper[1] - lower[1],
        upper[2] - lower[2],
      ];
      const chunkDataSize = [64, 64, 64];
      const steps = computeSteps(bounds, chunkDataSize);

      const id = mapIdInp.value || this.layer.voxMapId || `map-${Date.now()}`;
      const name = mapNameInp.value || id;

      const map = {
        id,
        name,
        baseVoxelOffset: lower,
        upperVoxelBound: upper,
        chunkDataSize,
        dataType: DataType.UINT32,
        scaleMeters: ns,
        unit: u,
        steps,
        serverUrl: this.layer.voxServerUrl,
        token: this.layer.voxServerToken,
      };
      VoxMapRegistry.upsert(map as any);
      VoxMapRegistry.setCurrent(map as any);
      this.layer.applyVoxSettings(ns, u, ca, cb);
      refreshMaps();
    });
    element.appendChild(createBtn);

    const selectBtn = document.createElement("button");
    selectBtn.textContent = "Select Map";
    selectBtn.addEventListener("click", () => {
      const id = mapsSel.value;
      const found = VoxMapRegistry.list().find((m) => m.id === id);
      if (found) {
        VoxMapRegistry.setCurrent(found);
        this.layer.buildOrRebuildVoxLayer();
      }
    });
    element.appendChild(selectBtn);
  }
}
