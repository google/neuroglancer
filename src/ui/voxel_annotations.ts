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
import { BrushShape } from "#src/layer/vox/index.js";
import { StatusMessage } from "#src/status.js";
import { LayerTool, registerTool, type ToolActivation } from "#src/ui/tool.js";
import { vec3 } from "#src/util/geom.js";
import { EventActionMap } from "#src/util/mouse_bindings.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";

export const BRUSH_TOOL_ID = "vox-brush";
export const FLOODFILL_TOOL_ID = "vox-flood-fill";
export const ADOPT_VOXEL_LABEL_TOOL_ID = "vox-pick-label";

const VOX_TOOL_INPUT_MAP = EventActionMap.fromObject({
  ["at:control+mousedown0"]: "paint-voxels",
});

abstract class BaseVoxelTool extends LayerTool<VoxUserLayer> {
  protected latestMouseState: MouseSelectionState | null = null;

  protected getPoint(mouseState: MouseSelectionState): Int32Array | undefined {
    const vox = this.layer.getVoxelPositionFromMouse?.(mouseState) as
      | Float32Array
      | undefined;
    if (!mouseState?.active || !vox) return undefined;
    const planeNormal = mouseState?.planeNormal;
    if (!mouseState?.active || !vox || !planeNormal) return undefined;
    const CHUNK_POSITION_EPSILON = 1e-3;
    const shiftedVox = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      shiftedVox[i] =
        vox[i] + CHUNK_POSITION_EPSILON * Math.abs(planeNormal[i]);
    }
    return new Int32Array([
      Math.floor(shiftedVox[0]),
      Math.floor(shiftedVox[1]),
      Math.floor(shiftedVox[2]),
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

  activate(activation: ToolActivation<this>): void {
    activation.bindInputEventMap(VOX_TOOL_INPUT_MAP);

    activation.bindAction("paint-voxels", (event) => {
      event.stopPropagation();
      this.activationCallback(activation);
        startRelativeMouseDrag(
          event.detail as MouseEvent,
          () => {
            this.latestMouseState = this.mouseState;
          },
          () => {
            this.deactivationCallback(activation);
          },
        );

        return true;
    });

  }

  abstract activationCallback(activation: ToolActivation<this>): void;
  abstract deactivationCallback(activation: ToolActivation<this>): void;

}

export class VoxelBrushTool extends BaseVoxelTool {
  private isDrawing = false;
  private lastPoint: Int32Array | undefined;
  private mouseDisposer: (() => void) | undefined;
  private currentMouseState: MouseSelectionState | undefined;
  private animationFrameHandle: number | null = null;

  activationCallback(_activation: ToolActivation<this>): void {
    this.startDrawing(this.mouseState);
  }
  deactivationCallback(_activation: ToolActivation<this>): void {
    this.stopDrawing();
  }
  constructor(layer: VoxUserLayer) {
    super(layer, /*toggle=*/ true);
  }

  toJSON() {
    return BRUSH_TOOL_ID;
  }

  get description() {
    return "Brush tool";
  }

  private drawLoop = (): void => {
    if (!this.isDrawing) {
      this.animationFrameHandle = null;
      return;
    }
    if (this.latestMouseState === null) {
      this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
      return;
    }
    const cur = this.getPoint(this.latestMouseState);
    this.latestMouseState = null;
    if (cur) {
      const last = this.lastPoint;
      if (
        last &&
        (cur[0] !== last[0] || cur[1] !== last[1] || cur[2] !== last[2])
      ) {
        const points = this.linePoints(last, cur);
        if (points.length > 0) {
          const value = this.layer.voxLabelsManager.getCurrentLabelValue(
            this.layer.voxEraseMode.value,
          );
          this.paintPoints(points, value);
        }
      }
      this.lastPoint = cur;
    }
    this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
  };

  private startDrawing(mouseState: MouseSelectionState) {
    if (this.isDrawing) return;
    this.isDrawing = true;
    this.currentMouseState = mouseState;

    const start = this.getPoint(mouseState);
    if (!start) {
      throw new Error(
        "startDrawing: could not compute a starting voxel position from mouse",
      );
    }

    // Lock render LOD to base level during edits
    this.layer.beginRenderLodLock(0);

    const value = this.layer.voxLabelsManager.getCurrentLabelValue(
      this.layer.voxEraseMode.value,
    );

    this.paintPoints([new Float32Array([start[0], start[1], start[2]])], value);
    this.lastPoint = start;
    this.latestMouseState = mouseState;

    this.mouseDisposer = mouseState.changed.add(() => {
      this.latestMouseState = mouseState;
      this.currentMouseState = mouseState;
    });

    if (this.animationFrameHandle === null) {
      this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
    }
  }

  private stopDrawing() {
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
    try {
      this.layer.endRenderLodLock();
    } catch {
      /* ignore */
    }
  }

  private paintPoints(points: Float32Array[], value: bigint) {
    const radius = Math.max(
      1,
      Math.floor(this.layer.voxBrushRadius.value ?? 3),
    );
    const shapeEnum = this.layer.voxBrushShape.value;
    const ctrl = this.layer.voxEditController;
    let basis = undefined as undefined | { u: Float32Array; v: Float32Array };
    if (shapeEnum === BrushShape.DISK && this.currentMouseState?.planeNormal) {
      const n = this.currentMouseState.planeNormal;
      const u = vec3.create();
      const tempVec =
        Math.abs(vec3.dot(n, vec3.fromValues(1, 0, 0))) < 0.9
          ? vec3.fromValues(1, 0, 0)
          : vec3.fromValues(0, 1, 0);
      vec3.cross(u, tempVec, n);
      vec3.normalize(u, u);
      const v = vec3.cross(vec3.create(), n, u);
      vec3.normalize(v, v);
      basis = { u, v };
    }
    for (const p of points)
      ctrl?.paintBrushWithShape(p, radius, value, shapeEnum, basis);
  }
}

export class VoxelFloodFillTool extends BaseVoxelTool {
  activationCallback(_activation: ToolActivation<this>): void {
    const seed = this.getPoint(this.mouseState);
    const planeNormal = this.mouseState.planeNormal;
    if (!seed || !planeNormal) return;
    const layer = this.layer;
    try {
      layer.setDrawErrorMessage(undefined);
      const value = layer.voxLabelsManager.getCurrentLabelValue(
        layer.voxEraseMode.value,
      );
      const max = Number(layer.voxFloodMaxVoxels.value);
      if (!Number.isFinite(max) || max <= 0) {
        throw new Error("Invalid max fill voxels setting");
      }
      const ctrl = layer.voxEditController;
      if (!ctrl) throw new Error("Drawing backend not ready yet");
      ctrl
        .floodFillPlane2D(
          new Float32Array(seed),
          value,
          Math.floor(max),
          planeNormal,
        )
        .catch((e: any) =>
          layer.setDrawErrorMessage?.(String(e?.message ?? e)),
        );
    } catch (e: any) {
      layer.setDrawErrorMessage?.(String(e?.message ?? e));
    }
  }

  deactivationCallback(_activation: ToolActivation<this>): void {
    return;
  }

  constructor(layer: VoxUserLayer) {
    super(layer, /*toggle=*/ true);
  }

  toJSON() {
    return FLOODFILL_TOOL_ID;
  }

  get description() {
    return "Flood fill tool";
  }
}

export class AdoptVoxelLabelTool extends LayerTool<VoxUserLayer> {
  constructor(layer: VoxUserLayer) {
    super(layer, /*toggle=*/ false);
  }

  toJSON() {
    return ADOPT_VOXEL_LABEL_TOOL_ID;
  }

  get description() {
    return "Picking tool";
  }

  activate(_activation: ToolActivation<this>): void {
    if (!this.mouseState?.active) return;
    const layer = this.layer as VoxUserLayer;
    const pos = layer.getVoxelPositionFromMouse?.(this.mouseState);

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

    const source = editController.getSourceForLOD(0);
    const channelAccess = editController.singleChannelAccess;

    StatusMessage.forPromise(
      source
        .getEnsuredValueAt(pos, channelAccess)
        .then((value: bigint | number | null) => {
          if (value === null) {
            throw new Error(
              "Voxel data not available at the selected position.",
            );
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

export function registerVoxelTools(LayerCtor: any) {
  registerTool(LayerCtor, BRUSH_TOOL_ID, (layer: VoxUserLayer) => new VoxelBrushTool(layer));
  registerTool(LayerCtor, FLOODFILL_TOOL_ID, (layer: VoxUserLayer) => new VoxelFloodFillTool(layer));
  registerTool(LayerCtor, ADOPT_VOXEL_LABEL_TOOL_ID, (layer: VoxUserLayer) => new AdoptVoxelLabelTool(layer));
}
