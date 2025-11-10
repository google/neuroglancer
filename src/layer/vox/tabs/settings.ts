/**
 * Vox Settings tab UI split from index.ts
 */
import type { VoxUserLayer } from "#src/layer/vox/index.js";
import { DataType } from "#src/util/data_type.js";
import { exportVoxToZarr, type ExportStatus } from "#src/voxel_annotation/export_to_zarr.js";
import { LocalVoxSourceWriter } from "#src/voxel_annotation/local_source.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";
import { computeSteps, constructVoxMapConfig } from "#src/voxel_annotation/map.js";
import { scaleByExp10, unitFromJson } from "#src/util/si_units.js";
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

    // Section containers
    const createSection = document.createElement("div");
    createSection.className = "neuroglancer-vox-section";
    const createHeader = document.createElement("h3");
    createHeader.textContent = "Create Map";
    createSection.appendChild(createHeader);
    element.appendChild(createSection);

    const importSection = document.createElement("div");
    importSection.className = "neuroglancer-vox-section";
    const importHeader = document.createElement("h3");
    importHeader.textContent = "Import Map";
    importSection.appendChild(importHeader);
    element.appendChild(importSection);

    const selectSection = document.createElement("div");
    selectSection.className = "neuroglancer-vox-section";
    const selectHeader = document.createElement("h3");
    selectHeader.textContent = "Select Map";
    selectSection.appendChild(selectHeader);
    element.appendChild(selectSection);

    // Import UI controls
    const importUrlInput = document.createElement("input");
    importUrlInput.type = "text";
    importUrlInput.placeholder = "Data URL (e.g., precomputed://..., zarr://..., n5://...)";
    importUrlInput.size = 80;

    const importIdInput = document.createElement("input");
    importIdInput.type = "text";
    importIdInput.placeholder = "map id (leave empty to derive from URL)";

    const importNameInput = document.createElement("input");
    importNameInput.type = "text";
    importNameInput.placeholder = "map name (optional)";

    const importButton = document.createElement("button");
    importButton.textContent = "Validate & Import";

    const importStatus = document.createElement("span");
    importStatus.classList.add("neuroglancer-vox-status");

    importSection.appendChild(row("Source URL", [importUrlInput]));
    importSection.appendChild(row("Map id/name", [importIdInput, importNameInput]));
    importSection.appendChild(importStatus);
    importSection.appendChild(importButton)

    importButton.addEventListener("click", async () => {
      const url = importUrlInput.value.trim();
      if (!url || url.length === 0) {
        importStatus.textContent = "Source URL is required";
        return;
      }
      importButton.disabled = true;
      importStatus.textContent = "Validating...";
      try {
        const registry = this.layer.manager.dataSourceProviderRegistry;
        const ds = await registry.get({
          url,
          transform: undefined,
          globalCoordinateSpace: this.layer.manager.root.coordinateSpace,
        } as any);
        const volumeEntry = ds.subsources.find(s => (s as any)?.subsource?.volume);
        if (!volumeEntry) throw new Error("No volume subsource found at URL");
        const volume = (volumeEntry as any).subsource.volume;
        const rank: number = volume.modelSpace.rank;
        if (!Number.isInteger(rank) || rank <= 0) {
          throw new Error(`Invalid volume rank: ${String(rank)}`);
        }

        const displayRank: number = Math.min(3, rank);
        const multiscaleToViewTransform = new Float32Array(displayRank * rank);
        for (let i = 0; i < Math.min(displayRank, rank); i++) {
          // Column-major layout, linear (not affine) matrix with displayRank rows and rank columns
          multiscaleToViewTransform[i + i * displayRank] = 1;
        }

        const volumeSourceOptions = {
          displayRank,
          multiscaleToViewTransform,
          modelChannelDimensionIndices: [],
        };

        const levels = volume.getSources(volumeSourceOptions);
        const level0 = levels?.[0]?.[0];
        if (!level0) throw new Error("Volume has no available resolution levels");
        const spec = (level0 as any).chunkSource?.spec;
        if (!spec) throw new Error("Cannot read volume specification");

        const baseVoxelOffset = new Float32Array(Array.from(spec.baseVoxelOffset));
        const upperVoxelBound = new Float32Array(Array.from(spec.upperVoxelBound));
        const chunkDataSize = new Uint32Array(Array.from(spec.chunkDataSize));
        const bounds = [
          (upperVoxelBound[0] | 0) - (baseVoxelOffset[0] | 0),
          (upperVoxelBound[1] | 0) - (baseVoxelOffset[1] | 0),
          (upperVoxelBound[2] | 0) - (baseVoxelOffset[2] | 0),
        ];
        const steps = computeSteps(bounds, chunkDataSize);
        const dtype = Number(volume.dataType ?? DataType.UINT32);

        // Derive id and name
        const derived = registry.suggestLayerName((ds as any).originalCanonicalUrl || (ds as any).canonicalUrl || url) || `map-${Date.now()}`;
        const id = (importIdInput.value.trim().length > 0 ? importIdInput.value.trim() : derived);
        const name = (importNameInput.value.trim().length > 0 ? importNameInput.value.trim() : id);
        console.log("Importing map:", { id, name, baseVoxelOffset, upperVoxelBound, chunkDataSize, dtype, steps });
        // Derive physical voxel size (in meters) and base unit from modelSpace
        const modelUnits: string[] = Array.from(volume.modelSpace?.units || []);
        const modelScales: number[] = Array.from(volume.modelSpace?.scales || []);
        if (modelUnits.length < 3 || modelScales.length < 3) {
          throw new Error(`Model space lacks required units/scales for 3 spatial axes`);
        }
        // Convert each axis scale to meters using SI prefix info
        const toMeters = (scale: number, unitStr: string): number => {
          const u = unitFromJson(unitStr);
          return scaleByExp10(scale, u.exponent);
        };
        const sx_m = toMeters(modelScales[0], modelUnits[0]);
        const sy_m = toMeters(modelScales[1], modelUnits[1]);
        const sz_m = toMeters(modelScales[2], modelUnits[2]);
        if (!(sx_m > 0 && sy_m > 0 && sz_m > 0)) {
          throw new Error(`Invalid spatial scales; expected positive finite values`);
        }
        // Ensure base unit is consistent across spatial axes; use base unit returned by unitFromJson
        const baseUnit0 = unitFromJson(modelUnits[0]).unit;
        const baseUnit1 = unitFromJson(modelUnits[1]).unit;
        const baseUnit2 = unitFromJson(modelUnits[2]).unit;
        if (!(baseUnit0 === baseUnit1 && baseUnit0 === baseUnit2)) {
          throw new Error(`Inconsistent units across spatial axes: [${modelUnits.slice(0,3).join(", ")}]`);
        }

        const map: VoxMapConfig = constructVoxMapConfig({
          id,
          name,
          baseVoxelOffset,
          upperVoxelBound,
          chunkDataSize,
          dataType: dtype,
          scaleMeters: new Float64Array([sx_m, sy_m, sz_m]),
          unit: baseUnit0 || "m",
          steps,
          importUrl: (ds as any).originalCanonicalUrl || (ds as any).canonicalUrl || url,
        });
        this.layer.voxMapRegistry.upsert(map);
        this.layer.voxMapRegistry.setCurrent(map);
        this.layer.buildOrRebuildVoxLayer();
        refreshMaps();
        importStatus.textContent = `Imported: ${id}`;
      } catch (e: any) {
        console.error("Import error:", e);
        importStatus.textContent = `Import failed: ${e?.message || String(e)}`;
      } finally {
        importButton.disabled = false;
      }
    });

    const exportSection = document.createElement("div");
    exportSection.className = "neuroglancer-vox-section";
    const exportHeader = document.createElement("h3");
    exportHeader.textContent = "Export Map";
    exportSection.appendChild(exportHeader);
    element.appendChild(exportSection);


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

    createSection.appendChild(row("Scale (x,y,z)", [sx, sy, sz]));
    createSection.appendChild(row("Scale unit", [unitSel]));
    createSection.appendChild(row("Corner A (x,y,z)", [ax, ay, az]));
    createSection.appendChild(row("Corner B (x,y,z)", [bx, by, bz]));

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
    createSection.appendChild(row("Map id/name", [mapIdInp, mapNameInp]));

    // Existing maps list
    const mapsSel = document.createElement("select");
    const refreshMaps = () => {
      mapsSel.innerHTML = "";
      const maps = this.layer.voxMapRegistry.list();
      for (const m of maps) {
        const opt = document.createElement("option");
        opt.style.color = m.id === this.layer.voxMapRegistry.getCurrent()?.id ? "blue" : "black";
        opt.value = m.id;
        opt.textContent = `${m.name || m.id}`;
        mapsSel.appendChild(opt);
      }
    };
    refreshMaps();
    selectSection.appendChild(row("Existing maps", [mapsSel]));

    // Load locally-stored maps from IndexedDB
    (async () => {
      try {
        const src = new LocalVoxSourceWriter();
        const maps = await src.listMaps();
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

      const map: VoxMapConfig = constructVoxMapConfig({
        id,
        name,
        baseVoxelOffset: lower,
        upperVoxelBound: upper,
        chunkDataSize,
        dataType: DataType.UINT32,
        scaleMeters: ns,
        unit: u,
        steps,
      });
      this.layer.voxMapRegistry.upsert(map);
      this.layer.voxMapRegistry.setCurrent(map);
      this.layer.buildOrRebuildVoxLayer();
      refreshMaps();
    });
    createSection.appendChild(createBtn);

    const selectBtn = document.createElement("button");
    selectBtn.textContent = "Select Map";
    selectBtn.addEventListener("click", () => {
      const id = mapsSel.value;
      const found = this.layer.voxMapRegistry.list().find((m: VoxMapConfig) => m.id === id);
      if (found) {
        console.log("Selected map:", found);
        this.layer.voxMapRegistry.setCurrent(found);
        this.layer.buildOrRebuildVoxLayer();
      }
    });
    selectSection.appendChild(selectBtn);

    // --- Export to Zarr (LOD 1 only) ---
    const exportUrlInput = document.createElement("input");
    exportUrlInput.type = "text";
    exportUrlInput.placeholder = "Export base URL";
    exportUrlInput.size = 80;
    exportUrlInput.classList.add("neuroglancer-vox-input");
    exportUrlInput.style.marginLeft = "0";
    const exportButton = document.createElement("button");
    exportButton.textContent = "Export to Zarr";
    exportButton.title = "Exports current map LOD=1 chunks to a Zarr v2 dataset at path '0' under the provided base URL";

    const exportStatusSpan = document.createElement("span");
    exportStatusSpan.classList.add("neuroglancer-vox-status");
    exportStatusSpan.classList.add("neuroglancer-vox-input");
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

    exportSection.appendChild(exportUrlInput);
    exportSection.appendChild(exportStatusSpan);
    exportSection.appendChild(exportButton);

  }
}
