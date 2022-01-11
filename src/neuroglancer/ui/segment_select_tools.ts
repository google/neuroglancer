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
import {EventActionMap} from 'neuroglancer/util/event_action_map';

export const SELECT_SEGMENTS_TOOLS_ID = 'selectSegments';

const selectEvent = 'mousedown0';
const deselectEvent = 'mousedown2';
const SELECT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  [`at:shift?+${selectEvent}`]: 'drag-select-segments',
  [`at:shift?+${deselectEvent}`]: 'drag-deselect-segments',
  'at:shift?+mouseup0': 'deactivate-drag-select-segments',
  'at:shift?+mouseup2': 'deactivate-drag-deselect-segments',
});

enum ToolState {
  IGNORE,
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
    let state = ToolState.IGNORE;
    activation.bindInputEventMap(SELECT_SEGMENTS_INPUT_EVENT_MAP);
    const updateStatus = () => {
      removeChildren(body);
      const msg = document.createElement('span');
      switch (state) {
        case ToolState.IGNORE:
          header.textContent = 'Select/Deselect segments';
          msg.textContent = `${selectEvent} to select segments; ${deselectEvent} to deselect segments.`;
          break;
        case ToolState.SELECT:
        case ToolState.DESELECT:
          header.textContent = `${state == ToolState.SELECT ? 'select' : 'deselect'} segments`;
          msg.textContent = `Drag to ${state == ToolState.SELECT ? 'select' : 'deselect'} segments (${layer.displayState.segmentationGroupState.value.visibleSegments.size} selected).`;
      }
      body.appendChild(msg);
    };
    updateStatus();

    const trySelectSegment = () => {
      if (state == ToolState.IGNORE) {
        return;
      }
      const {segmentSelectionState} = layer.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        const segment = segmentSelectionState.selectedSegment;
        const {visibleSegments} = layer.displayState.segmentationGroupState.value;
        switch (state) {
          case ToolState.SELECT:
            visibleSegments.add(segment);
            break;
          case ToolState.DESELECT:
            visibleSegments.delete(segment);
            break;
        }
      }
    };

    const startSelecting = () => {
      updateStatus();
      trySelectSegment();
      activation.registerDisposer(
        layer.displayState.segmentSelectionState.changed.add(trySelectSegment));
      activation.registerDisposer(
        layer.displayState.segmentationGroupState.value.visibleSegments.changed.add(updateStatus));
    };

    activation.bindAction('drag-select-segments', event => {
      event.stopPropagation();
      state = ToolState.SELECT;
      startSelecting();
    });
    activation.bindAction('drag-deselect-segments', event => {
      event.stopPropagation();
      state = ToolState.DESELECT;
      startSelecting();
    });
    activation.bindAction('deactivate-drag-select-segments', event => {
      event.stopPropagation();
      if (state == ToolState.SELECT) {
        state = ToolState.IGNORE;
        updateStatus();
      }
    });
    activation.bindAction('deactivate-drag-deselect-segments', event => {
      event.stopPropagation();
      if (state == ToolState.DESELECT) {
        state = ToolState.IGNORE;
        updateStatus();
      }
    });

    activation.registerDisposer(() => {
      state = ToolState.IGNORE;
    });
  }

  get description() {
    return 'select/deselect segments';
  }
}

export function registerSegmentSelectTools() {
  registerLayerTool(SegmentationUserLayer, SELECT_SEGMENTS_TOOLS_ID, layer => {
    return new SelectSegmentsTool(layer);
  });
}
