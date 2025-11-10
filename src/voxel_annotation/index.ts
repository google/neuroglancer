/**
 * Local/Remote voxel annotation data sources and a shared base.
 * The LocalVoxSource persists per-chunk arrays into IndexedDB with a debounced saver.
 */

import type { VoxelEditController } from "#src/voxel_annotation/edit_backend.js";
import type { VoxMapConfig } from "#src/voxel_annotation/map.js";


export interface SavedChunk {
  data: Uint32Array | BigUint64Array; // Supports UINT32 and UINT64
  size: Uint32Array; // canonical size used for linearization (usually spec.chunkDataSize)
}

export function compositeChunkDbKey(
  mapId: string,
  chunkKey: string,
): string {
  return `${mapId}:${chunkKey}`;
}

export function compositeLabelsDbKey(mapId: string): string {
  return `${mapId}:labels`;
}

export abstract class VoxSource {
  protected mapId: string = "default";
  protected mapCfg: VoxMapConfig; // Keep the entire configuration in one place

  init(map: VoxMapConfig): Promise<{ mapId: string}> {
    if(!map)
    {
      throw new Error("VoxSource: init: Map config is required");
    }
    this.mapCfg = map;
    this.mapId = map.id;
    return Promise.resolve({ mapId: this.mapId });
  }

  // Abstract persistence API the backend expects
  abstract getSavedChunk(key: string): Promise<SavedChunk | undefined>;
}


export abstract class VoxSourceWriter extends VoxSource {
  /**
   * Optional listing of available maps for the current source.
   * Remote sources should query their endpoint; local may enumerate local IndexedDB entries.
   */
  async listMaps(_args?: { baseUrl?: string; token?: string }): Promise<any[]> {
    return [];
  }

  // In-memory cache of loaded chunks
  protected maxSavedChunks = 256; // cap to prevent unbounded growth
  protected saved = new Map<string, SavedChunk>();

  // Dirty tracking and debounced save
  protected dirty = new Set<string>();
  protected saveTimer: number | undefined;
  editController?: VoxelEditController;
 
  constructor(editController?: VoxelEditController) {
    super();
    this.editController = editController;
  }

  /**
   * Generic label persistence hooks. Subclasses override to connect to the chosen datasource.
   * Default implementation is a no-op empty list.
   */
  async getLabelIds(): Promise<number[]> {
    return [];
  }
  async addLabel(_value: number): Promise<number[]> {
    // Default: pretend success with no labels
    return [];
  }

  callChunkReload(voxChunkKey: string) {
    if (!this.editController) {
      throw new Error("VoxSourceWriter.callChunkReload: editController not set");
    }
    this.editController.callChunkReload([voxChunkKey]);
  }

  // Common helpers
  protected markDirty(key: string) {
    this.dirty.add(key);
    this.scheduleSave();
  }

  protected scheduleSave() {
    if (this.saveTimer !== undefined) return;
    // Debounce writes ~750ms
    this.saveTimer = setTimeout(
      () => this.flushSaves(),
      750,
    ) as unknown as number;
  }

  // Overridden by subclass to actually persist dirty chunks.
  protected async flushSaves(): Promise<void> {}

  // Abstract persistence API the backend expects
  abstract ensureChunk(
    key: string,
    size?: Uint32Array | number[],
  ): Promise<SavedChunk>;
  abstract applyEdits(
    edits: {
      key: string;
      indices: ArrayLike<number>;
      value?: number;
      values?: ArrayLike<number>;
      size?: number[];
    }[],
  ): Promise<void>;

  // Apply edits into an in-memory chunk array; returns the SavedChunk.
  protected applyEditsIntoChunk(
    sc: SavedChunk,
    indices: ArrayLike<number>,
    value?: number,
    values?: ArrayLike<number>,
  ) {
    const dst = sc.data as any;
    const is64 = dst instanceof BigUint64Array;
    if (values != null) {
      const vv = values as ArrayLike<number>;
      const n = Math.min((indices as any).length ?? 0, (vv as any).length ?? 0);
      for (let i = 0; i < n; ++i) {
        const idx = (indices as any)[i] | 0;
        if (idx >= 0 && idx < dst.length) {
          const v = (vv as any)[i] >>> 0;
          dst[idx] = is64 ? BigInt(v) : v;
        }
      }
    } else if (value != null) {
      const vNum = value >>> 0;
      const v = (is64 ? BigInt(vNum) : vNum) as any;
      const n = (indices as any).length ?? 0;
      for (let i = 0; i < n; ++i) {
        const idx = (indices as any)[i] | 0;
        if (idx >= 0 && idx < dst.length) dst[idx] = v;
      }
    }
    return sc;
  }
}
