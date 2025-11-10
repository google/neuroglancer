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

import type { MouseSelectionState } from "#src/layer/index.js";
import type { VoxUserLayer } from "#src/layer/vox/index.js";
import { StatusMessage } from "#src/status.js";
import { LegacyTool, registerLegacyTool } from "#src/ui/tool.js";

export const BRUSH_TOOL_ID = "voxBrush";
export const FLOODFILL_TOOL_ID = "voxFloodFill";
export const ADOPT_VOXEL_LABEL_TOOL_ID = "adoptVoxelLabel";
 
 abstract class BaseVoxelLegacyTool extends LegacyTool<VoxUserLayer> {
  protected isDrawing = false;
  protected lastPoint: Int32Array | undefined;
  protected mouseDisposer: (() => void) | undefined;
  protected onMouseUp = () => this.stopDrawing();
  protected currentMouseState: MouseSelectionState | undefined;
  // Store the latest mouse state without processing it immediately.
  private latestMouseState: MouseSelectionState | null = null;
  private animationFrameHandle: number | null = null;

  // The main drawing loop synchronized to display refresh
  private drawLoop = (): void => {
    if (!this.isDrawing) {
      this.animationFrameHandle = null;
      return;
    }
    if (this.latestMouseState === null) {
      this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
      return;
    }

    const layer = this.layer as unknown as VoxUserLayer;
    const value = layer.voxLabelsManager.getCurrentLabelValue(layer.voxEraseMode);
    const cur = this.getPoint(this.latestMouseState);
    this.latestMouseState = null; // mark processed

    if (cur) {
      const last = this.lastPoint;
      if (last && (cur[0] !== last[0] || cur[1] !== last[1] || cur[2] !== last[2])) {
        const points = this.linePoints(last, cur);
        if (points.length > 0) {
          this.paintPoints(points, value);
        }
      }
      this.lastPoint = cur;
    }

    this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
  };

  protected getPoint(mouseState: MouseSelectionState): Int32Array | undefined {
    const vox = (this.layer as any).getVoxelPositionFromMouse?.(mouseState) as
      | Float32Array
      | undefined;
    if (!mouseState?.active || !vox) return undefined;
    return new Int32Array([
      Math.floor(vox[0]),
      Math.floor(vox[1]),
      Math.floor(vox[2]),
    ]);
  }

  protected linePoints(a: Int32Array, b: Int32Array): Float32Array[] {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    const out: Float32Array[] = [];
    if (steps <= 0) return out;
    let lastX = a[0],
      lastY = a[1],
      lastZ = a[2];
    for (let s = 1; s <= steps; ++s) {
      const x = Math.round(a[0] + (dx * s) / steps);
      const y = Math.round(a[1] + (dy * s) / steps);
      const z = Math.round(a[2] + (dz * s) / steps);
      if (x !== lastX || y !== lastY || z !== lastZ) {
        out.push(new Float32Array([x, y, z]));
        lastX = x;
        lastY = y;
        lastZ = z;
      }
    }
    return out;
  }

  protected abstract paintPoint(point: Float32Array, value: bigint): void;
  protected abstract paintPoints(points: Float32Array[], value: bigint): void;

  protected startDrawing(mouseState: MouseSelectionState) {
    if (this.isDrawing) return;
    this.isDrawing = true;
    this.currentMouseState = mouseState;

    const layer = this.layer as unknown as VoxUserLayer;
    const brushRadius = Math.max(1, Math.floor((layer as any).voxBrushRadius ?? 3));
    if (!Number.isFinite(brushRadius) || brushRadius <= 0) {
      throw new Error("startDrawing: invalid brushRadius");
    }

    // Compute starting point and lock render LOD before first paint.
    const start = this.getPoint(mouseState);
    if (!start) {
      throw new Error("startDrawing: could not compute a starting voxel position from mouse");
    }

    const centerCanonical = new Float32Array([start[0], start[1], start[2]]);
    const editLodIndex = layer.voxEditController?.getEditLodIndexToDraw(brushRadius);
    if (!Number.isInteger(editLodIndex) || editLodIndex == undefined || editLodIndex < 0) {
      throw new Error("startDrawing: computed edit LOD index is invalid");
    }
    layer.beginRenderLodLock(editLodIndex);

    const value = layer.voxLabelsManager.getCurrentLabelValue(layer.voxEraseMode);

    this.paintPoint(centerCanonical, value);
    this.lastPoint = start;
    // Initialize latest mouse state so RAF can process immediately
    this.latestMouseState = mouseState;

    // On mouse move, just update the latest position.
    this.mouseDisposer = mouseState.changed.add(() => {
      this.latestMouseState = mouseState;
      this.currentMouseState = mouseState;
    });

    // On mouse up, stop drawing and cleanup.
    const mouseUpHandler = () => {
      this.stopDrawing();
      window.removeEventListener("mouseup", mouseUpHandler);
      if (this.mouseDisposer) { this.mouseDisposer(); this.mouseDisposer = undefined; }
    };
    window.addEventListener("mouseup", mouseUpHandler);

    // Start the animation loop if not running
    if (this.animationFrameHandle === null) {
      this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
    }
  }

  protected stopDrawing() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.lastPoint = undefined;

    if (this.animationFrameHandle !== null) {
      cancelAnimationFrame(this.animationFrameHandle);
      this.animationFrameHandle = null;
    }

    if (this.mouseDisposer) {
      this.mouseDisposer();
      this.mouseDisposer = undefined;
    }

    // Always release any active render LOD lock.
    try {
      this.layer.endRenderLodLock();
    } catch (e) {
      console.warn("stopDrawing: failed to end render LOD lock:", e);
    }
  }

  trigger(mouseState: MouseSelectionState) {
    if ((this.layer as any)?.constructor?.type !== "vox") return;
    try {
      this.startDrawing(mouseState);
    } catch (e) {
      console.error(`[${this.constructor.name}] Error:`, e);
      this.stopDrawing();
    }
  }

  deactivate() {
    this.stopDrawing();
  }
}

export class VoxelBrushLegacyTool extends BaseVoxelLegacyTool {
  description = "brush";

  toJSON() {
    return BRUSH_TOOL_ID;
  }

  protected paintPoint(point: Float32Array, value: bigint) {
    const radius = Math.max(
      1,
      Math.floor((this.layer as any).voxBrushRadius ?? 3),
    );
    const shape =
      (this.layer as any).voxBrushShape === "sphere" ? "sphere" : "disk";
    const basis =
      shape === "disk"
        ? (this.layer as any).getBrushPlaneBasis?.(this.currentMouseState)
        : undefined;
    (this.layer as any).voxEditController?.paintBrushWithShape(
      point,
      radius,
      value,
      shape,
      basis,
    );
  }

  protected paintPoints(points: Float32Array[], value: bigint) {
    const radius = Math.max(
      1,
      Math.floor((this.layer as any).voxBrushRadius ?? 3),
    );
    const shape =
      (this.layer as any).voxBrushShape === "sphere" ? "sphere" : "disk";
    const ctrl = (this.layer as any).voxEditController;
    const basis =
      shape === "disk"
        ? (this.layer as any).getBrushPlaneBasis?.(this.currentMouseState)
        : undefined;
    for (const point of points) {
      ctrl?.paintBrushWithShape(point, radius, value, shape, basis);
    }
  }
}

export class VoxelFloodFillLegacyTool extends LegacyTool<VoxUserLayer> {
  description = "flood fill";

  toJSON() {
    return FLOODFILL_TOOL_ID;
  }

  trigger(mouseState: MouseSelectionState) {
    const layer = this.layer as unknown as VoxUserLayer;
    try {
      // Clear any previous draw error message
      layer.setDrawErrorMessage(undefined);

      if (!mouseState?.active) {
        console.info("[VoxFloodFill] trigger ignored: mouse inactive");
        return;
      }

      const pos = layer.getVoxelPositionFromMouse?.(mouseState) as Float32Array | undefined;
      if (!pos || pos.length < 3) {
        throw new Error("Flood fill: failed to get voxel position from mouse");
      }

      const value = layer.voxLabelsManager.getCurrentLabelValue(layer.voxEraseMode);
      const max = Number((layer as any).voxFloodMaxVoxels);
      if (!Number.isFinite(max) || max <= 0) {
        throw new Error("Flood fill: invalid max voxels; set it in the tool panel");
      }
      const ctrl = layer.voxEditController;
      if (!ctrl) throw new Error("Flood fill: drawing backend not ready yet");

      const seed = new Float32Array([
        Math.floor(pos[0]!),
        Math.floor(pos[1]!),
        Math.floor(pos[2]!),
      ]);

      console.info("[VoxFloodFill] starting flood fill", { seed: Array.from(seed), value: value, max: Math.floor(max) });
      ctrl.floodFillPlane2D(seed, value, Math.floor(max)).then(({ edits, filledCount }) => {
        console.info("[VoxFloodFill] BFS completed", { filledCount, editsByChunk: edits.length });

        if (edits.length === 0) return;
        if (typeof ctrl.commitEdits === "function") {
          ctrl.commitEdits(edits);
          console.info("[VoxFloodFill] committed edits");
        } else if ((ctrl as any).rpc && (ctrl as any).rpc.invoke) {
          (ctrl as any).rpc.invoke("VOX_EDIT_COMMIT_VOXELS", { rpcId: (ctrl as any).rpcId, edits });
          console.info("[VoxFloodFill] committed edits via fallback path");
        } else {
          throw new Error("Flood fill: no way to commit edits");
        }
      });
    } catch (e: any) {
      const msg = typeof e?.message === "string" ? e.message : String(e);
      try {
        layer.setDrawErrorMessage(msg);
      } catch {
        /* ignore */
      }
    }
  }
}

export class AdoptVoxelLabelTool extends LegacyTool<VoxUserLayer> {
  description = "label picker";
  toJSON() { return ADOPT_VOXEL_LABEL_TOOL_ID; }
  trigger(mouseState: MouseSelectionState) {
    if (!mouseState?.active) return;
    const layer = this.layer as VoxUserLayer;
    const pos = layer.getVoxelPositionFromMouse?.(mouseState);

    if (!pos || pos.length < 3) {
      StatusMessage.showTemporaryMessage(
        "Cannot pick label: position is not valid.",
        3000,
      );
      return;
    }

    const editController = layer.voxEditController;
    if (!editController) {
      StatusMessage.showTemporaryMessage(
        "Cannot pick label: layer is not ready.",
        3000,
      );
      return;
    }

    const source = editController.getSourceForLOD(
      0,
    );
    const channelAccess = editController.singleChannelAccess;


    StatusMessage.forPromise(
      source.getEnsuredValueAt(pos, channelAccess).then((value: bigint | number | null) => {
        if (value === null) {
          throw new Error("Voxel data not available at the selected position.");
        }
        const label = BigInt(value);
        if (label === 0n) {
          StatusMessage.showTemporaryMessage(
            "Cannot adopt background label (0).",
            3000,
          );
          return;
        }
        layer.voxLabelsManager.addLabel(label);
        StatusMessage.showTemporaryMessage(`Adopted label: ${label}`, 3000);
      }),
      {
        initialMessage: "Picking voxel label...",
        delay: true,
        errorPrefix: "Error picking label: ",
      },
    );
  }
}

export function registerVoxelAnnotationTools() {
  registerLegacyTool(
    BRUSH_TOOL_ID,
    (layer) => new VoxelBrushLegacyTool(layer as unknown as VoxUserLayer),
  );
  registerLegacyTool(
    FLOODFILL_TOOL_ID,
    (layer) => new VoxelFloodFillLegacyTool(layer as unknown as VoxUserLayer),
  );
  registerLegacyTool(
    ADOPT_VOXEL_LABEL_TOOL_ID,
    (layer) => new AdoptVoxelLabelTool(layer as unknown as VoxUserLayer),
  );
}
