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
import type { Viewer } from "#src/viewer.js";

export class EraserTool extends Tool<Viewer> {
  private eraserRadius: number = 1;

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
      }
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

      for (let dx = -this.eraserRadius; dx <= this.eraserRadius; dx++) {
        for (let dy = -this.eraserRadius; dy <= this.eraserRadius; dy++) {
          if (dx * dx + dy * dy <= this.eraserRadius * this.eraserRadius) {
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

              segmentationRenderLayer.brushHashTable.deleteBrushPoint(x, y, z);
            }
          }
        }
      }
      segmentationRenderLayer.redrawNeeded.dispatch();
    };

    activation.bindAction<MouseEvent>(
      "neuroglancer-eraser-erase",
      (actionEvent) => {
        actionEvent.stopPropagation();
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
        // could build undo mechanism here
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

    this.viewer.element.addEventListener("mousemove", handleMouseMove);

    activation.registerDisposer(() => {
      document.body.removeChild(cursor);
      this.viewer.element.removeEventListener("mousemove", handleMouseMove);
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
