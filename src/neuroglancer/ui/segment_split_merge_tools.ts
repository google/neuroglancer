/**
 * @license
 * Copyright 2020 Google Inc.
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

import './segment_split_merge_tools.css';

import {augmentSegmentId, bindSegmentListWidth, makeSegmentWidget, registerCallbackWhenSegmentationDisplayStateChanged, resetTemporaryVisibleSegmentsState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {isBaseSegmentId} from 'neuroglancer/segmentation_graph/source';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {StatusMessage} from 'neuroglancer/status';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {makeToolActivationStatusMessageWithHeader, registerLayerTool, Tool, ToolActivation} from 'neuroglancer/ui/tool';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {removeChildren} from 'neuroglancer/util/dom';
import {EventActionMap} from 'neuroglancer/util/keyboard_bindings';
import {Uint64} from 'neuroglancer/util/uint64';

export const ANNOTATE_MERGE_SEGMENTS_TOOL_ID = 'mergeSegments';
export const ANNOTATE_SPLIT_SEGMENTS_TOOL_ID = 'splitSegments';

const MERGE_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'merge-segments'},
  'at:shift?+mousedown2': {action: 'set-anchor'},
});

const SPLIT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+mousedown0': {action: 'split-segments'},
  'at:shift?+mousedown2': {action: 'set-anchor'},
});

export class MergeSegmentsTool extends Tool<SegmentationUserLayer> {
  lastAnchorBaseSegment = new WatchableValue<Uint64|undefined>(undefined);

  constructor(layer: SegmentationUserLayer) {
    super(layer);

    // Track the most recent base segment id within anchorSegment.
    const maybeUpdateLastAnchorBaseSegment = () => {
      const anchorSegment = layer.anchorSegment.value;
      if (anchorSegment === undefined) return;
      const {segmentSelectionState} = layer.displayState;
      if (!segmentSelectionState.hasSelectedSegment) return;
      const {segmentEquivalences} = layer.displayState.segmentationGroupState.value;
      const mappedAnchorSegment = segmentEquivalences.get(anchorSegment);
      if (!Uint64.equal(segmentSelectionState.selectedSegment, mappedAnchorSegment)) return;
      const base = segmentSelectionState.baseSelectedSegment;
      if (segmentEquivalences.disjointSets.highBitRepresentative.value && !isBaseSegmentId(base)) {
        return;
      }
      this.lastAnchorBaseSegment.value = base.clone();
    };
    this.registerDisposer(
        layer.displayState.segmentSelectionState.changed.add(maybeUpdateLastAnchorBaseSegment));
    this.registerDisposer(layer.anchorSegment.changed.add(maybeUpdateLastAnchorBaseSegment));
  }

  toJSON() {
    return ANNOTATE_MERGE_SEGMENTS_TOOL_ID;
  }
  activate(activation: ToolActivation<this>) {
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = this.layer.displayState.segmentationGroupState.value;

    const getAnchorSegment = (): {anchorSegment: Uint64|undefined, error: string|undefined} => {
      let anchorSegment = this.layer.anchorSegment.value;
      let baseAnchorSegment = this.lastAnchorBaseSegment.value;
      if (anchorSegment === undefined) {
        return {anchorSegment: undefined, error: 'Select anchor segment for merge'};
      }
      const anchorGraphSegment = segmentationGroupState.segmentEquivalences.get(anchorSegment);
      if (!segmentationGroupState.visibleSegments.has(anchorGraphSegment)) {
        return {anchorSegment, error: 'Anchor segment must be in visible set'};
      }
      if (baseAnchorSegment === undefined ||
          !Uint64.equal(
              segmentationGroupState.segmentEquivalences.get(baseAnchorSegment),
              anchorGraphSegment)) {
        return {
          anchorSegment,
          error: 'Hover over base segment within anchor segment that is closest to merge location'
        };
      }
      return {anchorSegment: baseAnchorSegment, error: undefined};
    };

    const getMergeRequest = (): {
      anchorSegment: Uint64|undefined,
      otherSegment: Uint64|undefined,
      anchorSegmentValid: boolean,
      error: string|undefined
    } => {
      let {anchorSegment, error} = getAnchorSegment();
      if (anchorSegment === undefined || error !== undefined) {
        return {anchorSegment, error, otherSegment: undefined, anchorSegmentValid: false};
      }
      const {displayState} = this.layer;
      const otherSegment = displayState.segmentSelectionState.baseValue;
      if (otherSegment === undefined ||
          Uint64.equal(
              displayState.segmentSelectionState.selectedSegment,
              segmentationGroupState.segmentEquivalences.get(anchorSegment))) {
        return {
          anchorSegment,
          otherSegment: undefined,
          error: 'Hover over segment to merge',
          anchorSegmentValid: true
        };
      }
      return {anchorSegment, otherSegment, error: undefined, anchorSegmentValid: true};
    };

    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = 'Merge segments';
    body.classList.add('neuroglancer-merge-segments-status');
    activation.bindInputEventMap(MERGE_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
    });
    const updateStatus = () => {
      removeChildren(body);
      const {displayState} = this.layer;
      let {anchorSegment, otherSegment, anchorSegmentValid, error} = getMergeRequest();
      const makeWidget = (id: Uint64MapEntry) => {
        const row = makeSegmentWidget(this.layer.displayState, id);
        row.classList.add('neuroglancer-segment-list-entry-double-line');
        return row;
      };
      if (anchorSegment !== undefined) {
        body.appendChild(makeWidget(augmentSegmentId(displayState, anchorSegment)));
      }
      if (error !== undefined) {
        const msg = document.createElement('span');
        msg.textContent = error;
        body.appendChild(msg);
      }
      if (otherSegment !== undefined) {
        const msg = document.createElement('span');
        msg.textContent = ' merge ';
        body.appendChild(msg);
        body.appendChild(makeWidget(augmentSegmentId(displayState, otherSegment)));
      }
      const {segmentEquivalences} = segmentationGroupState;
      if (!anchorSegmentValid) {
        resetTemporaryVisibleSegmentsState(segmentationGroupState);
        return;
      } else {
        segmentationGroupState.useTemporaryVisibleSegments.value = true;
        const tempVisibleSegments = segmentationGroupState.temporaryVisibleSegments;
        tempVisibleSegments.clear();
        tempVisibleSegments.add(segmentEquivalences.get(anchorSegment!));
        if (otherSegment !== undefined) {
          tempVisibleSegments.add(segmentEquivalences.get(otherSegment));
        }
      }
    };
    updateStatus();
    activation.registerDisposer(bindSegmentListWidth(this.layer.displayState, body));
    const debouncedUpdateStatus =
        activation.registerCancellable(animationFrameDebounce(updateStatus));
    registerCallbackWhenSegmentationDisplayStateChanged(
        this.layer.displayState, activation, debouncedUpdateStatus);
    activation.registerDisposer(this.layer.anchorSegment.changed.add(debouncedUpdateStatus));
    activation.registerDisposer(this.lastAnchorBaseSegment.changed.add(debouncedUpdateStatus));
    activation.bindAction('merge-segments', event => {
      event.stopPropagation();
      (async () => {
        const {graph: {value: graph}} = segmentationGroupState;
        if (graph === undefined) return;
        const {anchorSegment, otherSegment, error} = getMergeRequest();
        if (anchorSegment === undefined || otherSegment === undefined || error !== undefined) {
          return;
        }
        try {
          await graph.merge(anchorSegment, otherSegment);
          StatusMessage.showTemporaryMessage(`Merge performed`);
        } catch (e) {
          StatusMessage.showTemporaryMessage(`Merge failed: ${e}`);
        }
      })()
    });
    activation.bindAction('set-anchor', event => {
      event.stopPropagation();
      const {segmentSelectionState} = this.layer.displayState;
      const other = segmentSelectionState.baseValue;
      if (other === undefined) return;
      const existingAnchor = this.layer.anchorSegment.value;
      segmentationGroupState.visibleSegments.add(other);
      if (existingAnchor === undefined || !Uint64.equal(existingAnchor, other)) {
        this.layer.anchorSegment.value = other.clone();
        return;
      }
    });
  }

  get description() {
    return 'merge';
  }
}

export class SplitSegmentsTool extends Tool<SegmentationUserLayer> {
  toJSON() {
    return ANNOTATE_SPLIT_SEGMENTS_TOOL_ID;
  }

  activate(activation: ToolActivation<this>) {
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = this.layer.displayState.segmentationGroupState.value;

    const getAnchorSegment = (): {anchorSegment: Uint64|undefined, error: string|undefined} => {
      let anchorSegment = this.layer.anchorSegment.value;
      if (anchorSegment === undefined) {
        return {anchorSegment: undefined, error: 'Select anchor segment for split'};
      }
      const anchorGraphSegment = segmentationGroupState.segmentEquivalences.get(anchorSegment);
      if (!segmentationGroupState.visibleSegments.has(anchorGraphSegment)) {
        return {anchorSegment, error: 'Anchor segment must be in visible set'};
      }
      return {anchorSegment, error: undefined};
    };

    const {body, header} = makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = 'Split segments';
    body.classList.add('neuroglancer-merge-segments-status');
    activation.bindInputEventMap(SPLIT_SEGMENTS_INPUT_EVENT_MAP);
    const getSplitRequest = (): {
      anchorSegment: Uint64|undefined,
      otherSegment: Uint64|undefined,
      anchorSegmentValid: boolean,
      error: string|undefined
    } => {
      let {anchorSegment, error} = getAnchorSegment();
      if (anchorSegment === undefined || error !== undefined) {
        return {anchorSegment, error, otherSegment: undefined, anchorSegmentValid: false};
      }
      const {displayState} = this.layer;
      const otherSegment = displayState.segmentSelectionState.baseValue;
      if (otherSegment === undefined ||
          !Uint64.equal(
              displayState.segmentSelectionState.selectedSegment,
              segmentationGroupState.segmentEquivalences.get(anchorSegment)) ||
          Uint64.equal(otherSegment, anchorSegment)) {
        return {
          anchorSegment,
          otherSegment: undefined,
          anchorSegmentValid: true,
          error: 'Hover over base segment to seed split'
        };
      }
      return {anchorSegment, otherSegment, anchorSegmentValid: true, error: undefined};
    };
    activation.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
    });
    const updateStatus = () => {
      removeChildren(body);
      const {displayState} = this.layer;
      let {anchorSegment, otherSegment, anchorSegmentValid, error} = getSplitRequest();
      let anchorSegmentAugmented: Uint64MapEntry|undefined;
      let otherSegmentAugmented: Uint64MapEntry|undefined;
      const updateTemporaryState = () => {
        const {segmentEquivalences} = segmentationGroupState;
        const {graphConnection} = this.layer;
        if (!anchorSegmentValid || graphConnection === undefined) {
          resetTemporaryVisibleSegmentsState(segmentationGroupState);
          return;
        } else {
          segmentationGroupState.useTemporaryVisibleSegments.value = true;
          if (otherSegment !== undefined) {
            const splitResult = graphConnection.computeSplit(anchorSegment!, otherSegment);
            if (splitResult !== undefined) {
              anchorSegmentAugmented =
                  new Uint64MapEntry(anchorSegment!, splitResult.includeRepresentative);
              otherSegmentAugmented =
                  new Uint64MapEntry(otherSegment, splitResult.excludeRepresentative);
              segmentationGroupState.useTemporarySegmentEquivalences.value = true;
              const retainedGraphSegment = splitResult.includeRepresentative;
              const excludedGraphSegment = splitResult.excludeRepresentative;
              const tempEquivalences = segmentationGroupState.temporarySegmentEquivalences;
              tempEquivalences.clear();
              for (const segment of splitResult.includeBaseSegments) {
                tempEquivalences.link(segment, retainedGraphSegment);
              }
              for (const segment of splitResult.excludeBaseSegments) {
                tempEquivalences.link(segment, excludedGraphSegment);
              }
              const tempVisibleSegments = segmentationGroupState.temporaryVisibleSegments;
              tempVisibleSegments.clear();
              tempVisibleSegments.add(retainedGraphSegment);
              tempVisibleSegments.add(excludedGraphSegment);
              return;
            }
          }
          segmentationGroupState.useTemporarySegmentEquivalences.value = false;
          const tempVisibleSegments = segmentationGroupState.temporaryVisibleSegments;
          tempVisibleSegments.clear();
          tempVisibleSegments.add(segmentEquivalences.get(anchorSegment!));
        }
      };
      updateTemporaryState();
      const makeWidget = (id: Uint64MapEntry) => {
        const row = makeSegmentWidget(this.layer.displayState, id);
        row.classList.add('neuroglancer-segment-list-entry-double-line');
        return row;
      };
      if (anchorSegment !== undefined) {
        body.appendChild(
            makeWidget(anchorSegmentAugmented ?? augmentSegmentId(displayState, anchorSegment)));
      }
      if (error !== undefined) {
        const msg = document.createElement('span');
        msg.textContent = error;
        body.appendChild(msg);
      }
      if (otherSegmentAugmented !== undefined) {
        const msg = document.createElement('span');
        msg.textContent = ' split ';
        body.appendChild(msg);
        body.appendChild(makeWidget(otherSegmentAugmented));
      }
    };
    activation.registerDisposer(bindSegmentListWidth(this.layer.displayState, body));
    updateStatus();
    const debouncedUpdateStatus =
        activation.registerCancellable(animationFrameDebounce(updateStatus));
    registerCallbackWhenSegmentationDisplayStateChanged(
        this.layer.displayState, activation, debouncedUpdateStatus);
    activation.registerDisposer(this.layer.anchorSegment.changed.add(debouncedUpdateStatus));

    activation.bindAction('split-segments', event => {
      event.stopPropagation();
      (async () => {
        const {graph: {value: graph}} = segmentationGroupState;
        if (graph === undefined) return;
        const {anchorSegment, otherSegment, error} = getSplitRequest();
        if (anchorSegment === undefined || otherSegment === undefined || error !== undefined) {
          return;
        }
        try {
          await graph.split(anchorSegment, otherSegment);
          StatusMessage.showTemporaryMessage(`Split performed`);
        } catch (e) {
          StatusMessage.showTemporaryMessage(`Split failed: ${e}`);
        }
      })();
    });
    activation.bindAction('set-anchor', event => {
      event.stopPropagation();
      const {segmentSelectionState} = this.layer.displayState;
      const other = segmentSelectionState.baseValue;
      if (other === undefined) return;
      segmentationGroupState.visibleSegments.add(other);
      const existingAnchor = this.layer.anchorSegment.value;
      if (existingAnchor === undefined || !Uint64.equal(existingAnchor, other)) {
        this.layer.anchorSegment.value = other.clone();
        return;
      }
    });
  }

  get description() {
    return `split`;
  }
}

export function registerSegmentSplitMergeTools() {
  registerLayerTool(SegmentationUserLayer, ANNOTATE_MERGE_SEGMENTS_TOOL_ID, layer => {
    return new MergeSegmentsTool(layer);
  });

  registerLayerTool(SegmentationUserLayer, ANNOTATE_SPLIT_SEGMENTS_TOOL_ID, layer => {
    return new SplitSegmentsTool(layer);
  });
}
