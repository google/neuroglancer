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

export const SELECT_SEGMENTS_TOOLS_ID = 'selectSegments';
export const DESELECT_SEGMENTS_TOOLS_ID = 'deselectSegments';

export class SelectSegmentsTool extends Tool<SegmentationUserLayer>
{
  constructor(layer: SegmentationUserLayer, private selecting: boolean) {
    super(layer);
  }

  toJSON() {
    return this.selecting ? SELECT_SEGMENTS_TOOLS_ID : DESELECT_SEGMENTS_TOOLS_ID;
  }

  activate(activation: ToolActivation<this>) {
    const {layer} = this;
    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = `${this.selecting ? 'Select' : 'Deselect'} segments`;
    const updateStatus = () => {
      removeChildren(body);
      const msg = document.createElement('span');
      msg.textContent = `Move mouse to ${this.selecting ? 'select' : 'deselect'} segments`;
      body.appendChild(msg);
    };
    updateStatus();

    const trySelectSegment = () => {
      console.log(layer.displayState.segmentSelectionState);
      const {segmentSelectionState} = layer.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        const segment = segmentSelectionState.selectedSegment;
        const {visibleSegments} = layer.displayState.segmentationGroupState.value;
        if (visibleSegments.has(segment)) {
          if (!this.selecting) {
            visibleSegments.delete(segment);
          }
        } else if (this.selecting) {
          visibleSegments.add(segment);
        }
      }
    }
    activation.registerDisposer(layer.displayState.segmentSelectionState.changed.add(trySelectSegment));
  }

  get description() {
    return this.selecting ? 'select' : 'deselect';
  }
}

export function registerSegmentSelectTools() {
  registerLayerTool(SegmentationUserLayer, SELECT_SEGMENTS_TOOLS_ID, layer => {
    return new SelectSegmentsTool(layer, true);
  });
  registerLayerTool(SegmentationUserLayer, DESELECT_SEGMENTS_TOOLS_ID, layer => {
    return new SelectSegmentsTool(layer, false);
  });
}
