import type { ToolActivation } from "#src/ui/tool.js";
import {
  makeToolActivationStatusMessage,
  registerTool,
  Tool,
} from "#src/ui/tool.js";
import { createToolCursor, updateCursorPosition } from "#src/util/cursor.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { vec3 } from "#src/util/geom.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import { Signal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";

export class BoundingBoxTool extends Tool<Viewer> {
  bboxChanged = new Signal<(bbox: { start: vec3 | null, end: vec3 | null } | null) => void>();

  constructor(public viewer: Viewer) {
    super(viewer.toolBinder, true);
  }

  activate(activation: ToolActivation<this>) {
    const { content } = makeToolActivationStatusMessage(activation);
    content.classList.add("neuroglancer-bbox-tool");

    // Override default viewer input events
    const bboxMap = EventActionMap.fromObject({
      all: {
        action: "bbox-block-default",
        stopPropagation: true,
        preventDefault: true,
      },
      "at:mousedown0": {
        action: "neuroglancer-bbox-start",
        stopPropagation: true,
        preventDefault: true,
      },
      "at:mouseup0": {
        action: "neuroglancer-bbox-end",
        stopPropagation: true,
        preventDefault: true,
      }
    });

    this.viewer.inputEventBindings.sliceView.addParent(
      bboxMap,
      Number.POSITIVE_INFINITY,
    );

    activation.bindInputEventMap(bboxMap);
    activation.registerDisposer(() => {
      this.viewer.inputEventBindings.sliceView.removeParent(bboxMap);
    });

    const updatePosition = (startPosition: vec3) => {
      const mouseState = this.viewer.mouseState;
      if (!mouseState) return;

      mouseState.updateUnconditionally();
      const { position } = mouseState;
      if (!position) return;

      const roundedPosition = vec3.fromValues(
        Math.round(position[0]),
        Math.round(position[1]),
        Math.round(position[2])
      );
      this.bboxChanged.dispatch({
        start: startPosition,
        end: roundedPosition
      });
    };

    activation.bindAction<MouseEvent>(
      "neuroglancer-bbox-start",
      (actionEvent) => {
        actionEvent.stopPropagation();

        const mouseState = this.viewer.mouseState;
        if (!mouseState) return;

        mouseState.updateUnconditionally();
        const { position } = mouseState;
        if (!position) return;

        const roundedPosition = vec3.fromValues(
          Math.round(position[0]),
          Math.round(position[1]),
          Math.round(position[2])
        );
        startRelativeMouseDrag(actionEvent.detail, () => {
          updatePosition(roundedPosition);
        });
      },
    );

    activation.bindAction<MouseEvent>(
      "neuroglancer-bbox-end",
      (actionEvent) => {
        actionEvent.stopPropagation();
        this.changed.dispatch();
      },
    );

    const cursor = createToolCursor();
    cursor.style.backgroundColor = "rgba(255, 255, 255, 0.0)";
    cursor.style.border = "2px solid rgba(255, 255, 0, 0.8)";

    let lastMouseEvent: MouseEvent;

    const handleMouseMove = (event: MouseEvent) => {
      lastMouseEvent = event;
      const mouseState = this.viewer.layerSelectedValues.mouseState;
      if (!mouseState.active) {
        cursor.style.display = "none";
        return;
      }
      cursor.style.display = "block";

      updateCursorPosition(cursor, event, 5);
    };

    const zoomSubscription = this.viewer.navigationState.zoomFactor.changed.add(
      () => {
        if (lastMouseEvent) handleMouseMove(lastMouseEvent);
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
    return "boundingBox";
  }

  toJSON() {
    return {
      type: "boundingBox",
    };
  }
}

export function registerBoundingBoxToolForViewer(contextType: typeof Viewer) {
  registerTool(contextType, "boundingBox", (viewer) => new BoundingBoxTool(viewer));
}