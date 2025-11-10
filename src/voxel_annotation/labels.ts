import { SegmentColorHash } from "#src/segment_color.js";
import type { VoxelEditController } from "#src/voxel_annotation/edit_controller.js";

export class LabelsManager {
  onLabelsChanged?: () => void;
  // Label state for painting: only store ids; colors are hashed from id on the fly
  labels: { id: number }[] = [];
  selectedLabelId: number | undefined = undefined;
  labelsError: string | undefined = undefined;
  // Indicates whether an initial labels load attempt has completed.
  private labelsInitialized: boolean = false;
  segmentColorHash = SegmentColorHash.getDefault();

  async initialize(editController: VoxelEditController): Promise<void> {
    if (!editController) {
      throw new Error("LabelsManager.initialize: editController is required");
    }
    await this.loadLabels(editController);
  }

  // --- Label helpers ---
  private genId(): number {
    // Generate a unique uint32 per layer session. Try crypto.getRandomValues; fallback to Math.random.
    let id = 0;
    const used = new Set(this.labels.map((l) => l.id));
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
  private async loadLabels(editController: VoxelEditController) {
    try {
      const arr = await editController?.getLabelIds();
      if (arr && Array.isArray(arr)) {
        if (arr.length > 0) {
          this.labels = arr.map((id) => ({ id: id >>> 0 }));
          const sel = this.selectedLabelId;
          if (!sel || !this.labels.some((l) => l.id === sel)) {
            this.selectedLabelId = this.labels[0].id;
          }
        } else {
          this.labels = [];
          this.selectedLabelId = undefined;
        }
      } else {
        throw new Error("Invalid labels response");
      }
    } catch (e: any) {
      const msg = `Failed to load labels: ${e?.message || e}`;
      console.error(msg);
      this.labelsError = msg;
    } finally {
      // Mark labels as initialized; UI/painting should not trigger default creation before this point.
      this.labelsInitialized = true;
      try {
        this.onLabelsChanged?.();
      } catch {
        /* ignore */
      }
    }
  }

  async createVoxLabel(editController: VoxelEditController | undefined) {
    const id = this.genId(); // unique uint32
    if (!editController) {
      const msg = "Labels backend not ready; please try again after source initializes.";
      console.error(msg);
      this.labelsError = msg;
      return;
    }
    try {
      const updated = await editController.addLabel(id);
      this.labels = updated.map((x) => ({ id: x >>> 0 }));
      // Prefer to select the last label from the updated list (likely the one just added).
      const last = this.labels[this.labels.length - 1]?.id;
      this.selectedLabelId = last ?? id;
      this.labelsError = undefined;
      try {
        this.onLabelsChanged?.();
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      const msg = `Failed to create label: ${e?.message || e}`;
      console.error(msg);
      this.labelsError = msg;
      try {
        this.onLabelsChanged?.();
      } catch {
        /* ignore */
      }
    }
  }

  selectVoxLabel(id: number) {
    const found = this.labels.find((l) => l.id === id);
    if (found) this.selectedLabelId = id;
  }

  getCurrentLabelValue(eraseMode: boolean): number {
    if (eraseMode) return 0;
    // Avoid triggering default creation during initialization.
    if (!this.labelsInitialized) return 0;
    // Ensure we have a valid selection if labels exist.
    if (!this.selectedLabelId && this.labels.length > 0) {
      this.selectedLabelId = this.labels[0].id;
    }
    const cur =
      this.labels.find((l) => l.id === this.selectedLabelId) ||
      this.labels[0];
    return cur ? cur.id >>> 0 : 0;
  }
}
