/**
 * /**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2021 Howard Hughes Medical Institute
 *
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

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  makeToolStatusContentWithHeader,
  registerTool,
  LayerTool,
} from "#src/ui/tool.js";
import type { RefCounted } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { EventActionMap, Modifiers } from "#src/util/event_action_map.js";
import { globalModifiers } from "#src/util/keyboard_bindings.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";

export const SELECT_SEGMENTS_TOOLS_ID = "selectSegments";

const selectEvent = "mousedown0";
const SELECT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  [`at:alt?+shift?+${selectEvent}`]: "drag-select-segments",
});

export enum SelectSegmentsMode {
  IDLE = 0,
  SELECT = 1,
  DESELECT = 2,
}

export class SelectSegmentsTool extends LayerTool<SegmentationUserLayer> {
  private mode_ = new WatchableValue(SelectSegmentsMode.IDLE);

  /**
   * The mode of the active drag. The value is `IDLE` when the tool is not
   * active or no drag is in progress.
   */
  get mode(): Readonly<WatchableValueInterface<SelectSegmentsMode>> {
    return this.mode_;
  }

  toJSON() {
    return SELECT_SEGMENTS_TOOLS_ID;
  }

  activate(activation: ToolActivation<this>) {
    const { layer, mode_: mode } = this;
    let currentState = SelectSegmentsMode.IDLE;
    let painting = false;
    activation.bindInputEventMap(SELECT_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      mode.value = SelectSegmentsMode.IDLE;
    });

    const getNewState = () => {
      return globalModifiers.value & Modifiers.ALT
        ? SelectSegmentsMode.DESELECT
        : SelectSegmentsMode.SELECT;
    };
    const setCurrentState = (state: SelectSegmentsMode) => {
      if (currentState !== state) {
        currentState = state;
        painting = false;
        // A drag can end after the activation ends.
        if (!activation.wasDisposed) {
          mode.value = state;
        }
      }
    };

    const trySelectSegment = () => {
      if (currentState === SelectSegmentsMode.IDLE) {
        return;
      }
      const { segmentSelectionState } = layer.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        const segment = segmentSelectionState.selectedSegment;
        const { selectedSegments, visibleSegments } =
          layer.displayState.segmentationGroupState.value;
        switch (currentState) {
          case SelectSegmentsMode.SELECT:
            selectedSegments.add(segment);
            visibleSegments.add(segment);
            break;
          case SelectSegmentsMode.DESELECT:
            selectedSegments.delete(segment);
            break;
        }
      }
    };

    activation.registerDisposer(
      layer.displayState.segmentSelectionState.changed.add(() => {
        if (painting) {
          trySelectSegment();
        }
      }),
    );
    activation.registerDisposer(
      globalModifiers.changed.add(() => {
        if (currentState !== SelectSegmentsMode.IDLE) {
          setCurrentState(getNewState());
        }
      }),
    );

    const startSelecting = (
      event: ActionEvent<MouseEvent>,
      state: SelectSegmentsMode,
    ) => {
      event.stopPropagation();
      setCurrentState(state);
      trySelectSegment();
      const baseScreenX = event.detail.screenX;
      const baseScreenY = event.detail.screenY;
      startRelativeMouseDrag(
        event.detail,
        (event, _deltaX, _deltaY) => {
          if (!painting) {
            const deltaScreenX = event.screenX - baseScreenX;
            const deltaScreenY = event.screenY - baseScreenY;
            if (
              deltaScreenX * deltaScreenX + deltaScreenY * deltaScreenY >
              25
            ) {
              trySelectSegment();
              painting = true;
            }
          }
        },
        (_event) => {
          painting = false;
          setCurrentState(SelectSegmentsMode.IDLE);
        },
      );
    };

    activation.bindAction(
      "drag-select-segments",
      (event: ActionEvent<MouseEvent>) => startSelecting(event, getNewState()),
    );
  }

  renderActivation(_activation: ToolActivation<this>, context: RefCounted) {
    const { layer, mode } = this;
    const { content, header, body } = makeToolStatusContentWithHeader();
    const updateStatus = () => {
      removeChildren(body);
      const msg = document.createElement("span");
      const currentState = mode.value;
      switch (currentState) {
        case SelectSegmentsMode.IDLE:
          header.textContent = "Select/Deselect segments";
          msg.textContent = `${selectEvent} to select segments; alt+${selectEvent} to deselect segments.`;
          break;
        case SelectSegmentsMode.SELECT:
        case SelectSegmentsMode.DESELECT:
          header.textContent = `${
            currentState === SelectSegmentsMode.SELECT ? "Select" : "Deselect"
          } segments`;
          msg.textContent = `Drag to ${
            currentState === SelectSegmentsMode.SELECT ? "select" : "deselect"
          } segments (${
            layer.displayState.segmentationGroupState.value.visibleSegments.size
          } selected).`;
      }
      body.appendChild(msg);
    };
    updateStatus();
    context.registerDisposer(mode.changed.add(updateStatus));
    context.registerDisposer(
      layer.displayState.segmentationGroupState.value.visibleSegments.changed.add(
        updateStatus,
      ),
    );
    return content;
  }

  get description() {
    return "select";
  }
}

export function registerSegmentSelectTools(
  contextType: typeof SegmentationUserLayer,
) {
  registerTool(contextType, SELECT_SEGMENTS_TOOLS_ID, (layer) => {
    return new SelectSegmentsTool(layer);
  });
}
