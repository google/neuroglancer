import { WatchableValue } from "#src/trackable_value.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
    makeToolActivationStatusMessage,
    registerTool,
    Tool,
} from "#src/ui/tool.js";
import { createToolCursor, updateCursorPosition } from "#src/util/cursor.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { vec3 } from "#src/util/geom.js";
import { Signal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";

export enum PointType {
    POSITIVE = 'positive',
    NEGATIVE = 'negative'
}

export interface Point {
    position: vec3;
    pointType: PointType;
}

export class PointTool extends Tool<Viewer> {
    pointSignal = new Signal<(point: Point | null) => void>();
    pointType = new WatchableValue<PointType>(PointType.POSITIVE);

    constructor(public viewer: Viewer) {
        super(viewer.toolBinder, true);
    }

    activate(activation: ToolActivation<this>) {
        console.log("activate point tool")
        const { content } = makeToolActivationStatusMessage(activation);
        content.classList.add("neuroglancer-point-tool");

        // Override default viewer input events
        const pointMap = EventActionMap.fromObject({
            all: {
                action: "point-block-default",
                stopPropagation: true,
                preventDefault: true,
            },
            "at:mousedown0": {
                action: "neuroglancer-point-click",
                stopPropagation: true,
                preventDefault: true,
            }
        });

        this.viewer.inputEventBindings.sliceView.addParent(
            pointMap,
            Number.POSITIVE_INFINITY,
        );

        activation.bindInputEventMap(pointMap);
        activation.registerDisposer(() => {
            this.viewer.inputEventBindings.sliceView.removeParent(pointMap);
        });

        activation.bindAction<MouseEvent>(
            "neuroglancer-point-click",
            (actionEvent) => {
                actionEvent.stopPropagation();

                const mouseState = this.viewer.mouseState;
                if (!mouseState) return;

                mouseState.updateUnconditionally();
                const { position } = mouseState;
                const roundedPosition = vec3.fromValues(
                    Math.round(position[0]),
                    Math.round(position[1]),
                    Math.round(position[2])
                );
                if (!position) return;

                console.log("Setting point position at", roundedPosition, this.pointType);
                // Dispatch with the point data
                this.pointSignal.dispatch({
                    position: roundedPosition,
                    pointType: this.pointType.value
                });
            },
        );

        const cursor = createToolCursor();
        cursor.style.backgroundColor = "rgba(255, 255, 255, 0.0)";
        cursor.style.border = "2px solid rgba(0, 255, 0, 0.8)"; // Green for positive by default

        let lastMouseEvent: MouseEvent;

        const handleMouseMove = (event: MouseEvent) => {
            lastMouseEvent = event;
            const mouseState = this.viewer.layerSelectedValues.mouseState;
            if (!mouseState.active) {
                cursor.style.display = "none";
                return;
            }
            cursor.style.display = "block";

            // Update cursor color based on point type
            if (this.pointType.value === PointType.POSITIVE) {
                cursor.style.border = "2px solid rgba(0, 255, 0, 0.8)"; // Green for positive
            } else {
                cursor.style.border = "2px solid rgba(255, 0, 0, 0.8)"; // Red for negative
            }

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

    setPointType(pointType: PointType) {
        this.pointType.value = pointType;
        console.log("Switched point type to", pointType);
    }

    get description() {
        return "pointTool";
    }

    toJSON() {
        return {
            type: "pointTool",
        };
    }
}

export function registerPointToolForViewer(contextType: typeof Viewer) {
    registerTool(contextType, "pointTool", (viewer) => new PointTool(viewer));
}