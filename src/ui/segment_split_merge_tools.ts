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

import "#src/ui/segment_split_merge_tools.css";

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import {
  augmentSegmentId,
  bindSegmentListWidth,
  makeSegmentWidget,
  registerCallbackWhenSegmentationDisplayStateChanged,
  resetTemporaryVisibleSegmentsState,
  Uint64MapEntry,
} from "#src/segmentation_display_state/frontend.js";
import {
  isBaseSegmentId,
  VisibleSegmentEquivalencePolicy,
} from "#src/segmentation_graph/segment_id.js";
import { StatusMessage } from "#src/status.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolStatusContentWithHeader,
  registerTool,
} from "#src/ui/tool.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { RefCounted } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import { EventActionMap } from "#src/util/keyboard_bindings.js";

export const ANNOTATE_MERGE_SEGMENTS_TOOL_ID = "mergeSegments";
export const ANNOTATE_SPLIT_SEGMENTS_TOOL_ID = "splitSegments";

const MERGE_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+mousedown0": { action: "merge-segments" },
  "at:shift?+mousedown2": { action: "set-anchor" },
});

const SPLIT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+mousedown0": { action: "split-segments" },
  "at:shift?+alt+mousedown0": { action: "split-and-select-segments" },
  "at:shift?+mousedown2": { action: "set-anchor" },
});

/**
 * The status of an active merge or split tool.
 */
export interface SegmentPairToolStatus {
  /**
   * The anchor segment. For a merge with a valid anchor, the value is the base
   * segment of the anchor that was last under the pointer. For a split that
   * the graph can compute, the value holds the part that stays.
   */
  anchorSegment: Uint64MapEntry | undefined;
  /**
   * The segment to merge with the anchor segment. For a split, the value holds
   * the excluded part, and only when the graph can compute the split.
   */
  otherSegment: Uint64MapEntry | undefined;
  /**
   * The reason that the tool cannot merge or split now.
   */
  error: string | undefined;
}

function segmentEntriesEqual(
  a: Uint64MapEntry | undefined,
  b: Uint64MapEntry | undefined,
) {
  if (a === undefined || b === undefined) return a === b;
  return a.key === b.key && a.value === b.value && a.label === b.label;
}

// Write the status only when it changes. Then a listener gets no change event
// for a value that it already has.
function setSegmentPairToolStatus(
  status: WatchableValue<SegmentPairToolStatus | undefined>,
  value: SegmentPairToolStatus | undefined,
) {
  const current = status.value;
  if (
    current !== undefined &&
    value !== undefined &&
    segmentEntriesEqual(current.anchorSegment, value.anchorSegment) &&
    segmentEntriesEqual(current.otherSegment, value.otherSegment) &&
    current.error === value.error
  ) {
    return;
  }
  status.value = value;
}

function renderSegmentPairToolStatus(
  layer: SegmentationUserLayer,
  status: Readonly<WatchableValueInterface<SegmentPairToolStatus | undefined>>,
  context: RefCounted,
  title: string,
  verb: string,
) {
  const { displayState } = layer;
  const { content, header, body } = makeToolStatusContentWithHeader();
  header.textContent = title;
  body.classList.add("neuroglancer-merge-segments-status");
  context.registerDisposer(bindSegmentListWidth(displayState, body));
  const makeWidget = (id: Uint64MapEntry) => {
    const row = makeSegmentWidget(displayState, id);
    row.classList.add("neuroglancer-segment-list-entry-double-line");
    return row;
  };
  const updateView = () => {
    removeChildren(body);
    const value = status.value;
    if (value === undefined) return;
    const { anchorSegment, otherSegment, error } = value;
    if (anchorSegment !== undefined) {
      body.appendChild(makeWidget(anchorSegment));
    }
    if (error !== undefined) {
      const msg = document.createElement("span");
      msg.textContent = error;
      body.appendChild(msg);
    }
    if (otherSegment !== undefined) {
      const msg = document.createElement("span");
      msg.textContent = ` ${verb} `;
      body.appendChild(msg);
      body.appendChild(makeWidget(otherSegment));
    }
  };
  updateView();
  context.registerDisposer(status.changed.add(updateView));
  // A segment widget keeps the color and the visibility that the segment had
  // when the panel made it. Make the widgets again when the display state
  // changes.
  const debouncedUpdateView = context.registerCancellable(
    animationFrameDebounce(updateView),
  );
  registerCallbackWhenSegmentationDisplayStateChanged(
    displayState,
    context,
    debouncedUpdateView,
  );
  return content;
}

export class MergeSegmentsTool extends LayerTool<SegmentationUserLayer> {
  lastAnchorBaseSegment = new WatchableValue<bigint | undefined>(undefined);

  private status_ = new WatchableValue<SegmentPairToolStatus | undefined>(
    undefined,
  );

  /**
   * The status of the active merge. The value is `undefined` when the tool is
   * not active.
   */
  get status(): Readonly<
    WatchableValueInterface<SegmentPairToolStatus | undefined>
  > {
    return this.status_;
  }

  constructor(layer: SegmentationUserLayer) {
    super(layer);

    // Track the most recent base segment id within anchorSegment.
    const maybeUpdateLastAnchorBaseSegment = () => {
      const anchorSegment = layer.anchorSegment.value;
      if (anchorSegment === undefined) return;
      const { segmentSelectionState } = layer.displayState;
      if (!segmentSelectionState.hasSelectedSegment) return;
      const { segmentEquivalences } =
        layer.displayState.segmentationGroupState.value;
      const mappedAnchorSegment = segmentEquivalences.get(anchorSegment);
      if (segmentSelectionState.selectedSegment !== mappedAnchorSegment) {
        return;
      }
      const base = segmentSelectionState.baseSelectedSegment;
      const isBase = isBaseSegmentId(base);
      // TODO: This would ideally rely on a separate HIGH_BIT_REPRESENTATIVE flag,
      // but it nonetheless still works correctly for nggraph and local equivalences.
      const equivalencePolicy =
        segmentEquivalences.disjointSets.visibleSegmentEquivalencePolicy.value;
      if (
        (equivalencePolicy &
          VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED &&
          isBase) ||
        (equivalencePolicy &
          VisibleSegmentEquivalencePolicy.REPRESENTATIVE_EXCLUDED &&
          !isBase)
      ) {
        return;
      }
      this.lastAnchorBaseSegment.value = base;
    };
    this.registerDisposer(
      layer.displayState.segmentSelectionState.changed.add(
        maybeUpdateLastAnchorBaseSegment,
      ),
    );
    this.registerDisposer(
      layer.anchorSegment.changed.add(maybeUpdateLastAnchorBaseSegment),
    );
  }

  toJSON() {
    return ANNOTATE_MERGE_SEGMENTS_TOOL_ID;
  }
  activate(activation: ToolActivation<this>) {
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState =
      this.layer.displayState.segmentationGroupState.value;

    const getAnchorSegment = (): {
      anchorSegment: bigint | undefined;
      error: string | undefined;
    } => {
      const anchorSegment = this.layer.anchorSegment.value;
      const baseAnchorSegment = this.lastAnchorBaseSegment.value;
      if (anchorSegment === undefined) {
        return {
          anchorSegment: undefined,
          error: "Select anchor segment for merge",
        };
      }
      const anchorGraphSegment =
        segmentationGroupState.segmentEquivalences.get(anchorSegment);
      if (!segmentationGroupState.visibleSegments.has(anchorGraphSegment)) {
        return {
          anchorSegment,
          error: "Anchor segment must be in visible set",
        };
      }
      if (
        baseAnchorSegment === undefined ||
        segmentationGroupState.segmentEquivalences.get(baseAnchorSegment) !==
          anchorGraphSegment
      ) {
        return {
          anchorSegment,
          error:
            "Hover over base segment within anchor segment that is closest to merge location",
        };
      }
      return { anchorSegment: baseAnchorSegment, error: undefined };
    };

    const getMergeRequest = (): {
      anchorSegment: bigint | undefined;
      otherSegment: bigint | undefined;
      anchorSegmentValid: boolean;
      error: string | undefined;
    } => {
      const { anchorSegment, error } = getAnchorSegment();
      if (anchorSegment === undefined || error !== undefined) {
        return {
          anchorSegment,
          error,
          otherSegment: undefined,
          anchorSegmentValid: false,
        };
      }
      const { displayState } = this.layer;
      const otherSegment = displayState.segmentSelectionState.baseValue;
      if (
        otherSegment === undefined ||
        displayState.segmentSelectionState.selectedSegment ===
          segmentationGroupState.segmentEquivalences.get(anchorSegment)
      ) {
        return {
          anchorSegment,
          otherSegment: undefined,
          error: "Hover over segment to merge",
          anchorSegmentValid: true,
        };
      }
      return {
        anchorSegment,
        otherSegment,
        error: undefined,
        anchorSegmentValid: true,
      };
    };

    activation.bindInputEventMap(MERGE_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
      this.status_.value = undefined;
    });
    const updateStatus = () => {
      const { displayState } = this.layer;
      const { anchorSegment, otherSegment, anchorSegmentValid, error } =
        getMergeRequest();
      setSegmentPairToolStatus(this.status_, {
        anchorSegment:
          anchorSegment === undefined
            ? undefined
            : augmentSegmentId(displayState, anchorSegment),
        otherSegment:
          otherSegment === undefined
            ? undefined
            : augmentSegmentId(displayState, otherSegment),
        error,
      });
      const { segmentEquivalences } = segmentationGroupState;
      if (!anchorSegmentValid) {
        resetTemporaryVisibleSegmentsState(segmentationGroupState);
        return;
      }
      segmentationGroupState.useTemporaryVisibleSegments.value = true;
      const tempVisibleSegments =
        segmentationGroupState.temporaryVisibleSegments;
      tempVisibleSegments.clear();
      tempVisibleSegments.add(segmentEquivalences.get(anchorSegment!));
      if (otherSegment !== undefined) {
        tempVisibleSegments.add(segmentEquivalences.get(otherSegment));
      }
    };
    updateStatus();
    const debouncedUpdateStatus = activation.registerCancellable(
      animationFrameDebounce(updateStatus),
    );
    registerCallbackWhenSegmentationDisplayStateChanged(
      this.layer.displayState,
      activation,
      debouncedUpdateStatus,
    );
    activation.registerDisposer(
      this.layer.anchorSegment.changed.add(debouncedUpdateStatus),
    );
    activation.registerDisposer(
      this.lastAnchorBaseSegment.changed.add(debouncedUpdateStatus),
    );
    activation.bindAction("merge-segments", (event) => {
      event.stopPropagation();
      (async () => {
        const {
          graph: { value: graph },
        } = segmentationGroupState;
        if (graph === undefined) return;
        const { anchorSegment, otherSegment, error } = getMergeRequest();
        if (
          anchorSegment === undefined ||
          otherSegment === undefined ||
          error !== undefined
        ) {
          return;
        }
        try {
          await graph.merge(anchorSegment, otherSegment);
          StatusMessage.showTemporaryMessage("Merge performed");
        } catch (e) {
          StatusMessage.showTemporaryMessage(`Merge failed: ${e}`);
        }
      })();
    });
    activation.bindAction("set-anchor", (event) => {
      event.stopPropagation();
      const { segmentSelectionState } = this.layer.displayState;
      const other = segmentSelectionState.baseValue;
      if (other === undefined) return;
      const existingAnchor = this.layer.anchorSegment.value;
      segmentationGroupState.visibleSegments.add(other);
      if (existingAnchor === undefined || existingAnchor !== other) {
        this.layer.anchorSegment.value = other;
        return;
      }
    });
  }

  renderActivation(_activation: ToolActivation<this>, context: RefCounted) {
    return renderSegmentPairToolStatus(
      this.layer,
      this.status,
      context,
      "Merge segments",
      "merge",
    );
  }

  get description() {
    return "merge";
  }
}

export class SplitSegmentsTool extends LayerTool<SegmentationUserLayer> {
  private status_ = new WatchableValue<SegmentPairToolStatus | undefined>(
    undefined,
  );

  /**
   * The status of the active split. The value is `undefined` when the tool is
   * not active.
   */
  get status(): Readonly<
    WatchableValueInterface<SegmentPairToolStatus | undefined>
  > {
    return this.status_;
  }

  toJSON() {
    return ANNOTATE_SPLIT_SEGMENTS_TOOL_ID;
  }

  activate(activation: ToolActivation<this>) {
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState =
      this.layer.displayState.segmentationGroupState.value;

    const getAnchorSegment = (): {
      anchorSegment: bigint | undefined;
      error: string | undefined;
    } => {
      const anchorSegment = this.layer.anchorSegment.value;
      if (anchorSegment === undefined) {
        return {
          anchorSegment: undefined,
          error: "Select anchor segment for split",
        };
      }
      const anchorGraphSegment =
        segmentationGroupState.segmentEquivalences.get(anchorSegment);
      if (!segmentationGroupState.visibleSegments.has(anchorGraphSegment)) {
        return {
          anchorSegment,
          error: "Anchor segment must be in visible set",
        };
      }
      return { anchorSegment, error: undefined };
    };

    activation.bindInputEventMap(SPLIT_SEGMENTS_INPUT_EVENT_MAP);
    const getSplitRequest = (): {
      anchorSegment: bigint | undefined;
      otherSegment: bigint | undefined;
      anchorSegmentValid: boolean;
      error: string | undefined;
    } => {
      const { anchorSegment, error } = getAnchorSegment();
      if (anchorSegment === undefined || error !== undefined) {
        return {
          anchorSegment,
          error,
          otherSegment: undefined,
          anchorSegmentValid: false,
        };
      }
      const { displayState } = this.layer;
      const otherSegment = displayState.segmentSelectionState.baseValue;
      if (
        otherSegment === undefined ||
        displayState.segmentSelectionState.selectedSegment !==
          segmentationGroupState.segmentEquivalences.get(anchorSegment) ||
        otherSegment === anchorSegment
      ) {
        return {
          anchorSegment,
          otherSegment: undefined,
          anchorSegmentValid: true,
          error: "Hover over base segment to seed split",
        };
      }
      return {
        anchorSegment,
        otherSegment,
        anchorSegmentValid: true,
        error: undefined,
      };
    };
    activation.registerDisposer(() => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
      this.status_.value = undefined;
    });
    const updateStatus = () => {
      const { displayState } = this.layer;
      const { anchorSegment, otherSegment, anchorSegmentValid, error } =
        getSplitRequest();
      let anchorSegmentAugmented: Uint64MapEntry | undefined;
      let otherSegmentAugmented: Uint64MapEntry | undefined;
      const updateTemporaryState = () => {
        const { segmentEquivalences } = segmentationGroupState;
        const {
          graphConnection: { value: graphConnection },
        } = this.layer;
        if (!anchorSegmentValid || graphConnection === undefined) {
          resetTemporaryVisibleSegmentsState(segmentationGroupState);
          return;
        }
        segmentationGroupState.useTemporaryVisibleSegments.value = true;
        if (otherSegment !== undefined) {
          const splitResult = graphConnection.computeSplit(
            anchorSegment!,
            otherSegment,
          );
          if (splitResult !== undefined) {
            anchorSegmentAugmented = new Uint64MapEntry(
              anchorSegment!,
              splitResult.includeRepresentative,
            );
            otherSegmentAugmented = new Uint64MapEntry(
              otherSegment,
              splitResult.excludeRepresentative,
            );
            segmentationGroupState.useTemporarySegmentEquivalences.value = true;
            const retainedGraphSegment = splitResult.includeRepresentative;
            const excludedGraphSegment = splitResult.excludeRepresentative;
            const tempEquivalences =
              segmentationGroupState.temporarySegmentEquivalences;
            tempEquivalences.clear();
            for (const segment of splitResult.includeBaseSegments) {
              tempEquivalences.link(segment, retainedGraphSegment);
            }
            for (const segment of splitResult.excludeBaseSegments) {
              tempEquivalences.link(segment, excludedGraphSegment);
            }
            const tempVisibleSegments =
              segmentationGroupState.temporaryVisibleSegments;
            tempVisibleSegments.clear();
            tempVisibleSegments.add(retainedGraphSegment);
            tempVisibleSegments.add(excludedGraphSegment);
            return;
          }
        }
        segmentationGroupState.useTemporarySegmentEquivalences.value = false;
        const tempVisibleSegments =
          segmentationGroupState.temporaryVisibleSegments;
        tempVisibleSegments.clear();
        tempVisibleSegments.add(segmentEquivalences.get(anchorSegment!));
      };
      updateTemporaryState();
      setSegmentPairToolStatus(this.status_, {
        anchorSegment:
          anchorSegment === undefined
            ? undefined
            : (anchorSegmentAugmented ??
              augmentSegmentId(displayState, anchorSegment)),
        otherSegment: otherSegmentAugmented,
        error,
      });
    };
    updateStatus();
    const debouncedUpdateStatus = activation.registerCancellable(
      animationFrameDebounce(updateStatus),
    );
    registerCallbackWhenSegmentationDisplayStateChanged(
      this.layer.displayState,
      activation,
      debouncedUpdateStatus,
    );
    activation.registerDisposer(
      this.layer.anchorSegment.changed.add(debouncedUpdateStatus),
    );

    const splitSegments = async (select: boolean) => {
      const {
        graph: { value: graph },
      } = segmentationGroupState;
      if (graph === undefined) return;
      const { anchorSegment, otherSegment, error } = getSplitRequest();
      if (
        anchorSegment === undefined ||
        otherSegment === undefined ||
        error !== undefined
      ) {
        return;
      }
      try {
        await graph.split(anchorSegment, otherSegment);
        if (select) {
          segmentationGroupState.visibleSegments.add(
            segmentationGroupState.segmentEquivalences.get(otherSegment),
          );
        }
        StatusMessage.showTemporaryMessage("Split performed");
      } catch (e) {
        StatusMessage.showTemporaryMessage(`Split failed: ${e}`);
      }
    };

    activation.bindAction("split-segments", (event) => {
      event.stopPropagation();
      splitSegments(/*select=*/ false);
    });
    activation.bindAction("split-and-select-segments", (event) => {
      event.stopPropagation();
      splitSegments(/*select=*/ true);
    });
    activation.bindAction("set-anchor", (event) => {
      event.stopPropagation();
      const { segmentSelectionState } = this.layer.displayState;
      const other = segmentSelectionState.baseValue;
      if (other === undefined) return;
      segmentationGroupState.visibleSegments.add(other);
      const existingAnchor = this.layer.anchorSegment.value;
      if (existingAnchor === undefined || existingAnchor !== other) {
        this.layer.anchorSegment.value = other;
        return;
      }
    });
  }

  renderActivation(_activation: ToolActivation<this>, context: RefCounted) {
    return renderSegmentPairToolStatus(
      this.layer,
      this.status,
      context,
      "Split segments",
      "split",
    );
  }

  get description() {
    return "split";
  }
}

export function registerSegmentSplitMergeTools(
  contextType: typeof SegmentationUserLayer,
) {
  registerTool(contextType, ANNOTATE_MERGE_SEGMENTS_TOOL_ID, (layer) => {
    return new MergeSegmentsTool(layer);
  });

  registerTool(contextType, ANNOTATE_SPLIT_SEGMENTS_TOOL_ID, (layer) => {
    return new SplitSegmentsTool(layer);
  });
}
