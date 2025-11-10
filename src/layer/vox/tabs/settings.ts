/**
 * Vox Settings tab UI split from index.ts
 */
import type { VoxUserLayer } from "#src/layer/vox/index.js";
import { DataType } from "#src/util/data_type.js";
import { exportVoxToZarr, type ExportStatus } from "#src/voxel_annotation/export_to_zarr.js";
import { LocalVoxSourceWriter } from "#src/voxel_annotation/local_source.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import { computeSteps } from "#src/voxel_annotation/map.js";
import { RemoteVoxSource } from "#src/voxel_annotation/remote_source.js";
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
        // Do not force a tiny size; allow CSS/layout to determine width for readability.
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

    // Unit helpers
    const unitFactor: Record<string, number> = {
      m: 1,
      mm: 1e-3,
      µm: 1e-6,
      nm: 1e-9,
    };
    const currentUnit = "nm";
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
    const sx = makeNumberInput(8, "any");
    const sy = makeNumberInput(8, "any");
    const sz = makeNumberInput(8, "any");

    const ax = makeNumberInput(0, "1");
    const ay = makeNumberInput(0, "1");
    const az = makeNumberInput(0, "1");

    const bx = makeNumberInput(100_000, "1");
    const by = makeNumberInput(100_000, "1");
    const bz = makeNumberInput(100_000, "1");

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
    mapIdInp.value = "";
    const mapNameInp = document.createElement("input");
    mapNameInp.type = "text";
    mapNameInp.placeholder = "map name";
    mapNameInp.value = "";
    element.appendChild(row("Map id/name", [mapIdInp, mapNameInp]));

    // Existing maps list
    const mapsSel = document.createElement("select");
    const refreshMaps = () => {
      mapsSel.innerHTML = "";
      const maps = this.layer.voxMapRegistry.list();
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
          const src = new RemoteVoxSource(this.layer.voxServerUrl, this.layer.voxServerToken);
          maps = await src.listMaps();
        } else {
          const src = new LocalVoxSourceWriter();
          maps = await src.listMaps();
        }
        for (const m of maps) this.layer.voxMapRegistry.upsert(m as any);
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
        sxNum * f,
        syNum * f,
        szNum * f
      ]);
      const ca = new Float32Array([
        Math.floor(Number(ax.value)),
        Math.floor(Number(ay.value)),
        Math.floor(Number(az.value)),
      ]);
      const cb = new Float32Array([
        Math.floor(Number(bx.value)),
        Math.floor(Number(by.value)),
        Math.floor(Number(bz.value)),
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

      const id = mapIdInp.value || `map-${Date.now()}`;
      const name = mapNameInp.value || id;

      const map:VoxMapConfig = {
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
      this.layer.voxMapRegistry.upsert(map);
      this.layer.voxMapRegistry.setCurrent(map);
      this.layer.buildOrRebuildVoxLayer();
      refreshMaps();
    });
    element.appendChild(createBtn);

    const selectBtn = document.createElement("button");
    selectBtn.textContent = "Select Map";
    selectBtn.addEventListener("click", () => {
      const id = mapsSel.value;
      const found = this.layer.voxMapRegistry.list().find((m: VoxMapConfig) => m.id === id);
      if (found) {
        this.layer.voxMapRegistry.setCurrent(found);
        this.layer.buildOrRebuildVoxLayer();
      }
    });
    element.appendChild(selectBtn);

    // --- Export to Zarr (LOD 1 only) ---
    const exportUrlInput = document.createElement("input");
    exportUrlInput.type = "text";
    exportUrlInput.placeholder = "Export base URL";
    exportUrlInput.size = 80;
    exportUrlInput.classList.add("neuroglancer-vox-status");
    exportUrlInput.style.marginLeft = "0";
1
    const exportButton = document.createElement("button");
    exportButton.textContent = "Export to Zarr";
    exportButton.title = "Exports current map LOD=1 chunks to a Zarr v2 dataset at path '0' under the provided base URL";

    const exportStatusSpan = document.createElement("span");
    exportStatusSpan.classList.add("neuroglancer-vox-status");
    exportStatusSpan.style.marginLeft = "0";

    let exportPollTimer: number | undefined = undefined;

    const setExportStatus = (text: string) => {
      exportStatusSpan.textContent = text;
    };

    const stopPolling = () => {
      if (exportPollTimer !== undefined) {
        clearInterval(exportPollTimer);
        exportPollTimer = undefined;
      }
    };

    exportButton.addEventListener("click", () => {
      try {
        const map = this.layer.voxMapRegistry.getCurrent();
        if (!map) throw new Error("No active map selected");
        const url = exportUrlInput.value.trim();
        if (url.length === 0) throw new Error("Export URL is required");

        // Start export and polling
        const getProgress = exportVoxToZarr(url, map as VoxMapConfig);
        exportButton.disabled = true;
        setExportStatus("Starting export...");
        stopPolling();
        exportPollTimer = setInterval(() => {
          try {
            const status = getProgress() as ExportStatus;
            if (status.status === "loading") {
              const pct = Math.round((status.progress ?? 0) * 100);
              setExportStatus(`Export in progress: ${pct}%`);
            } else if (status.status === "done") {
              setExportStatus("Export completed");
              exportButton.disabled = false;
              stopPolling();
            } else if (status.status === "error") {
              setExportStatus(`Export failed: ${status.error}`);
              exportButton.disabled = false;
              stopPolling();
            } else {
              throw new Error("Unknown export status");
            }
          } catch (e: any) {
            setExportStatus(`Export status error: ${e?.message || String(e)}`);
            exportButton.disabled = false;
            stopPolling();
          }
        }, 500) as unknown as number;
      } catch (e: any) {
        setExportStatus(`Cannot start export: ${e?.message || String(e)}`);
        exportButton.disabled = false;
        stopPolling();
      }
    });

    element.appendChild(row("Export to Zarr", [exportUrlInput, exportButton, exportStatusSpan]));
  }
}
