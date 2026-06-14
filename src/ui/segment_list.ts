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

import "#src/ui/segment_list.css";

import type { DebouncedFunc } from "lodash-es";
import { debounce } from "lodash-es";
import type {
  SegmentationUserLayer,
  SegmentationUserLayerGroupState,
} from "#src/layer/segmentation/index.js";
import type { SegmentationDisplayState } from "#src/segmentation_display_state/frontend.js";
import {
  registerCallbackWhenSegmentationDisplayStateChanged,
  SegmentWidgetWithExtraColumnsFactory,
} from "#src/segmentation_display_state/frontend.js";
import type {
  ExplicitIdQuery,
  FilterQuery,
  PreprocessedSegmentPropertyMap,
  PropertyHistogram,
  QueryResult,
} from "#src/segmentation_display_state/property_map.js";
import {
  changeTagConstraintInSegmentQuery,
  executeSegmentQuery,
  findQueryResultIntersectionSize,
  forEachQueryResultSegmentIdGenerator,
  isQueryUnconstrained,
  parseSegmentQuery,
  unparseSegmentQuery,
  updatePropertyHistograms,
} from "#src/segmentation_display_state/property_map.js";
import type {
  IncludeExcludeChip,
  NumericalSummaryDataSource,
  NumericalSummaryQuery,
  NumericalSummaryQueryResult,
} from "#src/ui/property_summary.js";
import {
  NumericalPropertiesSummary,
  queryIncludesColumn,
  renderIncludeExcludeChips,
  toggleSortOrder,
  updateColumnSortIcon,
} from "#src/ui/property_summary.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { observeWatchable, WatchableValue } from "#src/trackable_value.js";
import { getDefaultSelectBindings } from "#src/ui/default_input_event_bindings.js";
import { SELECT_SEGMENTS_TOOLS_ID } from "#src/ui/segment_select_tools.js";
import {
  ANNOTATE_MERGE_SEGMENTS_TOOL_ID,
  ANNOTATE_SPLIT_SEGMENTS_TOOL_ID,
} from "#src/ui/segment_split_merge_tools.js";
import { makeToolButton } from "#src/ui/tool.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { ArraySpliceOp } from "#src/util/array.js";
import { getFixedOrderMergeSplices } from "#src/util/array.js";
import { bigintCompare } from "#src/util/bigint.js";
import { setClipboard } from "#src/util/clipboard.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import {
  EventActionMap,
  KeyboardEventBinder,
  registerActionListener,
} from "#src/util/keyboard_bindings.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import { makeCopyButton } from "#src/widget/copy_button.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { makeEyeButton } from "#src/widget/eye_button.js";
import { makeStarButton } from "#src/widget/star_button.js";
import { Tab } from "#src/widget/tab_view.js";
import type { VirtualListSource } from "#src/widget/virtual_list.js";
import { VirtualList } from "#src/widget/virtual_list.js";

abstract class SegmentListSource
  extends RefCounted
  implements VirtualListSource
{
  length: number;
  changed = new Signal<(splices: readonly Readonly<ArraySpliceOp>[]) => void>();

  // The segment list is the concatenation of two lists: the `explicitSegments` list, specified as
  // explicit uint64 ids, and the `matches`, list, specifying the indices into the
  // `segmentPropertyMap` of the matching segments.
  explicitSegments: bigint[] | undefined;

  debouncedUpdate = debounce(() => this.update(), 0);

  constructor(
    public segmentationDisplayState: SegmentationDisplayState,
    public parentElement: HTMLElement,
  ) {
    super();
  }

  abstract update(): void;

  private updateRendering(element: HTMLElement) {
    this.segmentWidgetFactory.update(element);
  }

  segmentWidgetFactory: SegmentWidgetWithExtraColumnsFactory;

  abstract render(index: number): HTMLDivElement;

  updateRenderedItems(list: VirtualList) {
    list.forEachRenderedItem((element) => {
      this.updateRendering(element);
    });
  }
}

class StarredSegmentsListSource extends SegmentListSource {
  constructor(
    public segmentationDisplayState: SegmentationDisplayState,
    public parentElement: HTMLElement,
  ) {
    super(segmentationDisplayState, parentElement);
    this.update();
    this.registerDisposer(
      segmentationDisplayState.segmentationGroupState.value.selectedSegments.changed.add(
        this.debouncedUpdate,
      ),
    );
  }

  update() {
    const splices: ArraySpliceOp[] = [];
    const { selectedSegments } =
      this.segmentationDisplayState.segmentationGroupState.value;
    const newSelectedSegments = [...selectedSegments];
    const { explicitSegments } = this;
    if (explicitSegments === undefined) {
      splices.push({
        retainCount: 0,
        insertCount: newSelectedSegments.length,
        deleteCount: 0,
      });
    } else {
      splices.push(
        ...getFixedOrderMergeSplices(
          explicitSegments,
          newSelectedSegments,
          (a, b) => a === b,
        ),
      );
    }
    this.explicitSegments = newSelectedSegments;
    this.length = newSelectedSegments.length;
    this.changed.dispatch(splices);
  }

  render = (index: number) => {
    const { explicitSegments } = this;
    const id = explicitSegments![index];
    return this.segmentWidgetFactory.get(id);
  };
}

class SegmentQueryListSource extends SegmentListSource {
  prevQuery: string | undefined;
  queryResult = new WatchableValue<QueryResult | undefined>(undefined);
  prevQueryResult = new WatchableValue<QueryResult | undefined>(undefined);
  statusText = new WatchableValue<string>("");
  selectedMatches = 0;
  visibleMatches = 0;
  matchStatusTextPrefix = "";
  selectedSegmentsGeneration = -1;
  visibleSegmentsGeneration = -1;

  get numMatches() {
    return this.queryResult.value?.count ?? 0;
  }

  update() {
    const query = this.query.value;
    const { segmentPropertyMap } = this;
    this.prevQueryResult.value = this.queryResult.value;
    const prevQueryResult = this.prevQueryResult.value;
    let queryResult: QueryResult;
    if (this.prevQuery === query) {
      queryResult = prevQueryResult!;
    } else {
      const queryParseResult = parseSegmentQuery(segmentPropertyMap, query);
      queryResult = executeSegmentQuery(segmentPropertyMap, queryParseResult);
    }

    const splices: ArraySpliceOp[] = [];
    let changed = false;
    let matchStatusTextPrefix = "";
    const unconstrained = isQueryUnconstrained(queryResult.query);
    if (!unconstrained) {
      if (this.explicitSegments !== undefined) {
        splices.push({
          deleteCount: this.explicitSegments.length,
          retainCount: 0,
          insertCount: 0,
        });
        this.explicitSegments = undefined;
        changed = true;
      }
    }

    const { explicitIds } = queryResult;
    if (explicitIds !== undefined) {
      this.explicitSegments = explicitIds;
    } else {
      this.explicitSegments = undefined;
    }

    if (prevQueryResult !== queryResult) {
      splices.push({
        retainCount: 0,
        deleteCount: prevQueryResult?.count ?? 0,
        insertCount: queryResult.count,
      });
      changed = true;
      this.queryResult.value = queryResult;
    }

    if (queryResult.explicitIds !== undefined) {
      matchStatusTextPrefix = `${queryResult.count} ids`;
    } else if (unconstrained) {
      matchStatusTextPrefix = `${queryResult.count} total ids`;
    } else if (queryResult.total > 0) {
      matchStatusTextPrefix = `${queryResult.count} match /${queryResult.total} total ids`;
    }

    const { selectedSegments, visibleSegments } =
      this.segmentationDisplayState.segmentationGroupState.value;
    const selectedSegmentsGeneration = selectedSegments.changed.count;
    const visibleSegmentsGeneration = visibleSegments.changed.count;
    const prevSelectedSegmentsGeneration = this.selectedSegmentsGeneration;
    const prevVisibleSegmentsGeneration = this.visibleSegmentsGeneration;
    const queryChanged = prevQueryResult !== queryResult;
    const selectedChanged =
      prevSelectedSegmentsGeneration !== selectedSegmentsGeneration ||
      queryChanged;
    const visibleChanged =
      prevVisibleSegmentsGeneration !== visibleSegmentsGeneration ||
      queryChanged;
    this.selectedSegmentsGeneration = selectedSegmentsGeneration;
    this.visibleSegmentsGeneration = visibleSegmentsGeneration;

    if (selectedChanged) {
      this.selectedMatches =
        queryResult.count > 0
          ? findQueryResultIntersectionSize(
              segmentPropertyMap,
              queryResult,
              selectedSegments,
            )
          : 0;
    }

    if (visibleChanged) {
      this.visibleMatches =
        queryResult.count > 0
          ? findQueryResultIntersectionSize(
              segmentPropertyMap,
              queryResult,
              visibleSegments,
            )
          : 0;
    }

    let fullStatusText = matchStatusTextPrefix;
    if (this.selectedMatches > 0) {
      if (this.selectedMatches === this.visibleMatches) {
        fullStatusText = `${this.selectedMatches} vis/${fullStatusText}`;
      } else if (this.visibleMatches > 0) {
        fullStatusText = `${this.visibleMatches} vis/${this.selectedMatches} star/${fullStatusText}`;
      } else {
        fullStatusText = `${this.selectedMatches} star/${fullStatusText}`;
      }
    }

    this.statusText.value = fullStatusText;

    this.prevQuery = query;
    this.matchStatusTextPrefix = matchStatusTextPrefix;
    this.length = queryResult.count;
    if (changed) {
      this.changed.dispatch(splices);
    }
  }

  constructor(
    public query: WatchableValueInterface<string>,
    public segmentPropertyMap: PreprocessedSegmentPropertyMap | undefined,
    public segmentationDisplayState: SegmentationDisplayState,
    public parentElement: HTMLElement,
  ) {
    super(segmentationDisplayState, parentElement);
    this.update();
    this.registerDisposer(
      segmentationDisplayState.segmentationGroupState.value.selectedSegments.changed.add(
        this.debouncedUpdate,
      ),
    ); // to update statusText
    this.registerDisposer(
      segmentationDisplayState.segmentationGroupState.value.visibleSegments.changed.add(
        this.debouncedUpdate,
      ),
    ); // to update statusText
    if (query) {
      this.registerDisposer(query.changed.add(this.debouncedUpdate));
    }
  }

  render = (index: number) => {
    const { explicitSegments } = this;
    let id: bigint;
    if (explicitSegments !== undefined) {
      id = explicitSegments[index];
    } else {
      const propIndex = this.queryResult.value!.indices![index];
      const { ids } =
        this.segmentPropertyMap!.segmentPropertyMap.inlineProperties!;
      id = ids[propIndex];
    }
    return this.segmentWidgetFactory.get(id);
  };
}

const keyMap = EventActionMap.fromObject({
  enter: { action: "toggle-listed" },
  "shift+enter": { action: "hide-listed" },
  "control+enter": { action: "hide-all" },
  escape: { action: "cancel" },
});

abstract class SegmentListGroupBase extends RefCounted {
  element = document.createElement("div");

  selectionStatusContainer = document.createElement("span");
  starAllButton: HTMLElement;
  selectionStatusMessage = document.createElement("span");
  copyAllSegmentsButton: HTMLElement;
  copyVisibleSegmentsButton: HTMLElement;
  visibilityToggleAllButton: HTMLElement;

  statusChanged = new NullarySignal();

  private debouncedUpdateStatus = debounce(() => this.updateStatus(), 0);

  makeSegmentsVisible(visible: boolean) {
    const { visibleSegments } = this.group;
    const segments = Array.from(this.listSegments());
    visibleSegments.set(segments, visible);
  }

  invertVisibility() {
    const markVisible: bigint[] = [];
    const markNonVisible: bigint[] = [];
    const { visibleSegments } = this.group;
    for (const segment of this.listSegments()) {
      if (visibleSegments.has(segment)) {
        markNonVisible.push(segment);
      } else {
        markVisible.push(segment);
      }
    }
    visibleSegments.set(markVisible, true);
    visibleSegments.set(markNonVisible, false);
  }

  selectSegments(select: boolean, changeVisibility = false) {
    const { selectedSegments, visibleSegments } = this.group;
    const segments = Array.from(this.listSegments());
    if (select || !changeVisibility) {
      selectedSegments.set(segments, select);
    }
    if (changeVisibility) {
      visibleSegments.set(segments, select);
    }
  }

  copySegments(onlyVisible = false) {
    let ids = [...this.listSegments()];
    if (onlyVisible) {
      ids = ids.filter((segment) => this.group.visibleSegments.has(segment));
    }
    ids.sort(bigintCompare);
    setClipboard(ids.join(", "));
  }

  constructor(
    protected listSource: SegmentListSource,
    protected group: SegmentationUserLayerGroupState,
  ) {
    super();

    const { element } = this;
    element.style.display = "contents";
    this.starAllButton = makeStarButton({
      title:
        "Click to toggle star status, shift+click to unstar non-visible segments.",
      onClick: (event) => {
        const starred = this.starAllButton.classList.contains(
          "neuroglancer-starred",
        );
        if (event.shiftKey) {
          const nonVisibleSegments: bigint[] = [];
          for (const segment of this.group.selectedSegments) {
            if (!this.group.visibleSegments.has(segment)) {
              nonVisibleSegments.push(segment);
            }
          }
          this.group.selectedSegments.delete(nonVisibleSegments);
          return;
        }
        this.selectSegments(!starred, false);
      },
    });
    this.copyAllSegmentsButton = makeCopyButton({
      title: "Copy all segment IDs",
      onClick: () => {
        this.copySegments(false);
      },
    });
    this.copyVisibleSegmentsButton = makeCopyButton({
      title: "Copy visible segment IDs",
      onClick: () => {
        this.copySegments(true);
      },
    });
    this.visibilityToggleAllButton = makeEyeButton({
      onClick: (event) => {
        if (event.shiftKey) {
          this.invertVisibility();
          return;
        }
        this.makeSegmentsVisible(
          !this.visibilityToggleAllButton.classList.contains(
            "neuroglancer-visible",
          ),
        );
      },
    });
    const { selectionStatusContainer } = this;
    this.selectionStatusMessage.classList.add(
      "neuroglancer-segment-list-status-message",
    );
    selectionStatusContainer.classList.add("neuroglancer-segment-list-status");
    selectionStatusContainer.appendChild(this.copyAllSegmentsButton);
    selectionStatusContainer.appendChild(this.starAllButton);
    selectionStatusContainer.appendChild(this.visibilityToggleAllButton);
    selectionStatusContainer.appendChild(this.copyVisibleSegmentsButton);
    selectionStatusContainer.appendChild(this.selectionStatusMessage);
    this.element.appendChild(selectionStatusContainer);
    this.registerDisposer(
      group.visibleSegments.changed.add(this.debouncedUpdateStatus),
    );
    this.registerDisposer(
      group.selectedSegments.changed.add(this.debouncedUpdateStatus),
    );
    this.registerDisposer(listSource.changed.add(this.debouncedUpdateStatus));
  }

  *listSegments(): IterableIterator<bigint> {}

  updateStatus() {
    const {
      listSource,
      group,
      starAllButton,
      selectionStatusMessage,
      copyAllSegmentsButton,
      copyVisibleSegmentsButton,
      visibilityToggleAllButton,
    } = this;
    listSource.debouncedUpdate.flush();
    const { visibleSegments, selectedSegments } = group;
    let queryVisibleCount = 0;
    let querySelectedCount = 0;
    let numMatches = 0;
    let statusMessage = "";
    const selectedCount = selectedSegments.size;
    const visibleCount = visibleSegments.size;
    if (listSource instanceof SegmentQueryListSource) {
      numMatches = listSource.numMatches;
      queryVisibleCount = listSource.visibleMatches;
      querySelectedCount = listSource.selectedMatches;
      statusMessage = listSource.statusText.value;
    } else {
      statusMessage = `${visibleCount}/${selectedCount} visible`;
    }
    const visibleDisplayedCount = numMatches ? queryVisibleCount : visibleCount;
    const visibleSelectedCount = numMatches
      ? querySelectedCount
      : selectedCount;
    const totalDisplayed = numMatches || selectedCount;
    starAllButton.classList.toggle(
      "neuroglancer-starred",
      visibleSelectedCount === totalDisplayed,
    );
    starAllButton.classList.toggle(
      "neuroglancer-indeterminate",
      visibleSelectedCount > 0 && visibleSelectedCount !== totalDisplayed,
    );
    selectionStatusMessage.textContent = statusMessage;
    copyAllSegmentsButton.title = `Copy all ${totalDisplayed} ${
      numMatches ? "matching" : "starred"
    } segment(s)`;
    copyVisibleSegmentsButton.title = `Copy ${visibleDisplayedCount} ${
      numMatches ? "visible matching" : "visible"
    } segment(s)`;
    copyAllSegmentsButton.style.visibility = totalDisplayed
      ? "visible"
      : "hidden";
    copyVisibleSegmentsButton.style.visibility = visibleDisplayedCount
      ? "visible"
      : "hidden";
    starAllButton.style.visibility = totalDisplayed ? "visible" : "hidden";
    visibilityToggleAllButton.style.visibility = totalDisplayed
      ? "visible"
      : "hidden";
    const allVisible = visibleDisplayedCount === totalDisplayed;
    visibilityToggleAllButton.classList.toggle(
      "neuroglancer-visible",
      allVisible,
    );
    const visibleIndeterminate =
      visibleDisplayedCount > 0 && visibleDisplayedCount !== totalDisplayed;
    visibilityToggleAllButton.classList.toggle(
      "neuroglancer-indeterminate",
      visibleIndeterminate,
    );
    let visibleToggleTitle: string;
    if (!allVisible) {
      visibleToggleTitle = `Click to show ${
        totalDisplayed - visibleDisplayedCount
      } segment ID(s).`;
    } else {
      visibleToggleTitle = `Click to hide ${totalDisplayed} segment ID(s).`;
    }
    if (visibleIndeterminate) {
      visibleToggleTitle += "  Shift+click to invert visibility.";
    }
    visibilityToggleAllButton.title = visibleToggleTitle;
    this.statusChanged.dispatch();
  }
}

class SegmentListGroupSelected extends SegmentListGroupBase {
  constructor(
    protected listSource: SegmentListSource,
    protected group: SegmentationUserLayerGroupState,
  ) {
    super(listSource, group);
  }

  listSegments() {
    return this.group.selectedSegments[Symbol.iterator](); // TODO, better way to call the iterator?
  }
}

class SegmentListGroupQuery extends SegmentListGroupBase {
  updateQuery() {
    const { listSource, debouncedUpdateQueryModel } = this;
    debouncedUpdateQueryModel();
    debouncedUpdateQueryModel.flush();
    listSource.debouncedUpdate.flush();
  }

  listSegments(): IterableIterator<bigint> {
    const { listSource, segmentPropertyMap } = this;
    this.updateQuery();
    const queryResult = listSource.queryResult.value;
    return forEachQueryResultSegmentIdGenerator(
      segmentPropertyMap,
      queryResult,
    );
  }

  constructor(
    list: VirtualList,
    protected listSource: SegmentQueryListSource,
    group: SegmentationUserLayerGroupState,
    private segmentPropertyMap: PreprocessedSegmentPropertyMap | undefined,
    segmentQuery: WatchableValueInterface<string>,
    queryElement: HTMLInputElement,
    private debouncedUpdateQueryModel: DebouncedFunc<() => void>,
  ) {
    super(listSource, group);
    const setQuery = (newQuery: ExplicitIdQuery | FilterQuery) => {
      queryElement.focus();
      queryElement.select();
      const value = unparseSegmentQuery(segmentPropertyMap, newQuery);
      document.execCommand("insertText", false, value);
      segmentQuery.value = value;
      queryElement.select();
    };
    const queryStatisticsContainer = document.createElement("div");
    queryStatisticsContainer.classList.add(
      "neuroglancer-segment-query-result-statistics",
    );
    const queryStatisticsSeparator = document.createElement("div");
    queryStatisticsSeparator.classList.add(
      "neuroglancer-segment-query-result-statistics-separator",
    );
    const queryErrors = document.createElement("ul");
    queryErrors.classList.add("neuroglancer-segment-query-errors");
    // push them in front of the base list elements
    this.element.prepend(
      queryErrors,
      queryStatisticsContainer,
      queryStatisticsSeparator,
    );
    this.registerEventListener(queryElement, "input", () => {
      debouncedUpdateQueryModel();
    });
    this.registerDisposer(
      registerActionListener(queryElement, "cancel", () => {
        queryElement.focus();
        queryElement.select();
        document.execCommand("delete");
        queryElement.blur();
        queryElement.value = "";
        segmentQuery.value = "";
      }),
    );
    this.registerDisposer(
      registerActionListener(queryElement, "toggle-listed", () => {
        this.toggleMatches();
      }),
    );
    this.registerDisposer(
      registerActionListener(queryElement, "hide-all", () => {
        group.visibleSegments.clear();
      }),
    );
    this.registerDisposer(
      registerActionListener(queryElement, "hide-listed", () => {
        debouncedUpdateQueryModel();
        debouncedUpdateQueryModel.flush();
        listSource.debouncedUpdate.flush();
        const { visibleSegments } = group;
        if (this.listSource instanceof StarredSegmentsListSource) {
          visibleSegments.clear();
        } else {
          visibleSegments.delete(Array.from(this.listSegments()));
        }
      }),
    );
    const segmentDataSource: NumericalSummaryDataSource = {
      properties: (segmentPropertyMap?.numericalProperties ?? []).map((p) => ({
        id: p.id,
        dataType: p.dataType,
        bounds: p.bounds,
        description: p.description,
      })),
      updateHistograms(qr, histograms, windowBounds) {
        updatePropertyHistograms(
          segmentPropertyMap,
          qr as QueryResult | undefined,
          histograms as PropertyHistogram[],
          windowBounds,
        );
      },
    };
    const numericalPropertySummaries = this.registerDisposer(
      new NumericalPropertiesSummary(
        segmentDataSource,
        listSource.queryResult as unknown as WatchableValueInterface<NumericalSummaryQueryResult | undefined>,
        setQuery as unknown as (q: NumericalSummaryQuery) => void,
      ),
    );
    {
      const { listElement } = numericalPropertySummaries;
      if (listElement !== undefined) {
        queryStatisticsContainer.appendChild(listElement);
      }
    }
    const updateQueryErrors = (queryResult: QueryResult | undefined) => {
      const errors = queryResult?.errors;
      removeChildren(queryErrors);
      if (errors === undefined) return;
      for (const error of errors) {
        const errorElement = document.createElement("li");
        errorElement.textContent = error.message;
        queryErrors.appendChild(errorElement);
      }
    };

    let tagSummary: HTMLElement | undefined = undefined;
    observeWatchable((queryResult: QueryResult | undefined) => {
      listSource.segmentWidgetFactory =
        new SegmentWidgetWithExtraColumnsFactory(
          listSource.segmentationDisplayState,
          listSource.parentElement,
          (property) => queryIncludesColumn(queryResult?.query, property.id),
        );
      list.scrollToTop();
      removeChildren(list.header);
      if (segmentPropertyMap !== undefined) {
        const header = listSource.segmentWidgetFactory.getHeader();
        header.container.classList.add("neuroglancer-segment-list-header");
        for (const headerLabel of header.propertyLabels) {
          const { label, sortIcon, id } = headerLabel;
          label.addEventListener("click", () => {
            toggleSortOrder(
              listSource.queryResult.value?.query as NumericalSummaryQuery | undefined,
              setQuery as unknown as (q: NumericalSummaryQuery) => void,
              id,
            );
          });
          updateColumnSortIcon(queryResult?.query, sortIcon, id);
        }
        list.header.appendChild(header.container);
      }
      updateQueryErrors(queryResult);
      queryStatisticsSeparator.style.display = "none";
      tagSummary?.remove();
      if (queryResult === undefined) return;
      const { query } = queryResult;
      if (query.errors !== undefined || query.ids !== undefined) return;
      if (queryResult.tags !== undefined && queryResult.tags.length > 0) {
        const filterQuery = queryResult.query as FilterQuery;
        const chips: IncludeExcludeChip[] = queryResult.tags.map(
          ({ tag, count, desc }) => ({
            key: tag,
            label:
              desc !== undefined && desc !== "" && tag !== desc
                ? `${tag} (${desc})`
                : tag,
            count,
            totalCount: queryResult.count,
            included: filterQuery.includeTags.includes(tag),
            excluded: filterQuery.excludeTags.includes(tag),
            onToggle: (target, value) => {
              setQuery(
                changeTagConstraintInSegmentQuery(
                  filterQuery,
                  tag,
                  target === "include",
                  value,
                ),
              );
            },
          }),
        );
        tagSummary = renderIncludeExcludeChips(chips);
      }
      if (tagSummary !== undefined) {
        queryStatisticsContainer.appendChild(tagSummary);
      }
      if (
        segmentDataSource.properties.length > 0 ||
        tagSummary !== undefined
      ) {
        queryStatisticsSeparator.style.display = "";
      }
    }, listSource.queryResult);
  }

  toggleMatches() {
    const { listSource } = this;
    this.updateQuery();
    listSource.debouncedUpdate.flush();
    const queryResult = listSource.queryResult.value;
    if (queryResult === undefined) return;
    const { visibleMatches } = listSource;
    const shouldSelect = visibleMatches !== queryResult.count;
    this.selectSegments(shouldSelect, true);
    return true;
  }
}

export class SegmentDisplayTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-segment-display-tab");
    element.appendChild(
      this.registerDisposer(
        new DependentViewWidget(
          layer.displayState.segmentationGroupState.value.graph,
          (graph, parent, context) => {
            if (graph === undefined) return;
            if (graph.tabContents) {
              return;
            }
            const toolbox = document.createElement("div");
            toolbox.className = "neuroglancer-segmentation-toolbox";
            toolbox.appendChild(
              makeToolButton(context, layer.toolBinder, {
                toolJson: ANNOTATE_MERGE_SEGMENTS_TOOL_ID,
                label: "Merge",
                title: "Merge segments",
              }),
            );
            toolbox.appendChild(
              makeToolButton(context, layer.toolBinder, {
                toolJson: ANNOTATE_SPLIT_SEGMENTS_TOOL_ID,
                label: "Split",
                title: "Split segments",
              }),
            );
            parent.appendChild(toolbox);
          },
        ),
      ).element,
    );

    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-segmentation-toolbox";
    toolbox.appendChild(
      makeToolButton(this, layer.toolBinder, {
        toolJson: SELECT_SEGMENTS_TOOLS_ID,
        label: "Select",
        title: "Select/Deselect segments",
      }),
    );
    element.appendChild(toolbox);

    const queryElement = document.createElement("input");
    queryElement.classList.add("neuroglancer-segment-list-query");
    queryElement.addEventListener("focus", () => {
      queryElement.select();
    });
    const keyboardHandler = this.registerDisposer(
      new KeyboardEventBinder(queryElement, keyMap),
    );
    keyboardHandler.allShortcutsAreGlobal = true;
    const { segmentQuery } = this.layer.displayState;
    const debouncedUpdateQueryModel = this.registerCancellable(
      debounce(() => {
        segmentQuery.value = queryElement.value;
      }, 200),
    );
    queryElement.autocomplete = "off";
    queryElement.title = keyMap.describe();
    queryElement.spellcheck = false;
    queryElement.placeholder = "Enter ID, name prefix or /regexp";
    this.registerDisposer(
      observeWatchable((q) => {
        queryElement.value = q;
      }, segmentQuery),
    );
    this.registerDisposer(
      observeWatchable((t) => {
        if (Date.now() - t < 100) {
          setTimeout(() => {
            queryElement.focus();
          }, 0);
          this.layer.segmentQueryFocusTime.value = Number.NEGATIVE_INFINITY;
        }
      }, this.layer.segmentQueryFocusTime),
    );

    element.appendChild(queryElement);
    element.appendChild(
      this.registerDisposer(
        new DependentViewWidget(
          // segmentLabelMap is guaranteed to change if segmentationGroupState changes.
          layer.displayState.segmentPropertyMap,
          (segmentPropertyMap, parent, context) => {
            const listSource = context.registerDisposer(
              new SegmentQueryListSource(
                segmentQuery,
                segmentPropertyMap,
                layer.displayState,
                parent,
              ),
            );
            const selectedSegmentsListSource = context.registerDisposer(
              new StarredSegmentsListSource(layer.displayState, parent),
            );
            const list = context.registerDisposer(
              new VirtualList({ source: listSource, horizontalScroll: true }),
            );
            const selectedSegmentsList = context.registerDisposer(
              new VirtualList({
                source: selectedSegmentsListSource,
                horizontalScroll: true,
              }),
            );

            const group = layer.displayState.segmentationGroupState.value;

            const segList = context.registerDisposer(
              new SegmentListGroupQuery(
                list,
                listSource,
                group,
                segmentPropertyMap,
                segmentQuery,
                queryElement,
                debouncedUpdateQueryModel,
              ),
            );
            segList.element.appendChild(list.element);
            parent.appendChild(segList.element);
            const segList2 = context.registerDisposer(
              new SegmentListGroupSelected(selectedSegmentsListSource, group),
            );
            segList2.element.appendChild(selectedSegmentsList.element);
            parent.appendChild(segList2.element);

            const updateListDisplayState = () => {
              const showQueryResultsList =
                listSource.query.value !== "" || listSource.numMatches > 0;
              const showStarredSegmentsList =
                selectedSegmentsListSource.length > 0 || !showQueryResultsList;
              segList.element.style.display = showQueryResultsList
                ? "contents"
                : "none";
              segList2.element.style.display = showStarredSegmentsList
                ? "contents"
                : "none";
            };
            context.registerDisposer(
              segList.statusChanged.add(updateListDisplayState),
            );
            context.registerDisposer(
              segList2.statusChanged.add(updateListDisplayState),
            );
            segList.updateStatus();
            segList2.updateStatus();

            const updateListItems = context.registerCancellable(
              animationFrameDebounce(() => {
                listSource.updateRenderedItems(list);
                selectedSegmentsListSource.updateRenderedItems(
                  selectedSegmentsList,
                );
              }),
            );
            const { displayState } = this.layer;
            registerCallbackWhenSegmentationDisplayStateChanged(
              displayState,
              context,
              updateListItems,
            );
            context.registerDisposer(
              displayState.segmentationGroupState.value.selectedSegments.changed.add(
                updateListItems,
              ),
            );
            list.element.classList.add("neuroglancer-segment-list");
            list.element.classList.add("neuroglancer-preview-list");
            selectedSegmentsList.element.classList.add(
              "neuroglancer-segment-list",
            );
            context.registerDisposer(layer.bindSegmentListWidth(list.element));
            context.registerDisposer(
              layer.bindSegmentListWidth(selectedSegmentsList.element),
            );
            context.registerDisposer(
              new MouseEventBinder(list.element, getDefaultSelectBindings()),
            );
            context.registerDisposer(
              new MouseEventBinder(
                selectedSegmentsList.element,
                getDefaultSelectBindings(),
              ),
            );

            // list2 doesn't depend on queryResult, maybe move this into class
            selectedSegmentsListSource.segmentWidgetFactory =
              new SegmentWidgetWithExtraColumnsFactory(
                selectedSegmentsListSource.segmentationDisplayState,
                selectedSegmentsListSource.parentElement,
                (property) => queryIncludesColumn(undefined, property.id),
              );
            selectedSegmentsList.scrollToTop();
            removeChildren(selectedSegmentsList.header);
          },
        ),
      ).element,
    );
  }
}
