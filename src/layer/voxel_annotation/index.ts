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

import type {
  LayerActionContext,
  MouseSelectionState,
} from "#src/layer/index.js";
import { UserLayer } from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import {
  drawBrushCursor,
  getEditingContext,
} from "#src/layer/voxel_annotation/controls.js";
import { VoxToolTab } from "#src/layer/voxel_annotation/draw_tab.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import {
  getChunkPositionFromCombinedGlobalLocalPositions,
  getChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
import type { RenderedDataPanel } from "#src/rendered_data_panel.js";
import type {
  SliceViewSourceOptions,
  SliceViewRenderLayer,
} from "#src/sliceview/base.js";
import { DataType } from "#src/sliceview/base.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { StatusMessage } from "#src/status.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeDerivedWatchableValue,
  TrackableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { randomUint64 } from "#src/util/bigint.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import {
  parseUint64,
  verifyFiniteFloat,
  verifyInt,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";
import { VoxelPreviewMultiscaleSource } from "#src/voxel_annotation/PreviewMultiscaleChunkSource.js";
import type {
  VoxelEditControllerHost,
  VoxelValueGetter,
} from "#src/voxel_annotation/base.js";
import {
  VOXEL_EDIT_STAMINA,
  BRUSH_TOOL_ID,
  BrushShape,
  MAX_VOXEL_EDIT_STAMINA,
} from "#src/voxel_annotation/base.js";
import { VoxelEditController } from "#src/voxel_annotation/frontend.js";

const BRUSH_SIZE_JSON_KEY = "brushSize";
const ERASE_SELECTED_MODE_JSON_KEY = "eraseSelectedMode";
const BRUSH_SHAPE_JSON_KEY = "brushShape";
const FLOOD_FILL_MAX_VOXELS_JSON_KEY = "floodFillMaxVoxels";
const PAINT_VALUE_JSON_KEY = "paintValue";

const DATA_TYPE_BIT_INFO = {
  [DataType.UINT8]: { bits: 8, signed: false },
  [DataType.INT8]: { bits: 8, signed: true },
  [DataType.UINT16]: { bits: 16, signed: false },
  [DataType.INT16]: { bits: 16, signed: true },
  [DataType.UINT32]: { bits: 32, signed: false },
  [DataType.INT32]: { bits: 32, signed: true },
  [DataType.UINT64]: { bits: 64, signed: false },
};

export class VoxelEditingContext
  extends RefCounted
  implements VoxelEditControllerHost
{
  private readonly _controller: VoxelEditController | undefined = undefined;
  private _pendingPermissionPromise: Promise<boolean> | undefined;
  private hasUserConfirmedWriting = false;

  private cachedChunkTransform: ChunkTransformParameters | undefined;
  private cachedTransformGeneration: number = -1;
  private cachedVoxelPosition: Float32Array = new Float32Array(3);
  optimisticRenderLayer:
    | ImageRenderLayer
    | SegmentationRenderLayer
    | undefined = undefined;
  previewSource: VoxelPreviewMultiscaleSource | undefined = undefined;

  private localLoadEstimate = new WatchableValue<number>(0);
  public totalPending: WatchableValueInterface<number>;

  constructor(
    public hostLayer: UserLayerWithVoxelEditing,
    public primarySource: MultiscaleVolumeChunkSource,
    public primaryRenderLayer: ImageRenderLayer | SegmentationRenderLayer,
    public writingEnabled: boolean,
    public dataSourceUrl: string | undefined,
  ) {
    super();

    if (!writingEnabled) return;

    // NOTE: each of the following 3 checks may be removed if support for the checked contraint is added
    if (primarySource.rank !== 3) {
      throw new Error(
        `Voxel annotation only supports rank 3 volumes (got ${primarySource.rank}).`,
      );
    }
    if (primarySource.dataType === DataType.FLOAT32) {
      throw new Error(`Voxel annotation does not support Float32 datasets.`);
    }
    this.validateHierarchy(primarySource);

    this.previewSource = new VoxelPreviewMultiscaleSource(
      this.hostLayer.manager.chunkManager,
      primarySource,
    );

    this.optimisticRenderLayer = this.hostLayer._createVoxelRenderLayer(
      this.previewSource,
      primaryRenderLayer.transform,
    );

    if (
      this.primaryRenderLayer instanceof SegmentationRenderLayer &&
      this.optimisticRenderLayer instanceof SegmentationRenderLayer
    ) {
      this.optimisticRenderLayer.forceHiddenFromMainRenderLoop = true;
      this.primaryRenderLayer.setVoxelPreviewLayer(this.optimisticRenderLayer);
    }

    // since we only allow drawing at max res, we can lock the optimistic render layer to it
    (
      this.optimisticRenderLayer as SliceViewRenderLayer
    ).getForcedSourceIndexOverride = () => 0;

    this.hostLayer.addRenderLayer(this.optimisticRenderLayer);

    this._controller = new VoxelEditController(this);

    this.totalPending = this.registerDisposer(
      makeDerivedWatchableValue(
        (local, backend) => local + backend,
        this.localLoadEstimate,
        this._controller.pendingOpCount,
      ),
    );
  }

  private async checkPermission(): Promise<boolean> {
    if (this.hasUserConfirmedWriting) {
      return true;
    }
    if (this._pendingPermissionPromise) {
      return false; // this._pendingPermissionPromise;
    }

    this._pendingPermissionPromise = new Promise<boolean>((resolve) => {
      const msg = new StatusMessage(/*delay=*/ false, /*modal=*/ true);
      msg.element.textContent = `Are you sure you want to write to ${this.dataSourceUrl} `;

      const yes = document.createElement("button");
      yes.textContent = "Yes";
      yes.onclick = () => {
        this.hasUserConfirmedWriting = true;
        msg.dispose();
        resolve(true);
      };
      const no = document.createElement("button");
      no.textContent = "No";
      no.onclick = () => {
        msg.dispose();
        resolve(false);
      };
      msg.element.appendChild(yes);
      msg.element.appendChild(no);
      msg.setVisible(true);
    }).then((result) => {
      this._pendingPermissionPromise = undefined;
      return result;
    });

    return false; // this._pendingPermissionPromise;
  }

  private async withCost<T>(
    cost: number,
    op: () => Promise<T>,
  ): Promise<T | void> {
    if (this.localLoadEstimate.value >= MAX_VOXEL_EDIT_STAMINA) return;
    this.localLoadEstimate.value += cost;
    try {
      if (await this.checkPermission()) {
        return await op();
      }
    } finally {
      this.localLoadEstimate.value -= cost;
    }
  }

  async paintBrushWithShape(
    centerCanonical: Float32Array,
    radiusCanonical: number,
    value: VoxelValueGetter,
    shape: BrushShape,
    basis: { u: Float32Array; v: Float32Array },
    filterValue?: bigint,
  ) {
    if (!this._controller)
      throw new Error("Cannot use paintBrushWithShape without a controller");
    const cost = VOXEL_EDIT_STAMINA.brush(
      shape,
      radiusCanonical,
      filterValue !== undefined,
    );
    await this.withCost(cost, () =>
      this._controller!.paintBrushWithShape(
        centerCanonical,
        radiusCanonical,
        value,
        shape,
        basis,
        filterValue,
      ),
    );
  }

  async floodFillPlane2D(
    startPositionCanonical: Float32Array,
    fillValue: VoxelValueGetter,
    maxVoxels: number,
    basis: { u: Float32Array; v: Float32Array },
    filterValue?: bigint,
  ) {
    if (!this._controller)
      throw new Error("Cannot use floodFillPlane2D without a controller");
    const cost = VOXEL_EDIT_STAMINA.floodFill(maxVoxels);
    await this.withCost(cost, () =>
      this._controller!.floodFillPlane2D(
        startPositionCanonical,
        fillValue,
        maxVoxels,
        basis,
        filterValue,
      ),
    );
  }

  async undo() {
    if (!this._controller)
      throw new Error("Cannot use undo without a controller");
    await this.withCost(VOXEL_EDIT_STAMINA.undoRedo(), () =>
      this._controller!.undo(),
    );
  }

  async redo() {
    if (!this._controller)
      throw new Error("Cannot use redo without a controller");
    await this.withCost(VOXEL_EDIT_STAMINA.undoRedo(), () =>
      this._controller!.redo(),
    );
  }

  get rpc() {
    return this.hostLayer.manager.chunkManager.rpc!;
  }

  disposed() {
    if (this._controller) this._controller.dispose();
    if (this.optimisticRenderLayer) {
      if (
        this.primaryRenderLayer instanceof SegmentationRenderLayer &&
        this.optimisticRenderLayer instanceof SegmentationRenderLayer
      ) {
        this.primaryRenderLayer.setVoxelPreviewLayer(undefined);
      }
      this.hostLayer.removeRenderLayer(this.optimisticRenderLayer);
    }
    super.disposed();
  }

  /**
   * Verifies that the size of a parent chunk is an integer multiple
   * of the size of a child chunk.
   */
  private validateHierarchy(primarySource: MultiscaleVolumeChunkSource) {
    const rank = primarySource.rank;

    const identityOptions = this.hostLayer.getIdentitySliceViewSourceOptions();
    const scales = primarySource.getSources(identityOptions)[0];

    if (!scales || scales.length < 2) return;

    const getPhysicalChunkExtent = (lodIndex: number) => {
      const source = scales[lodIndex];
      const transform = source.chunkToMultiscaleTransform;
      const chunkVoxels = source.chunkSource.spec.chunkDataSize;

      const extent = new Float32Array(rank);

      for (let i = 0; i < rank; i++) {
        let sumSq = 0;
        for (let row = 0; row < rank; row++) {
          const val = transform[i * (rank + 1) + row];
          sumSq += val * val;
        }
        const scaleFactor = Math.sqrt(sumSq);
        extent[i] = chunkVoxels[i] * scaleFactor;
      }
      return extent;
    };

    for (let i = 0; i < scales.length - 1; i++) {
      const childExtents = getPhysicalChunkExtent(i);
      const parentExtents = getPhysicalChunkExtent(i + 1);

      for (let d = 0; d < rank; d++) {
        const ratio = parentExtents[d] / childExtents[d];
        const isInteger = Math.abs(ratio - Math.round(ratio)) < 0.001;

        if (!isInteger) {
          throw new Error(
            `Hierarchy mismatch between LOD ${i} and ${i + 1}. ` +
              `Parent chunk must contain a whole number of child chunks. ` +
              `Ratio dim ${d}: ${ratio.toFixed(3)}`,
          );
        }
      }
    }
  }

  getChunkTransform(): ChunkTransformParameters | undefined {
    const renderLayer = this.primaryRenderLayer;
    const renderLayerTransform = renderLayer.transform.value;
    if (renderLayerTransform.error !== undefined) {
      return undefined;
    }

    const transformGeneration = renderLayer.transform.changed.count;
    if (this.cachedTransformGeneration !== transformGeneration) {
      this.cachedChunkTransform = undefined;
      try {
        this.cachedChunkTransform = getChunkTransformParameters(
          renderLayerTransform,
          this.primarySource.getSources(
            this.hostLayer.getIdentitySliceViewSourceOptions(),
          )[0][0]!.chunkToMultiscaleTransform,
        );
        this.cachedTransformGeneration = transformGeneration;
      } catch (e) {
        this.cachedTransformGeneration = -1;
        console.error("Error computing chunk transform parameters:", e);
        return undefined;
      }
    }
    return this.cachedChunkTransform;
  }

  getVoxelPositionFromMouse(
    mouseState: MouseSelectionState,
  ): Float32Array | undefined {
    const chunkTransform = this.getChunkTransform();
    if (chunkTransform === undefined) return undefined;

    if (
      this.cachedVoxelPosition.length !==
      chunkTransform.modelTransform.unpaddedRank
    ) {
      this.cachedVoxelPosition = new Float32Array(
        chunkTransform.modelTransform.unpaddedRank,
      );
    }

    const ok = getChunkPositionFromCombinedGlobalLocalPositions(
      this.cachedVoxelPosition,
      mouseState.unsnappedPosition,
      this.hostLayer.localPosition.value,
      chunkTransform.layerRank,
      chunkTransform.combinedGlobalLocalToChunkTransform,
    );
    if (!ok) return undefined;
    return this.cachedVoxelPosition;
  }

  transformGlobalToVoxelNormal(globalNormal: vec3): vec3 {
    const chunkTransform = this.getChunkTransform();
    if (chunkTransform === undefined)
      throw new Error("Chunk transform not computed");
    const { modelTransform, layerToChunkTransform, layerRank } = chunkTransform;
    const { globalToRenderLayerDimensions } = modelTransform;
    const globalRank = globalToRenderLayerDimensions.length;
    const voxelNormal = vec3.create();

    for (let chunkDim = 0; chunkDim < 3; ++chunkDim) {
      let sum = 0;
      for (
        let globalDim = 0;
        globalDim < Math.min(globalRank, 3);
        ++globalDim
      ) {
        const layerDim = globalToRenderLayerDimensions[globalDim];
        if (layerDim !== -1) {
          sum +=
            layerToChunkTransform[chunkDim + layerDim * (layerRank + 1)] *
            globalNormal[globalDim];
        }
      }
      voxelNormal[chunkDim] = sum;
    }
    vec3.normalize(voxelNormal, voxelNormal);
    return voxelNormal;
  }
}

export declare abstract class UserLayerWithVoxelEditing extends UserLayer {
  hasSubsourcesWithWritingEnabled: WatchableValue<boolean>;

  brushRadius: TrackableValue<number>;
  lockToSelectedValue: TrackableBoolean;
  brushShape: TrackableEnum<BrushShape>;
  floodMaxVoxels: TrackableValue<number>;
  paintValue: TrackableValue<bigint>;
  cursorInEraseMode: TrackableBoolean;

  editingContexts: Map<LoadedDataSubsource, VoxelEditingContext>;

  abstract _createVoxelRenderLayer(
    source: MultiscaleVolumeChunkSource,
    transform: WatchableValueInterface<RenderLayerTransformOrError>,
  ): ImageRenderLayer | SegmentationRenderLayer;
  abstract getVoxelPaintValue(erase: boolean): VoxelValueGetter;
  abstract setVoxelPaintValue(value: any): bigint;
  setEraseState(erase: boolean): void;
  shouldErase(): boolean;
  scheduleOverlayRedraw(): void;

  initializeVoxelEditingForSubsource(
    loadedSubsource: LoadedDataSubsource,
    renderlayer: SegmentationRenderLayer | ImageRenderLayer,
  ): void;
  deinitializeVoxelEditingForSubsource(
    loadedSubsource: LoadedDataSubsource,
  ): void;
  updateHasSubsourcesWithWritingEnabled(): void;
  getIdentitySliceViewSourceOptions(): SliceViewSourceOptions;
  handleVoxAction(action: string, context: LayerActionContext): void;
}

export function UserLayerWithVoxelEditingMixin<
  TBase extends { new (...args: any[]): UserLayerWithAnnotations },
>(Base: TBase) {
  abstract class C extends Base implements UserLayerWithVoxelEditing {
    editingContexts = new Map<LoadedDataSubsource, VoxelEditingContext>();
    hasSubsourcesWithWritingEnabled = new WatchableValue<boolean>(false);
    paintValue = new TrackableValue<bigint>(1n, (x) => parseUint64(x));

    // Brush properties
    brushRadius = new TrackableValue<number>(3, verifyInt);
    lockToSelectedValue = new TrackableBoolean(false);
    brushShape = new TrackableEnum(BrushShape, BrushShape.DISK);
    floodMaxVoxels = new TrackableValue<number>(10000, verifyFiniteFloat);
    cursorInEraseMode = new TrackableBoolean(false, false);

    private _isInEraseState = false;

    constructor(...args: any[]) {
      super(...args);
      this.registerDisposer(() => {
        for (const context of this.editingContexts.values()) {
          context.dispose();
        }
        this.editingContexts.clear();
      });
      this.brushRadius.changed.add(this.specificationChanged.dispatch);
      this.lockToSelectedValue.changed.add(this.specificationChanged.dispatch);
      this.brushShape.changed.add(this.specificationChanged.dispatch);
      this.floodMaxVoxels.changed.add(this.specificationChanged.dispatch);
      this.paintValue.changed.add(this.specificationChanged.dispatch);

      this.bindOverlayToPanels();
      this.registerDisposer(
        this.manager.root.display.updateStarted.add(() =>
          this.bindOverlayToPanels(),
        ),
      );

      this.brushRadius.changed.add(this.scheduleOverlayRedraw);
      this.manager.root.layerSelectedValues.mouseState.changed.add(
        this.scheduleOverlayRedraw,
      );
      this.cursorInEraseMode.changed.add(this.scheduleOverlayRedraw);

      this.layersChanged.add(() => {
        const ctx = getEditingContext(this);
        if (ctx) {
          this.registerDisposer(
            ctx.totalPending.changed.add(this.scheduleOverlayRedraw),
          );
        }
      });
      this.scheduleOverlayRedraw();

      this.tabs.add("Draw", {
        label: "Draw",
        order: 20,
        hidden: makeDerivedWatchableValue(
          (editable) => !editable,
          this.hasSubsourcesWithWritingEnabled,
        ),
        getter: () => new VoxToolTab(this),
      });
    }

    scheduleOverlayRedraw = () => {
      for (const panel of this.manager.root.display.panels) {
        if (panel instanceof SliceViewPanel) {
          panel.scheduleOverlayRedraw();
        }
      }
    };

    private boundPanelCleanups = new Map<RenderedDataPanel, () => void>();
    private bindOverlayToPanels() {
      for (const panel of this.manager.root.display.panels) {
        if (
          panel instanceof SliceViewPanel &&
          !this.boundPanelCleanups.has(panel)
        ) {
          const rm = panel.overlayDraw.add((ctx, _w, _h, p) =>
            this.handleOverlayDraw(ctx, p),
          );
          this.boundPanelCleanups.set(panel, rm);
        }
      }
      for (const [panel, cleanup] of this.boundPanelCleanups) {
        if (!this.manager.root.display.panels.has(panel)) {
          cleanup();
          this.boundPanelCleanups.delete(panel);
        }
      }
    }

    private handleOverlayDraw(
      ctx: CanvasRenderingContext2D,
      panel: RenderedDataPanel,
    ) {
      if (
        panel.mouseX < 0 ||
        panel.mouseY < 0 ||
        !this.hasSubsourcesWithWritingEnabled.value
      ) {
        return;
      }
      const globalToolBinder = this.manager.root.toolBinder;
      const activation = globalToolBinder.activeTool_;
      let radiusY = 0;

      if (
        activation &&
        activation.tool.localBinder === this.toolBinder &&
        activation.tool.toJSON() === BRUSH_TOOL_ID
      ) {
        const radiusXY = drawBrushCursor(this, panel, ctx);
        if (radiusXY.radiusY > 0) {
          radiusY = radiusXY.radiusY;
        }
      }

      const editContext = getEditingContext(this);
      const pending = editContext?.totalPending.value || 0;
      this.drawStaminaBar(ctx, panel.mouseX, panel.mouseY, pending, radiusY);
    }

    private drawStaminaBar(
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      pendingCount: number,
      brushOffset: number,
    ) {
      const ratio = Math.max(0, 1.0 - pendingCount / MAX_VOXEL_EDIT_STAMINA);
      if (ratio > 0.99) {
        return;
      }

      const w = 42;
      const h = 5;
      const radius = h / 2;

      const yOffset = 16 + brushOffset;
      const xOffset = 1;
      const bx = x - w / 2 + xOffset;
      const by = y + yOffset;

      ctx.save();

      if (ratio === 0) {
        const [text, textX, textY] = ["WAIT!", x + xOffset, by + 8];
        ctx.fillStyle = "#ff0000";
        ctx.textAlign = "center";
        ctx.font = "bold 16px monospace";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.lineJoin = "round";
        ctx.strokeText(text, textX, textY);
        ctx.fillText(text, textX, textY);
      } else {
        ctx.beginPath();
        ctx.moveTo(bx + radius, by);
        ctx.lineTo(bx + w - radius, by);
        ctx.arcTo(bx + w, by, bx + w, by + h, radius);
        ctx.arcTo(bx + w, by + h, bx, by + h, radius);
        ctx.arcTo(bx, by + h, bx, by, radius);
        ctx.arcTo(bx, by, bx + w, by, radius);
        ctx.closePath();

        ctx.fillStyle = "rgba(159,159,159,0.5)";
        ctx.fill();

        ctx.clip();

        ctx.fillStyle = ratio > 0.3 ? "#5e5e5e" : "#FF0000";
        ctx.fillRect(bx, by, w * ratio, h);
      }
      ctx.restore();
    }

    setEraseState(erase: boolean): void {
      this._isInEraseState = erase;
    }

    shouldErase(): boolean {
      return this._isInEraseState;
    }

    toJSON() {
      const json = super.toJSON();
      json[BRUSH_SIZE_JSON_KEY] = this.brushRadius.toJSON();
      json[ERASE_SELECTED_MODE_JSON_KEY] = this.lockToSelectedValue.toJSON();
      json[BRUSH_SHAPE_JSON_KEY] = this.brushShape.toJSON();
      json[FLOOD_FILL_MAX_VOXELS_JSON_KEY] = this.floodMaxVoxels.toJSON();
      const pv = this.paintValue.toJSON();
      json[PAINT_VALUE_JSON_KEY] = pv === undefined ? undefined : pv.toString();
      return json;
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      verifyOptionalObjectProperty(specification, BRUSH_SIZE_JSON_KEY, (v) =>
        this.brushRadius.restoreState(v),
      );
      verifyOptionalObjectProperty(
        specification,
        ERASE_SELECTED_MODE_JSON_KEY,
        (v) => this.lockToSelectedValue.restoreState(v),
      );
      verifyOptionalObjectProperty(specification, BRUSH_SHAPE_JSON_KEY, (v) =>
        this.brushShape.restoreState(v),
      );
      verifyOptionalObjectProperty(
        specification,
        FLOOD_FILL_MAX_VOXELS_JSON_KEY,
        (v) => this.floodMaxVoxels.restoreState(v),
      );
      verifyOptionalObjectProperty(specification, PAINT_VALUE_JSON_KEY, (v) =>
        this.paintValue.restoreState(v),
      );
    }

    getVoxelPaintValue(erase: boolean): VoxelValueGetter {
      return (_isPreview: boolean) => (erase ? 0n : this.paintValue.value);
    }

    setVoxelPaintValue(x: any) {
      const editContext = this.editingContexts.values().next().value;
      if (!editContext) throw new Error("No voxel editing context available");
      const dataType = editContext.primarySource.dataType;
      let value: bigint;

      if (dataType === DataType.FLOAT32) {
        const floatValue = parseFloat(String(x));
        value = BigInt(Math.round(floatValue));
      } else {
        value = BigInt(x);
      }

      const info =
        DATA_TYPE_BIT_INFO[dataType as keyof typeof DATA_TYPE_BIT_INFO];
      if (!info) {
        this.paintValue.value = value;
        return value;
      }

      const { bits, signed } = info;
      const mask = (1n << BigInt(bits)) - 1n;
      let truncated = value & mask;

      if (signed) {
        const signBit = 1n << BigInt(bits - 1);
        if ((truncated & signBit) !== 0n) {
          truncated -= 1n << BigInt(bits);
        }
      }

      this.paintValue.value = truncated;
      return truncated;
    }

    abstract _createVoxelRenderLayer(
      source: MultiscaleVolumeChunkSource,
      transform: WatchableValueInterface<RenderLayerTransformOrError>,
    ): ImageRenderLayer | SegmentationRenderLayer;

    updateHasSubsourcesWithWritingEnabled(): void {
      this.hasSubsourcesWithWritingEnabled.value = this.editingContexts
        .entries()
        .some((value) => value[1].writingEnabled);
    }

    initializeVoxelEditingForSubsource(
      loadedSubsource: LoadedDataSubsource,
      renderlayer: SegmentationRenderLayer | ImageRenderLayer,
      writingEnabled: boolean = true,
    ): void {
      if (writingEnabled) {
        for (const [otherSubsource, _] of this.editingContexts) {
          if (
            otherSubsource !== loadedSubsource &&
            otherSubsource.writingEnabled.value
          ) {
            otherSubsource.writingEnabled.value = false;
          }
        }
      }

      if (this.editingContexts.has(loadedSubsource)) return;

      const primarySource = loadedSubsource.subsourceEntry.subsource
        .volume as MultiscaleVolumeChunkSource;

      try {
        const context = new VoxelEditingContext(
          this,
          primarySource,
          renderlayer,
          writingEnabled,
          loadedSubsource.loadedDataSource.dataSource.canonicalUrl,
        );
        this.editingContexts.set(loadedSubsource, context);
        this.updateHasSubsourcesWithWritingEnabled();
        this.setVoxelPaintValue(this.paintValue.value);
      } catch (e) {
        if (writingEnabled) {
          loadedSubsource.writingEnabled.value = false;
          this.updateHasSubsourcesWithWritingEnabled();
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("Failed to initialize voxel editing:", msg);
          StatusMessage.showTemporaryMessage(msg, 5000);
        }
      }
    }

    deinitializeVoxelEditingForSubsource(loadedSubsource: LoadedDataSubsource) {
      const context = this.editingContexts.get(loadedSubsource);
      if (context) {
        context.dispose();
        this.editingContexts.delete(loadedSubsource);
      }
      this.updateHasSubsourcesWithWritingEnabled();
    }

    getIdentitySliceViewSourceOptions(): SliceViewSourceOptions {
      const rank = this.localCoordinateSpace.value.rank;
      const displayRank = rank;
      const multiscaleToViewTransform = new Float32Array(displayRank * rank);
      for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
        for (let displayDim = 0; displayDim < displayRank; ++displayDim) {
          multiscaleToViewTransform[displayRank * chunkDim + displayDim] =
            chunkDim === displayDim ? 1 : 0;
        }
      }
      return {
        displayRank,
        multiscaleToViewTransform,
        modelChannelDimensionIndices: [],
      };
    }

    handleVoxAction(action: string, _context: LayerActionContext): void {
      const firstContext = this.editingContexts.values().next()
        .value as VoxelEditingContext;
      if (!firstContext) return;
      switch (action) {
        case "undo":
          void firstContext.undo();
          break;
        case "redo":
          void firstContext.redo();
          break;
        case "randomize-paint-value":
          this.setVoxelPaintValue(randomUint64());
          break;
      }
    }
  }
  return C;
}
