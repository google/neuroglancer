/**
 * @license
 * Copyright 2025 Google Inc.
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

import "#src/ui/voxel_annotations.css";

import type { MouseSelectionState } from "#src/layer/index.js";
import {
  getEditingContext,
  VOXEL_LAYER_CONTROLS,
} from "#src/layer/voxel_annotation/controls.js";
import type { UserLayerWithVoxelEditing } from "#src/layer/voxel_annotation/index.js";
import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import { StatusMessage } from "#src/status.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import { linkWatchableValue } from "#src/trackable_value.js";
import svg_floodFillCursor from "#src/ui/flood_fill_cursor.svg?raw";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  registerTool,
  ToolBindingWidget,
  type ToolActivation,
} from "#src/ui/tool.js";
import svg_valuePicker from "#src/ui/value_picker_cursor.svg?raw";
import { vec3 } from "#src/util/geom.js";
import type { ActionEvent } from "#src/util/mouse_bindings.js";
import { EventActionMap } from "#src/util/mouse_bindings.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";
import {
  BRUSH_TOOL_ID,
  FLOODFILL_TOOL_ID,
  getBasisFromNormal,
  VALUE_PICKER_TOOL_ID,
} from "#src/voxel_annotation/base.js";

const BRUSH_INPUT_MAP = EventActionMap.fromObject({
  ["at:control+mousedown0"]: "paint-voxels",
  ["at:control+shift+mousedown0"]: "erase-voxels",
  ["at:control+shift?+mousedown1"]: "flood-fill-shortcut",
});

const FLOOD_INPUT_MAP = EventActionMap.fromObject({
  ["at:control+mousedown0"]: "paint-voxels",
  ["at:control+shift+mousedown0"]: "erase-voxels",
});

const CONTROLS_FOR_TOOL = new Map<string, string[]>([
  [BRUSH_TOOL_ID, ["vox-brush-size", "vox-brush-shape"]],
  [FLOODFILL_TOOL_ID, ["vox-flood-max-voxels"]],
]);

function getFloodFillCursor(erase: boolean) {
  const lightColor = erase ? "#FF8888" : "#FFFFFF";
  const darkColor = erase ? "#610000" : "#000000";

  const floodFillSVG = svg_floodFillCursor
    .replaceAll("LIGHT_COLOR", lightColor)
    .replaceAll("DARK_COLOR", darkColor)
    .replace(/\s\s+/g, " ");

  return `url('data:image/svg+xml;utf8,${encodeURIComponent(floodFillSVG)}') 24 24, crosshair`;
}

abstract class BaseVoxelTool extends LayerTool<UserLayerWithVoxelEditing> {
  protected latestMouseState: MouseSelectionState | null = null;
  private lastNormal: vec3 | undefined = undefined;
  protected cursorEraseMode = new TrackableBoolean(false);

  protected getPoint(mouseState: MouseSelectionState): Int32Array | undefined {
    const editContext = getEditingContext(this.layer);
    if (editContext === undefined) return undefined;
    const vox = editContext.getVoxelPositionFromMouse(mouseState) as
      | Float32Array
      | undefined;
    if (!mouseState?.active || !vox) return undefined;
    if (!mouseState.planeNormal) return;
    this.lastNormal = editContext.transformGlobalToVoxelNormal(
      mouseState.planeNormal,
    );
    const CHUNK_POSITION_EPSILON = 1e-3;
    const shiftedVox = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      shiftedVox[i] =
        vox[i] + CHUNK_POSITION_EPSILON * Math.abs(this.lastNormal[i]);
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

  abstract bindToolInput(activation: ToolActivation<this>): void;

  activate(activation: ToolActivation<this>): boolean {
    if (!this.layer.hasSubsourcesWithWritingEnabled.value) {
      StatusMessage.showTemporaryMessage(
        'Voxel editing is not available. Please select a writable volume source in the "Source" tab.',
        5000,
      );
      activation.cancel();
      return false;
    }
    this.showToolOptionsBar(activation);
    this.bindToolInput(activation);

    const updateCursorState = (e: KeyboardEvent | MouseEvent) => {
      this.cursorEraseMode.value = e.ctrlKey && e.shiftKey;
    };
    activation.registerEventListener(window, "keydown", updateCursorState);
    activation.registerEventListener(window, "keyup", updateCursorState);
    activation.registerEventListener(window, "mousemove", updateCursorState);

    const paintCallback =
      (erasing: boolean) => (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        this.layer.setEraseState(erasing);
        this.activationCallback(activation);
        startRelativeMouseDrag(
          event.detail as MouseEvent,
          () => {
            this.latestMouseState = this.mouseState;
          },
          () => {
            this.deactivationCallback(activation);
            this.layer.setEraseState(false);
          },
        );
        return true;
      };

    activation.bindAction("paint-voxels", paintCallback(false));
    activation.bindAction("erase-voxels", paintCallback(true));
    return true;
  }

  private showToolOptionsBar(activation: ToolActivation<this>) {
    const toolId = this.toJSON();
    const controlTypes = CONTROLS_FOR_TOOL.get(toolId);

    const { header, body } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = `${this.layer.managedLayer.name} - ${this.description}`;
    header.classList.add("neuroglancer-tool-activation-status-header");
    body.classList.add("neuroglancer-voxel-tool-options-body");

    if (!controlTypes) return;

    const visibility = new WatchableVisibilityPriority(
      WatchableVisibilityPriority.VISIBLE,
    );

    for (const type of controlTypes) {
      const def = VOXEL_LAYER_CONTROLS.find(
        (c) => c.toolJson && c.toolJson.type === type,
      );
      if (!def) continue;

      const controlContainer = document.createElement("label");
      controlContainer.classList.add("neuroglancer-layer-control-container");
      controlContainer.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });

      const labelContainer = document.createElement("div");
      labelContainer.classList.add(
        "neuroglancer-layer-control-label-container",
      );
      controlContainer.appendChild(labelContainer);

      const label = document.createElement("div");
      label.classList.add("neuroglancer-layer-control-label");
      if (def.title) {
        label.title = def.title;
      }
      labelContainer.appendChild(label);

      const labelTextContainer = document.createElement("div");
      labelTextContainer.classList.add(
        "neuroglancer-layer-control-label-text-container",
      );
      labelTextContainer.textContent = def.label;
      label.appendChild(labelTextContainer);

      const { controlElement } = def.makeControl(this.layer, activation, {
        labelContainer,
        labelTextContainer,
        display: this.layer.manager.root.display,
        visibility,
      });
      controlElement.classList.add("neuroglancer-layer-control-control");
      controlContainer.appendChild(controlElement);

      if (def.toolJson) {
        const widget = new ToolBindingWidget(
          this.layer.toolBinder,
          def.toolJson,
          undefined,
        );
        activation.registerDisposer(widget);
        label.prepend(widget.element);
      }

      body.appendChild(controlContainer);
    }
  }

  protected async performFloodFill(erasing: boolean): Promise<void> {
    const editContext = getEditingContext(this.layer);
    if (editContext === undefined) {
      StatusMessage.showTemporaryMessage(
        'Voxel editing is not available. Please select a writable volume source in the "Source" tab.',
        5000,
      );
      return;
    }
    const seed = this.getPoint(this.mouseState);
    const basis = this.getBasis();
    if (!seed || !basis) {
      StatusMessage.showTemporaryMessage(
        "Unable to retrieve mouse position. Please try again.",
        5000,
      );
      return;
    }
    try {
      const value = this.layer.getVoxelPaintValue(erasing);
      const max = Number(this.layer.floodMaxVoxels.value);
      if (!Number.isFinite(max) || max <= 0) {
        throw new Error("Invalid max fill voxels setting");
      }

      const filterValue =
        this.layer.lockToSelectedValue.value && erasing
          ? this.layer.getVoxelPaintValue(false)(false)
          : undefined;

      void editContext
        .floodFillPlane2D(
          new Float32Array(seed),
          value,
          Math.floor(max),
          basis,
          filterValue,
        )
        .catch((e: any) =>
          StatusMessage.showTemporaryMessage(String(e?.message ?? e)),
        );
    } catch (e: any) {
      StatusMessage.showTemporaryMessage(String(e?.message ?? e));
    }
  }

  abstract activationCallback(activation: ToolActivation<this>): void;
  abstract deactivationCallback(activation: ToolActivation<this>): void;

  protected setCursor(cursor: string) {
    for (const panel of this.layer.manager.root.display.panels) {
      panel.element.style.setProperty("cursor", cursor, "important");
    }
  }

  protected resetCursor() {
    for (const panel of this.layer.manager.root.display.panels) {
      panel.element.style.removeProperty("cursor");
    }
  }

  protected getBasis() {
    const n = this.lastNormal;
    if (!n) {
      console.error("getBasis: Unexpected behavior: lastNormal is undefined");
      return undefined;
    }
    return getBasisFromNormal(n);
  }
}

export class VoxelBrushTool extends BaseVoxelTool {
  private isDrawing = false;
  private lastPoint: Int32Array | undefined;
  private mouseDisposer: (() => void) | undefined;
  private animationFrameHandle: number | null = null;
  private cursorResetTimer: number | null = null;

  activate(activation: ToolActivation<this>): boolean {
    if (!super.activate(activation)) return false;

    activation.registerDisposer(
      linkWatchableValue(this.cursorEraseMode, this.layer.cursorInEraseMode),
    );

    activation.registerDisposer(() => {
      if (this.cursorResetTimer !== null) {
        clearTimeout(this.cursorResetTimer);
        this.cursorResetTimer = null;
      }
      this.layer.cursorInEraseMode.value = false;
      this.resetCursor();
      this.layer.scheduleOverlayRedraw();
    });

    activation.registerDisposer(
      this.mouseState.changed.add(this.layer.scheduleOverlayRedraw),
    );
    this.layer.scheduleOverlayRedraw();

    activation.bindAction(
      "flood-fill-shortcut",
      (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        this.triggerFloodFill(event.detail.shiftKey);
      },
    );
    return true;
  }

  private triggerFloodFill(erasing: boolean) {
    const wasErasing = this.layer.shouldErase();
    this.layer.setEraseState(erasing);

    if (this.cursorResetTimer !== null) clearTimeout(this.cursorResetTimer);
    this.setCursor(getFloodFillCursor(erasing));

    this.performFloodFill(erasing).finally(() => {
      if (this.cursorResetTimer !== null) clearTimeout(this.cursorResetTimer);
      this.cursorResetTimer = window.setTimeout(() => {
        this.layer.setEraseState(wasErasing);
        this.resetCursor();
        this.cursorResetTimer = null;
      }, 1000);
    });
  }

  activationCallback(_activation: ToolActivation<this>): void {
    if (getEditingContext(this.layer) === undefined) {
      StatusMessage.showTemporaryMessage(
        'Voxel editing is not available. Please select a writable volume source in the "Source" tab.',
        5000,
      );
      this.stopDrawing();
      return;
    }
    this.startDrawing(this.mouseState);
  }

  deactivationCallback(_activation: ToolActivation<this>): void {
    this.stopDrawing();
  }

  constructor(layer: UserLayerWithVoxelEditing) {
    super(layer, /*toggle=*/ true);
  }

  toJSON() {
    return BRUSH_TOOL_ID;
  }

  get description() {
    return "Brush tool";
  }

  bindToolInput(activation: ToolActivation<this>) {
    activation.bindInputEventMap(BRUSH_INPUT_MAP);
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
          this.paintPoints(points);
        }
      }
      this.lastPoint = cur;
    }
    this.animationFrameHandle = requestAnimationFrame(this.drawLoop);
  };

  private startDrawing(mouseState: MouseSelectionState) {
    if (this.isDrawing) return;
    this.isDrawing = true;

    const start = this.getPoint(mouseState);
    if (!start) {
      throw new Error(
        "startDrawing: could not compute a starting voxel position from mouse",
      );
    }

    this.paintPoints([new Float32Array([start[0], start[1], start[2]])]);
    this.lastPoint = start;
    this.latestMouseState = mouseState;

    this.mouseDisposer = mouseState.changed.add(() => {
      this.latestMouseState = mouseState;
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
  }

  private paintPoints(points: Float32Array[]) {
    const radius = Math.max(1, Math.floor(this.layer.brushRadius.value ?? 3));
    const editContext = getEditingContext(this.layer);
    if (editContext === undefined) {
      throw new Error("editContext is undefined");
    }
    const shapeEnum = this.layer.brushShape.value;
    const basis = this.getBasis();
    if (!basis) {
      throw new Error("basis is undefined");
    }

    const value = this.layer.getVoxelPaintValue(this.layer.shouldErase());
    const filterValue =
      this.layer.lockToSelectedValue.value && this.layer.shouldErase()
        ? this.layer.getVoxelPaintValue(false)(false)
        : undefined;

    void editContext.paintBrushWithShape(
      points,
      radius,
      value,
      shapeEnum,
      basis,
      filterValue,
    );
  }
}

export class VoxelFloodFillTool extends BaseVoxelTool {
  activate(activation: ToolActivation<this>) {
    if (!super.activate(activation)) return false;
    this.setCursor(getFloodFillCursor(this.cursorEraseMode.value));
    activation.registerDisposer(
      this.cursorEraseMode.changed.add(() => {
        this.setCursor(getFloodFillCursor(this.cursorEraseMode.value));
      }),
    );
    activation.registerDisposer(() => {
      this.resetCursor();
    });
    return true;
  }

  activationCallback(_activation: ToolActivation<this>): void {
    this.performFloodFill(this.layer.shouldErase());
  }

  bindToolInput(activation: ToolActivation<this>) {
    activation.bindInputEventMap(FLOOD_INPUT_MAP);
  }

  deactivationCallback(_activation: ToolActivation<this>): void {
    return;
  }

  constructor(layer: UserLayerWithVoxelEditing) {
    super(layer, /*toggle=*/ true);
  }

  toJSON() {
    return FLOODFILL_TOOL_ID;
  }

  get description() {
    return "Flood fill tool";
  }
}

const pickerCursor = `url('data:image/svg+xml;utf8,${encodeURIComponent(svg_valuePicker)}') 24 24, crosshair`;

export class AdoptVoxelValueTool extends LayerTool<UserLayerWithVoxelEditing> {
  private lastPickPosition: Float32Array | undefined;
  private lastCheckedSourceIndex = -1;

  readonly singleChannelAccess: ChunkChannelAccessParameters = {
    numChannels: 1,
    channelSpaceShape: new Uint32Array([]),
    chunkChannelDimensionIndices: [],
    chunkChannelCoordinates: new Uint32Array([0]),
  };

  constructor(layer: UserLayerWithVoxelEditing) {
    super(layer, /*toggle=*/ false);
  }

  protected setCursor(cursor: string) {
    for (const panel of this.layer.manager.root.display.panels) {
      panel.element.style.setProperty("cursor", cursor, "important");
    }
  }

  protected resetCursor() {
    for (const panel of this.layer.manager.root.display.panels) {
      panel.element.style.removeProperty("cursor");
    }
  }

  toJSON() {
    return VALUE_PICKER_TOOL_ID;
  }

  get description() {
    return "Picking tool";
  }

  activate(activation: ToolActivation<this>): void {
    if (!this.layer.hasSubsourcesWithWritingEnabled.value) {
      StatusMessage.showTemporaryMessage(
        'Voxel editing is not available. Please select a writable volume source in the "Source" tab.',
        5000,
      );
      activation.cancel();
      return;
    }
    if (!this.mouseState?.active) return;
    this.setCursor(pickerCursor);
    activation.registerDisposer(() => {
      this.resetCursor();
    });

    const currentPosition = this.mouseState.position.slice() as vec3;

    if (
      this.lastPickPosition === undefined ||
      !vec3.equals(this.lastPickPosition as vec3, currentPosition)
    ) {
      this.lastPickPosition = currentPosition;
      this.lastCheckedSourceIndex = -1;
    }

    const allContexts = Array.from(this.layer.editingContexts.values());

    if (allContexts.length === 0) {
      StatusMessage.showTemporaryMessage(
        "No volume sources found in this layer.",
        3000,
      );
      return;
    }

    const numSources = allContexts.length;
    const startIndex = this.lastCheckedSourceIndex + 1;

    const checkNextSource = async () => {
      for (let i = 0; i < numSources; ++i) {
        const sourceIndex = (startIndex + i) % numSources;
        const context = allContexts[sourceIndex]!;

        const voxelCoord = context.getVoxelPositionFromMouse(this.mouseState);
        if (voxelCoord === undefined) continue;

        const source = context.primarySource.getSources(
          this.layer.getIdentitySliceViewSourceOptions(),
        )[0][0]!.chunkSource;

        const valueResult = source.getValueAt(
          voxelCoord,
          this.singleChannelAccess,
        );
        const value = Array.isArray(valueResult) ? valueResult[0] : valueResult;
        const bigValue = BigInt(value || 0);

        if (bigValue !== 0n) {
          this.layer.setVoxelPaintValue(bigValue);
          this.lastCheckedSourceIndex = sourceIndex;
          StatusMessage.showTemporaryMessage(
            `Adopted value: ${bigValue} (from source ${sourceIndex + 1}/${numSources})`,
            3000,
          );
          return;
        }
      }

      this.lastCheckedSourceIndex = -1;
      StatusMessage.showTemporaryMessage(
        "No further segments found at this position.",
        3000,
      );
    };

    StatusMessage.forPromise(checkNextSource(), {
      initialMessage: "Picking voxel value...",
      delay: true,
      errorPrefix: "Error picking value: ",
    });
  }
}

export function registerVoxelTools(LayerCtor: any) {
  registerTool(
    LayerCtor,
    BRUSH_TOOL_ID,
    (layer: UserLayerWithVoxelEditing) => new VoxelBrushTool(layer),
  );
  registerTool(
    LayerCtor,
    FLOODFILL_TOOL_ID,
    (layer: UserLayerWithVoxelEditing) => new VoxelFloodFillTool(layer),
  );
  registerTool(
    LayerCtor,
    VALUE_PICKER_TOOL_ID,
    (layer: UserLayerWithVoxelEditing) => new AdoptVoxelValueTool(layer),
  );
}
