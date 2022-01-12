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

import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {removeChildren} from 'neuroglancer/util/dom';
import {makeToolActivationStatusMessageWithHeader, registerLayerTool, Tool, ToolActivation} from 'neuroglancer/ui/tool';
import {ActionEvent, EventActionMap, Modifiers} from 'neuroglancer/util/event_action_map';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {globalModifiers} from 'neuroglancer/util/keyboard_bindings';

export const SELECT_SEGMENTS_TOOLS_ID = 'selectSegments';

const selectEvent = 'mousedown0';
const SELECT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  [`at:alt?+shift?+${selectEvent}`]: 'drag-select-segments',
});

enum ToolState {
  IDLE,
  SELECT,
  DESELECT,
};

export class SelectSegmentsTool extends Tool<SegmentationUserLayer> {
  constructor(layer: SegmentationUserLayer) {
    super(layer);
  }

  toJSON() {
    return SELECT_SEGMENTS_TOOLS_ID;
  }

  activate(activation: ToolActivation<this>) {
    const {layer} = this;
    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    let currentState = ToolState.IDLE;
    let painting = false;
    activation.bindInputEventMap(SELECT_SEGMENTS_INPUT_EVENT_MAP);

    const getNewState = () => {
      return (globalModifiers.value & Modifiers.ALT) ? ToolState.DESELECT : ToolState.SELECT;
    };
    const setCurrentState = (state: ToolState) => {
      if (currentState !== state) {
        currentState = state;
        painting = false;
        updateStatus();
      }
    };

    const updateStatus = () => {
      removeChildren(body);
      const msg = document.createElement('span');
      switch (currentState) {
        case ToolState.IDLE:
          header.textContent = 'Select/Deselect segments';
          msg.textContent = `${selectEvent} to select segments; alt+${selectEvent} to deselect segments.`;
          break;
        case ToolState.SELECT:
        case ToolState.DESELECT:
          header.textContent = `${currentState == ToolState.SELECT ? 'Select' : 'Deselect'} segments`;
          msg.textContent = `Drag to ${currentState == ToolState.SELECT ? 'select' : 'deselect'} segments (${layer.displayState.segmentationGroupState.value.visibleSegments.size} selected).`;
      }
      body.appendChild(msg);
    };
    updateStatus();

    const trySelectSegment = () => {
      if (currentState == ToolState.IDLE) {
        return;
      }
      const {segmentSelectionState} = layer.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        const segment = segmentSelectionState.selectedSegment;
        const {visibleSegments} = layer.displayState.segmentationGroupState.value;
        switch (currentState) {
          case ToolState.SELECT:
            visibleSegments.add(segment);
            break;
          case ToolState.DESELECT:
            visibleSegments.delete(segment);
            break;
        }
      }
    };

    activation.registerDisposer(
      layer.displayState.segmentSelectionState.changed.add(() => {
        if (painting) {
          trySelectSegment();
        }
      }));
    activation.registerDisposer(
      layer.displayState.segmentationGroupState.value.visibleSegments.changed.add(updateStatus));
    activation.registerDisposer(
      globalModifiers.changed.add(() => {
        if (currentState != ToolState.IDLE) {
          setCurrentState(getNewState());
        }
      }));

    const startSelecting = (event: ActionEvent<MouseEvent>, state: ToolState) => {
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
            if (deltaScreenX * deltaScreenX + deltaScreenY * deltaScreenY > 25) {
              trySelectSegment();
              painting = true;
            }
          }
        },
        (_event) => {
          painting = false;
          setCurrentState(ToolState.IDLE);
        }
      );
    };

    activation.bindAction('drag-select-segments', (event: ActionEvent<MouseEvent>) =>  startSelecting(event, getNewState()));
  }

  get description() {
    return 'select';
  }
}

export function registerSegmentSelectTools() {
  registerLayerTool(SegmentationUserLayer, SELECT_SEGMENTS_TOOLS_ID, layer => {
    return new SelectSegmentsTool(layer);
  });
}
