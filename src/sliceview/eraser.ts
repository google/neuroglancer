import { clampAndRoundCoordinateToVoxelCenter } from "#src/coordinate_transform.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  makeToolActivationStatusMessage,
  registerTool,
  Tool,
} from "#src/ui/tool.js";
import { createToolCursor, updateCursorPosition } from "#src/util/cursor.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import { Signal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";

export interface ErasePoint {
  /** Spatial X-axis (OME X = last storage dim). */
  x: number;
  /** Spatial Y-axis. */
  y: number;
  /** Spatial Z-axis (OME Z = first non-T/C storage dim). */
  z: number;
}

export class EraserTool extends Tool<Viewer> {
  private eraserRadius: number = 1;

  // Stroke-level lifecycle signals — see BrushTool for the rationale.
  strokeStarted = new Signal<() => void>();
  strokeEnded = new Signal<() => void>();
  // New signal specifically for erase points data
  erasePointsChanged = new Signal<(erasePoints: ErasePoint[]) => void>();

  constructor(public viewer: Viewer) {
    super(viewer.toolBinder, true);
  }

  setEraserRadius(radius: number) {
    this.eraserRadius = radius;
  }

  activate(activation: ToolActivation<this>) {
    const { content } = makeToolActivationStatusMessage(activation);
    content.classList.add("neuroglancer-eraser-tool");

    // Override default viewer input events
    const eraserMap = EventActionMap.fromObject({
      all: {
        action: "eraser-block-default",
        stopPropagation: true,
        preventDefault: true,
      },
      "at:mousedown0": {
        action: "neuroglancer-eraser-erase",
        stopPropagation: true,
        preventDefault: true,
      },
      "at:mouseup0": {
        action: "neuroglancer-eraser-release",
        stopPropagation: true,
        preventDefault: true,
      },
    });

    this.viewer.inputEventBindings.sliceView.addParent(
      eraserMap,
      Number.POSITIVE_INFINITY,
    );

    activation.bindInputEventMap(eraserMap);
    activation.registerDisposer(() => {
      this.viewer.inputEventBindings.sliceView.removeParent(eraserMap);
    });

    const erase = () => {
      const selectedLayer = this.viewer.selectedLayer?.layer?.layer;
      if (!selectedLayer || !(selectedLayer instanceof SegmentationUserLayer))
        return;

      const mouseState = selectedLayer.manager.layerSelectedValues.mouseState;
      if (!mouseState) return;

      mouseState.updateUnconditionally();
      const { position } = mouseState;
      if (!position) return;

      const segmentationRenderLayer = selectedLayer.renderLayers.find(
        (layer) => layer instanceof SegmentationRenderLayer,
      );
      if (!segmentationRenderLayer) return;

      const pose = mouseState.pose;
      if (!pose) return;

      // The plane of the eraser circle will match the current orientation axes
      const orientation = pose.orientation.orientation;
      const viewMatrix = mat4.fromQuat(mat4.create(), orientation);

      const viewNormal = vec3.fromValues(
        viewMatrix[8],
        viewMatrix[9],
        viewMatrix[10],
      );
      vec3.normalize(viewNormal, viewNormal);

      const absNormal = [
        Math.abs(viewNormal[0]),
        Math.abs(viewNormal[1]),
        Math.abs(viewNormal[2]),
      ];
      const mainAxis = absNormal.indexOf(Math.max(...absNormal));

      const xAxis = vec3.create();
      const yAxis = vec3.create();

      const sign = Math.sign(viewNormal[mainAxis]);
      if (mainAxis === 0) {
        vec3.set(xAxis, 0, sign, 0);
        vec3.set(yAxis, 0, 0, sign);
      } else if (mainAxis === 1) {
        vec3.set(xAxis, sign, 0, 0);
        vec3.set(yAxis, 0, 0, sign);
      } else {
        vec3.set(xAxis, sign, 0, 0);
        vec3.set(yAxis, 0, sign, 0);
      }

      const erasePoints: ErasePoint[] = [];

      // Use canonicalVoxelFactors to keep the eraser circle on screen
      // matching its cursor. With anisotropic voxels (e.g. 5×5×30 nm)
      // a fixed dx/dy step iterates uneven distances per axis, which
      // is why the eraser looked elliptical on XZ/YZ planes.
      // canonicalVoxelFactors converts voxel steps to canonical voxel
      // distances per display dimension; mirror the brush's fix.
      const renderInfo = pose.displayDimensionRenderInfo.value;
      const { canonicalVoxelFactors, displayDimensionIndices } = renderInfo;

      let xDisplayDim = 0;
      let yDisplayDim = 0;
      for (let i = 0; i < 3; i++) {
        const globalDim = displayDimensionIndices[i];
        if (globalDim === -1) continue;
        if (xAxis[globalDim] !== 0) xDisplayDim = i;
        if (yAxis[globalDim] !== 0) yDisplayDim = i;
      }
      const xFactor = canonicalVoxelFactors[xDisplayDim];
      const yFactor = canonicalVoxelFactors[yDisplayDim];

      const xRange = Math.ceil(this.eraserRadius / xFactor);
      const yRange = Math.ceil(this.eraserRadius / yFactor);
      const radiusSq = this.eraserRadius * this.eraserRadius;

      for (let dx = -xRange; dx <= xRange; dx++) {
        for (let dy = -yRange; dy <= yRange; dy++) {
          const cx = dx * xFactor;
          const cy = dy * yFactor;
          if (cx * cx + cy * cy <= radiusSq) {
            const newPosition = vec3.fromValues(
              position[0],
              position[1],
              position[2],
            );

            vec3.scaleAndAdd(newPosition, newPosition, xAxis, dx);
            vec3.scaleAndAdd(newPosition, newPosition, yAxis, dy);

            const bounds =
              mouseState.pose?.position.coordinateSpace.value.bounds;

            if (bounds) {
              // Snap each coordinate to voxel center to avoid offset errors
              const x = clampAndRoundCoordinateToVoxelCenter(
                bounds,
                0,
                newPosition[0],
              );
              const y = clampAndRoundCoordinateToVoxelCenter(
                bounds,
                1,
                newPosition[1],
              );
              const z = clampAndRoundCoordinateToVoxelCenter(
                bounds,
                2,
                newPosition[2],
              );

              erasePoints.push({ x, y, z });
            }
          }
        }
      }

      // Emit the erase points via signal instead of directly accessing hash table
      if (erasePoints.length > 0) {
        this.erasePointsChanged.dispatch(erasePoints);
      }
    };

    activation.bindAction<MouseEvent>(
      "neuroglancer-eraser-erase",
      (actionEvent) => {
        actionEvent.stopPropagation();
        this.strokeStarted.dispatch();
        erase();

        startRelativeMouseDrag(actionEvent.detail, () => {
          erase();
        });
      },
    );

    activation.bindAction<MouseEvent>(
      "neuroglancer-eraser-release",
      (actionEvent) => {
        actionEvent.stopPropagation();
        this.strokeEnded.dispatch();
        this.changed.dispatch();
      },
    );

    const cursor = createToolCursor();
    cursor.style.backgroundColor = "rgba(255, 255, 255, 0.0)";

    let lastMouseEvent: MouseEvent;

    const handleMouseMove = (event: MouseEvent) => {
      lastMouseEvent = event;
      const mouseState = this.viewer.layerSelectedValues.mouseState;
      if (!mouseState.active) {
        cursor.style.display = "none";
        return;
      }
      cursor.style.display = "block";

      const zoom = this.viewer.navigationState.zoomFactor.value;

      updateCursorPosition(cursor, event, this.eraserRadius / zoom);
    };

    const zoomSubscription = this.viewer.navigationState.zoomFactor.changed.add(
      () => {
        handleMouseMove(lastMouseEvent);
      },
    );

    // mousemove only fires while the cursor is over the viewer canvas;
    // once it leaves (onto the sidebars / overlays / outside the
    // window), no more updates land and the circle would stay frozen
    // at its last position, painted over the sidebar via z-index 1000.
    // Hide on mouseleave and restore on mouseenter for symmetry.
    const handleMouseLeave = () => {
      cursor.style.display = "none";
    };
    const handleMouseEnter = (event: MouseEvent) => {
      handleMouseMove(event);
    };

    this.viewer.element.addEventListener("mousemove", handleMouseMove);
    this.viewer.element.addEventListener("mouseleave", handleMouseLeave);
    this.viewer.element.addEventListener("mouseenter", handleMouseEnter);

    activation.registerDisposer(() => {
      document.body.removeChild(cursor);
      this.viewer.element.removeEventListener("mousemove", handleMouseMove);
      this.viewer.element.removeEventListener("mouseleave", handleMouseLeave);
      this.viewer.element.removeEventListener("mouseenter", handleMouseEnter);
      zoomSubscription();
    });
  }

  get description() {
    return "eraser";
  }

  toJSON() {
    return {
      type: "eraser",
    };
  }
}

export function registerEraserToolForViewer(contextType: typeof Viewer) {
  registerTool(contextType, "eraser", (viewer) => new EraserTool(viewer));
}
