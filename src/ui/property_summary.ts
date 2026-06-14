/**
 * @license
 * Copyright 2024 Google Inc.
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

// Shared widgets for property query UIs used by both the segment list and
// annotation list panels.  These are extracted from segment_list.ts so that
// annotation_list can reuse the CDF histogram panel and include/exclude chip
// grid without depending on the segment-specific query engine.

import "#src/ui/segment_list.css";

import type { DebouncedFunc } from "lodash-es";
import { debounce, throttle } from "lodash-es";
import type {
  NumericalPropertyConstraint,
  SortBy,
} from "#src/segmentation_display_state/property_map.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import { updateInputFieldWidth } from "#src/util/dom.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import {
  clampToInterval,
  computeInvlerp,
  dataTypeCompare,
  dataTypeIntervalEqual,
  getClampedInterval,
  getIntervalBoundsEffectiveFraction,
  parseDataTypeValue,
} from "#src/util/lerp.js";
import { neverSignal } from "#src/util/signal.js";
import { CheckboxIcon } from "#src/widget/checkbox_icon.js";
import type { RangeAndWindowIntervals } from "#src/widget/invlerp.js";
import {
  CdfController,
  getUpdatedRangeAndWindowParameters,
} from "#src/widget/invlerp.js";

// --- Interfaces ---------------------------------------------------------------

export interface NumericalSummaryProperty {
  id: string;
  dataType: import("#src/util/data_type.js").DataType;
  bounds: DataTypeInterval;
  description?: string;
}

/** Implemented by segment and annotation callers to provide histogram data. */
export interface NumericalSummaryDataSource {
  properties: NumericalSummaryProperty[];
  updateHistograms(
    queryResult:
      | {
          intermediateIndices?: ArrayLike<number>;
          intermediateIndicesMask?:
            | Uint32Array
            | Uint16Array
            | Uint8Array
            | undefined;
          indices?: ArrayLike<number>;
        }
      | undefined,
    histograms: NumericalPropertyHistogram[],
    windowBounds: DataTypeInterval[],
  ): void;
}

/** Minimal query shape used by the numerical summary panel. */
export interface NumericalSummaryQuery {
  sortBy: SortBy[];
  includeColumns: string[];
  numericalConstraints: NumericalPropertyConstraint[];
}

/** Minimal query-result shape used by the numerical summary panel. */
export interface NumericalSummaryQueryResult {
  query: NumericalSummaryQuery;
  indices?: ArrayLike<number>;
  intermediateIndices?: ArrayLike<number>;
  intermediateIndicesMask?: Uint32Array | Uint16Array | Uint8Array;
}

/** Per-property histogram produced by the data source. */
export interface NumericalPropertyHistogram {
  window: DataTypeInterval;
  histogram: Uint32Array;
}

// Chip descriptor for the generic include/exclude chip grid.
export interface IncludeExcludeChip {
  /** Unique key (e.g. `${propId}=${value}`) — used as a stable id. */
  key: string;
  /** Text displayed in the chip. */
  label: string;
  /** Optional tooltip. */
  desc?: string;
  /** Number of items that have this value in the current result set. */
  count: number;
  /**
   * Total count used to derive the "exclude" side count.
   * The exclude-side shows `totalCount - count`.
   */
  totalCount: number;
  included: boolean;
  excluded: boolean;
  onToggle: (target: "include" | "exclude", value: boolean) => void;
  headerLabel?: string;
  headerActive?: boolean;
  onHeaderClick?: () => void;
}

// --- Private helpers ----------------------------------------------------------

interface NumericalBoundElements {
  container: HTMLElement;
  inputs: [HTMLInputElement, HTMLInputElement];
  spacers: [HTMLElement, HTMLElement, HTMLElement] | undefined;
}

interface NumericalPropertySummaryWidget {
  element: HTMLElement;
  controller: CdfController<RangeAndWindowIntervals>;
  property: NumericalSummaryProperty;
  boundElements: {
    window: NumericalBoundElements;
    range: NumericalBoundElements;
  };
  plotImg: HTMLImageElement;
  propertyHistogram: NumericalPropertyHistogram | undefined;
  bounds: RangeAndWindowIntervals;
  columnCheckbox: HTMLInputElement;
  sortIcon: HTMLElement;
}

function updateInputBoundWidth(inputElement: HTMLInputElement) {
  updateInputFieldWidth(
    inputElement,
    Math.max(1, inputElement.value.length + 0.1),
  );
}

function updateInputBoundValue(inputElement: HTMLInputElement, bound: number) {
  let boundString: string;
  if (Number.isInteger(bound)) {
    boundString = bound.toString();
  } else {
    const sFull = bound.toString();
    const sPrecision = bound.toPrecision(6);
    boundString = sFull.length < sPrecision.length ? sFull : sPrecision;
  }
  inputElement.value = boundString;
  updateInputBoundWidth(inputElement);
}

function createBoundInput(boundType: "range" | "window", endpointIndex: 0 | 1) {
  const e = document.createElement("input");
  e.addEventListener("focus", () => {
    e.select();
  });
  e.classList.add(
    `neuroglancer-segment-query-result-numerical-plot-${boundType}-bound`,
  );
  e.classList.add("neuroglancer-segment-query-result-numerical-plot-bound");
  e.type = "text";
  e.spellcheck = false;
  e.autocomplete = "off";
  e.title =
    (endpointIndex === 0 ? "Lower" : "Upper") +
    " bound " +
    (boundType === "range" ? "range" : "for distribution");
  e.addEventListener("input", () => {
    updateInputBoundWidth(e);
  });
  return e;
}

// --- Exported sort/column helpers ---------------------------------------------

/** Returns true when `fieldId` is in the query's `includeColumns` list. */
export function queryIncludesColumn(
  query: { includeColumns?: string[] } | undefined,
  fieldId: string,
): boolean {
  return query?.includeColumns?.includes(fieldId) ?? false;
}

/** Toggles inclusion of a column, removing its sort if it was being excluded. */
export function toggleIncludeColumn(
  query: NumericalSummaryQuery | undefined,
  setQuery: (q: NumericalSummaryQuery) => void,
  fieldId: string,
) {
  if (query === undefined) return;
  let { sortBy, includeColumns } = query;
  const included = queryIncludesColumn(query, fieldId);
  if (included) {
    sortBy = sortBy.filter((x) => x.fieldId !== fieldId);
    includeColumns = includeColumns.filter((x) => x !== fieldId);
  } else {
    includeColumns = [...includeColumns, fieldId];
  }
  setQuery({ ...query, sortBy, includeColumns });
}

/** Cycles the sort order for a field; also promotes it to a display column. */
export function toggleSortOrder(
  query: NumericalSummaryQuery | undefined,
  setQuery: (q: NumericalSummaryQuery) => void,
  id: string,
) {
  if (query === undefined) return;
  const { sortBy, includeColumns } = query;
  const prevOrder = sortBy.find((x) => x.fieldId === id)?.order;
  const newOrder = prevOrder === "<" ? ">" : "<";
  const newIncludeColumns = includeColumns.filter((x) => x !== id);
  for (const s of sortBy) {
    if (s.fieldId !== id) {
      newIncludeColumns.push(s.fieldId);
    }
  }
  setQuery({
    ...query,
    sortBy: [{ fieldId: id, order: newOrder }],
    includeColumns: newIncludeColumns,
  });
}

/** Updates a sort icon element to reflect the current sort order for `id`. */
export function updateColumnSortIcon(
  query: { sortBy?: SortBy[] } | undefined,
  sortIcon: HTMLElement,
  id: string,
) {
  const sortBy = query?.sortBy;
  const order = sortBy?.find((s) => s.fieldId === id)?.order;
  sortIcon.textContent = order === ">" ? "▼" : "▲";
  sortIcon.style.visibility = order === undefined ? "" : "visible";
  sortIcon.title = `Sort by ${id} in ${
    order === "<" ? "descending" : "ascending"
  } order`;
}

// --- NumericalPropertiesSummary -----------------------------------------------

/**
 * Renders a collapsible panel with one CDF histogram + range/window bound
 * inputs per numerical property.  Both the segment list and the annotation
 * list use this widget; they supply different `NumericalSummaryDataSource`
 * implementations.
 */
export class NumericalPropertiesSummary extends RefCounted {
  listElement: HTMLElement | undefined;
  properties: NumericalPropertySummaryWidget[];
  propertyHistograms: NumericalPropertyHistogram[] = [];
  bounds = {
    window: new WatchableValue<DataTypeInterval[]>([]),
    range: new WatchableValue<DataTypeInterval[]>([]),
  };

  throttledUpdate: DebouncedFunc<() => void> = this.registerCancellable(
    throttle(() => this.updateHistograms(), 100),
  );
  debouncedRender: DebouncedFunc<() => void> = this.registerCancellable(
    animationFrameDebounce(() => this.updateHistogramRenderings()),
  );
  debouncedSetQuery: DebouncedFunc<() => void> = this.registerCancellable(
    debounce(() => this.setQueryFromBounds(), 200),
  );

  constructor(
    public dataSource: NumericalSummaryDataSource,
    public queryResult: WatchableValueInterface<
      NumericalSummaryQueryResult | undefined
    >,
    public setQuery: (query: NumericalSummaryQuery) => void,
  ) {
    super();
    const { properties } = dataSource;
    const propertySummaries: NumericalPropertySummaryWidget[] = [];
    let listElement: HTMLElement | undefined;
    if (properties.length > 0) {
      listElement = document.createElement("details");
      const summaryElement = document.createElement("summary");
      summaryElement.textContent = `${properties.length} numerical propert${
        properties.length > 1 ? "ies" : "y"
      }`;
      listElement.appendChild(summaryElement);
      listElement.classList.add(
        "neuroglancer-segment-query-result-numerical-list",
      );
      const windowBounds = this.bounds.window.value;
      for (let i = 0, n = properties.length; i < n; ++i) {
        const property = properties[i];
        const summary = this.makePropertySummary(i, property);
        propertySummaries.push(summary);
        listElement.appendChild(summary.element);
        windowBounds[i] = property.bounds;
      }
    }
    this.listElement = listElement;
    this.properties = propertySummaries;
    this.registerDisposer(
      this.queryResult.changed.add(() => this.handleNewQueryResult()),
    );
    this.registerDisposer(this.bounds.window.changed.add(this.throttledUpdate));
    this.registerDisposer(this.bounds.window.changed.add(this.debouncedRender));
    this.registerDisposer(this.bounds.range.changed.add(this.debouncedRender));
    this.registerDisposer(
      this.bounds.range.changed.add(this.debouncedSetQuery),
    );
    this.handleNewQueryResult();
  }

  private setQueryFromBounds() {
    const queryResult = this.queryResult.value;
    if (queryResult === undefined) return;
    if (queryResult.indices === undefined) return;
    const { query } = queryResult;
    const numericalConstraints: NumericalPropertyConstraint[] = [];
    const constraintBounds = this.bounds.range.value;
    const { properties } = this;
    for (let i = 0, n = properties.length; i < n; ++i) {
      numericalConstraints.push({
        fieldId: properties[i].property.id,
        bounds: constraintBounds[i],
      });
    }
    this.setQuery({ ...query, numericalConstraints });
  }

  private getBounds(propertyIndex: number) {
    const { bounds } = this;
    return {
      range: bounds.range.value[propertyIndex],
      window: bounds.window.value[propertyIndex],
    };
  }

  private setBounds(propertyIndex: number, value: RangeAndWindowIntervals) {
    const { property } = this.properties[propertyIndex];
    let newRange = getClampedInterval(property.bounds, value.range);
    if (dataTypeCompare(newRange[0], newRange[1]) > 0) {
      newRange = [newRange[1], newRange[0]] as DataTypeInterval;
    }
    const newWindow = getClampedInterval(property.bounds, value.window);
    const oldValue = this.getBounds(propertyIndex);
    if (!dataTypeIntervalEqual(newWindow, oldValue.window)) {
      this.bounds.window.value[propertyIndex] = newWindow;
      this.bounds.window.changed.dispatch();
    }
    if (!dataTypeIntervalEqual(newRange, oldValue.range)) {
      this.bounds.range.value[propertyIndex] = newRange;
      this.bounds.range.changed.dispatch();
    }
  }

  private setBound(
    boundType: "range" | "window",
    endpoint: 0 | 1,
    propertyIndex: number,
    value: number,
  ) {
    const property = this.dataSource.properties[propertyIndex];
    const baseBounds = property.bounds;
    value = clampToInterval(baseBounds, value) as number;
    const params = this.getBounds(propertyIndex);
    const newParams = getUpdatedRangeAndWindowParameters(
      params,
      boundType,
      endpoint,
      value,
      /*fitRangeInWindow=*/ true,
    );
    this.setBounds(propertyIndex, newParams);
  }

  private handleNewQueryResult() {
    const queryResult = this.queryResult.value;
    const { listElement } = this;
    if (listElement === undefined) return;
    if (queryResult?.indices !== undefined) {
      const { numericalConstraints } = queryResult.query;
      const numericalProperties = this.dataSource.properties;
      const constraintBounds = this.bounds.range.value;
      const numProperties = numericalProperties.length;
      constraintBounds.length = numProperties;
      for (let i = 0; i < numProperties; ++i) {
        constraintBounds[i] = numericalProperties[i].bounds;
      }
      for (const constraint of numericalConstraints) {
        const propertyIndex = numericalProperties.findIndex(
          (p) => p.id === constraint.fieldId,
        );
        if (propertyIndex !== -1) {
          constraintBounds[propertyIndex] = constraint.bounds;
        }
      }
    }
    this.updateHistograms();
    this.throttledUpdate.cancel();
  }

  private updateHistograms() {
    const queryResult = this.queryResult.value;
    const { listElement } = this;
    if (listElement === undefined) return;
    this.dataSource.updateHistograms(
      queryResult,
      this.propertyHistograms,
      this.bounds.window.value,
    );
    this.updateHistogramRenderings();
  }

  private updateHistogramRenderings() {
    this.debouncedRender.cancel();
    const { listElement } = this;
    if (listElement === undefined) return;
    const { propertyHistograms } = this;
    if (propertyHistograms.length === 0) {
      listElement.style.display = "none";
      return;
    }
    listElement.style.display = "";
    const { properties } = this;
    for (let i = 0, n = properties.length; i < n; ++i) {
      this.updatePropertySummaryRendering(
        i,
        properties[i],
        propertyHistograms[i],
      );
    }
  }

  private makePropertySummary(
    propertyIndex: number,
    property: NumericalSummaryProperty,
  ): NumericalPropertySummaryWidget {
    const plotContainer = document.createElement("div");
    plotContainer.classList.add(
      "neuroglancer-segment-query-result-numerical-plot-container",
    );
    const plotImg = document.createElement("img");
    plotImg.classList.add("neuroglancer-segment-query-result-numerical-plot");
    const controller = new CdfController(
      plotImg,
      property.dataType,
      () => this.getBounds(propertyIndex),
      (bounds) => this.setBounds(propertyIndex, bounds),
    );
    const sortIcon = document.createElement("span");
    sortIcon.classList.add(
      "neuroglancer-segment-query-result-numerical-plot-sort",
    );
    const columnCheckbox = document.createElement("input");
    columnCheckbox.type = "checkbox";
    columnCheckbox.addEventListener("click", () => {
      const q = this.queryResult.value?.query;
      if (q === undefined) return;
      toggleIncludeColumn(q, this.setQuery, property.id);
    });
    const makeBoundElements = (
      boundType: "window" | "range",
    ): NumericalBoundElements => {
      const container = document.createElement("div");
      container.classList.add(
        "neuroglancer-segment-query-result-numerical-plot-bounds",
      );
      container.classList.add(
        `neuroglancer-segment-query-result-numerical-plot-bounds-${boundType}`,
      );
      const makeBoundElement = (endpointIndex: 0 | 1) => {
        const e = createBoundInput(boundType, endpointIndex);
        e.addEventListener("change", () => {
          const existingBounds = this.bounds[boundType].value[propertyIndex];
          if (existingBounds === undefined) return;
          try {
            const value = parseDataTypeValue(property.dataType, e.value);
            this.setBound(
              boundType,
              endpointIndex,
              propertyIndex,
              value as number,
            );
            this.bounds[boundType].changed.dispatch();
          } catch {
            // Ignore invalid input.
          }
          updateInputBoundValue(
            e,
            this.bounds[boundType].value[propertyIndex][
              endpointIndex
            ] as number,
          );
        });
        return e;
      };
      const inputs: [HTMLInputElement, HTMLInputElement] = [
        makeBoundElement(0),
        makeBoundElement(1),
      ];
      let spacers: [HTMLElement, HTMLElement, HTMLElement] | undefined;
      if (boundType === "range") {
        spacers = [
          document.createElement("div"),
          document.createElement("div"),
          document.createElement("div"),
        ];
        spacers[1].classList.add(
          "neuroglancer-segment-query-result-numerical-plot-bound-constraint-spacer",
        );
        spacers[1].appendChild(columnCheckbox);
        const label = document.createElement("span");
        label.classList.add(
          "neuroglancer-segment-query-result-numerical-plot-label",
        );
        label.appendChild(document.createTextNode(property.id));
        label.appendChild(sortIcon);
        label.addEventListener("click", () => {
          const q = this.queryResult.value?.query;
          if (q === undefined) return;
          toggleSortOrder(q, this.setQuery, property.id);
        });
        spacers[1].appendChild(label);
        if (property.description) {
          spacers[1].title = property.description;
        }
        container.appendChild(spacers[0]);
        container.appendChild(inputs[0]);
        const lessEqual1 = document.createElement("div");
        lessEqual1.textContent = "≤";
        lessEqual1.classList.add(
          "neuroglancer-segment-query-result-numerical-plot-bound-constraint-symbol",
        );
        container.appendChild(lessEqual1);
        container.appendChild(spacers[1]);
        const lessEqual2 = document.createElement("div");
        lessEqual2.textContent = "≤";
        lessEqual2.classList.add(
          "neuroglancer-segment-query-result-numerical-plot-bound-constraint-symbol",
        );
        container.appendChild(lessEqual2);
        container.appendChild(inputs[1]);
        container.appendChild(spacers[2]);
      } else {
        container.appendChild(inputs[0]);
        container.appendChild(inputs[1]);
      }
      return { container, spacers, inputs };
    };
    const boundElements = {
      range: makeBoundElements("range"),
      window: makeBoundElements("window"),
    };
    plotContainer.appendChild(boundElements.range.container);
    plotContainer.appendChild(plotImg);
    plotContainer.appendChild(boundElements.window.container);
    return {
      property,
      controller,
      element: plotContainer,
      plotImg,
      boundElements,
      bounds: {
        window: [NaN, NaN],
        range: [NaN, NaN],
      },
      propertyHistogram: undefined,
      columnCheckbox,
      sortIcon,
    };
  }

  private updatePropertySummaryRendering(
    propertyIndex: number,
    summary: NumericalPropertySummaryWidget,
    propertyHistogram: NumericalPropertyHistogram,
  ) {
    const prevWindowBounds = summary.bounds.window;
    const windowBounds = this.bounds.window.value[propertyIndex]!;
    const prevConstraintBounds = summary.bounds.range;
    const constraintBounds = this.bounds.range.value[propertyIndex]!;
    const { property } = summary;
    const query = this.queryResult.value?.query;
    const isIncluded = queryIncludesColumn(query, property.id);
    summary.columnCheckbox.checked = isIncluded;
    summary.columnCheckbox.title = isIncluded
      ? "Remove column from result table"
      : "Add column to result table";
    updateColumnSortIcon(query, summary.sortIcon, property.id);
    if (
      summary.propertyHistogram === propertyHistogram &&
      dataTypeIntervalEqual(prevWindowBounds, windowBounds) &&
      dataTypeIntervalEqual(prevConstraintBounds, constraintBounds)
    ) {
      return;
    }
    const { histogram } = propertyHistogram;
    const svgNs = "http://www.w3.org/2000/svg";
    const plotElement = document.createElementNS(svgNs, "svg");
    plotElement.setAttribute("width", "1");
    plotElement.setAttribute("height", "1");
    plotElement.setAttribute("preserveAspectRatio", "none");
    const rect = document.createElementNS(svgNs, "rect");
    const constraintStartX = computeInvlerp(windowBounds, constraintBounds[0]);
    const constraintEndX = computeInvlerp(windowBounds, constraintBounds[1]);
    rect.setAttribute("x", `${constraintStartX}`);
    rect.setAttribute("y", "0");
    rect.setAttribute("width", `${constraintEndX - constraintStartX}`);
    rect.setAttribute("height", "1");
    rect.setAttribute("fill", "#4f4f4f");
    plotElement.appendChild(rect);
    const numBins = histogram.length;
    const makeCdfLine = (
      startBinIndex: number,
      endBinIndex: number,
      endBinIndexForTotal: number,
    ) => {
      const polyLine = document.createElementNS(svgNs, "polyline");
      let points = "";
      let totalCount = 0;
      for (let i = startBinIndex; i < endBinIndexForTotal; ++i) {
        totalCount += histogram[i];
      }
      if (totalCount === 0) return undefined;
      const startBinX = computeInvlerp(
        windowBounds,
        propertyHistogram.window[0],
      );
      const endBinX = computeInvlerp(windowBounds, propertyHistogram.window[1]);
      const addPoint = (i: number, height: number) => {
        const fraction = i / (numBins - 2);
        const x = startBinX * (1 - fraction) + endBinX * fraction;
        points += ` ${x},${1 - height}`;
      };
      if (startBinIndex !== 0) {
        addPoint(startBinIndex, 0);
      }
      let cumSum = 0;
      for (let i = startBinIndex; i < endBinIndex; ++i) {
        const count = histogram[i];
        cumSum += count;
        addPoint(i, cumSum / totalCount);
      }
      polyLine.setAttribute("fill", "none");
      polyLine.setAttribute("stroke-width", "1px");
      polyLine.setAttribute("points", points);
      polyLine.setAttribute("vector-effect", "non-scaling-stroke");
      return polyLine;
    };

    {
      const polyLine = makeCdfLine(0, numBins - 1, numBins);
      if (polyLine !== undefined) {
        polyLine.setAttribute("stroke", "cyan");
        plotElement.appendChild(polyLine);
      }
    }

    if (!dataTypeIntervalEqual(property.bounds, constraintBounds)) {
      const constraintStartBin = Math.floor(
        Math.max(
          0,
          Math.min(
            1,
            computeInvlerp(propertyHistogram.window, constraintBounds[0]),
          ),
        ) *
          (numBins - 2),
      );
      const constraintEndBin = Math.ceil(
        Math.max(
          0,
          Math.min(
            1,
            computeInvlerp(propertyHistogram.window, constraintBounds[1]),
          ),
        ) *
          (numBins - 2),
      );
      const polyLine = makeCdfLine(
        constraintStartBin,
        constraintEndBin,
        constraintEndBin,
      );
      if (polyLine !== undefined) {
        polyLine.setAttribute("stroke", "white");
        plotElement.appendChild(polyLine);
      }
    }

    const xml = new XMLSerializer().serializeToString(plotElement);
    summary.plotImg.src = `data:image/svg+xml;base64,${btoa(xml)}`;
    summary.propertyHistogram = propertyHistogram;
    for (let endpointIndex = 0; endpointIndex < 2; ++endpointIndex) {
      prevWindowBounds[endpointIndex] = windowBounds[endpointIndex];
      updateInputBoundValue(
        summary.boundElements.window.inputs[endpointIndex],
        windowBounds[endpointIndex] as number,
      );
      prevConstraintBounds[endpointIndex] = constraintBounds[endpointIndex];
      updateInputBoundValue(
        summary.boundElements.range.inputs[endpointIndex],
        constraintBounds[endpointIndex] as number,
      );
    }

    const spacers = summary.boundElements.range.spacers!;
    const clampedRange = getClampedInterval(windowBounds, constraintBounds);
    const effectiveFraction = getIntervalBoundsEffectiveFraction(
      property.dataType,
      windowBounds,
    );
    const leftOffset =
      computeInvlerp(windowBounds, clampedRange[0]) * effectiveFraction;
    const rightOffset =
      computeInvlerp(windowBounds, clampedRange[1]) * effectiveFraction +
      (1 - effectiveFraction);
    spacers[0].style.width = `${leftOffset * 100}%`;
    spacers[2].style.width = `${(1 - rightOffset) * 100}%`;
  }
}

// --- renderIncludeExcludeChips ------------------------------------------------

/**
 * Renders a grid of include/exclude toggle chips (e.g. for enum values or
 * tags).  Each chip shows a +/- CheckboxIcon pair and a label with count.
 *
 * Reuses `neuroglancer-segment-query-result-tag-*` CSS classes so both the
 * segment tag panel and the annotation enum/bool panel look identical.
 */
export function renderIncludeExcludeChips(
  chips: IncludeExcludeChip[],
): HTMLElement | undefined {
  if (chips.length === 0) return undefined;
  const list = document.createElement("div");
  list.classList.add("neuroglancer-segment-query-result-tag-list");
  for (const chip of chips) {
    const chipElement = document.createElement("div");
    chipElement.classList.add("neuroglancer-segment-query-result-tag");
    const inQuery = chip.included || chip.excluded;
    const addToggleButton = (include: boolean) => {
      const sideCount = include ? chip.count : chip.totalCount - chip.count;
      const toggleEl = document.createElement("div");
      toggleEl.classList.add("neuroglancer-segment-query-result-tag-toggle");
      toggleEl.classList.add(
        `neuroglancer-segment-query-result-tag-${include ? "include" : "exclude"}`,
      );
      chipElement.appendChild(toggleEl);
      if (!inQuery && sideCount === 0) return;
      const selected = include ? chip.included : chip.excluded;
      toggleEl.appendChild(
        new CheckboxIcon(
          {
            get value() {
              return selected;
            },
            set value(v: boolean) {
              chip.onToggle(include ? "include" : "exclude", v);
            },
            changed: neverSignal,
          },
          {
            text: include ? "+" : "-",
            enableTitle: `Add to ${include ? "required" : "exclusion"} set`,
            disableTitle: `Remove from ${include ? "required" : "exclusion"} set`,
            backgroundScheme: "dark",
          },
        ).element,
      );
    };
    addToggleButton(true);
    addToggleButton(false);

    if (chip.headerLabel !== undefined) {
      const tagArea = document.createElement("span");
      tagArea.style.gridColumn = "tag";
      tagArea.style.whiteSpace = "nowrap";
      const headerBtn = document.createElement("button");
      headerBtn.classList.add(
        "neuroglancer-segment-query-result-tag-header-btn",
      );
      headerBtn.textContent = chip.headerLabel;
      headerBtn.dataset.active = chip.headerActive ? "true" : "false";
      if (chip.desc) headerBtn.title = chip.desc;
      headerBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        chip.onHeaderClick?.();
      });
      tagArea.appendChild(headerBtn);
      if (chip.label) {
        const valSpan = document.createElement("span");
        valSpan.textContent = chip.label;
        valSpan.style.color = "rgba(255,255,255,0.6)";
        tagArea.appendChild(valSpan);
      }
      chipElement.appendChild(tagArea);
    } else {
      const labelEl = document.createElement("span");
      labelEl.classList.add("neuroglancer-segment-query-result-tag-name");
      labelEl.textContent = chip.label;
      if (chip.desc) labelEl.title = chip.desc;
      labelEl.addEventListener("click", () => {
        chip.onToggle("include", !chip.included && !chip.excluded);
      });
      chipElement.appendChild(labelEl);
    }

    const countEl = document.createElement("span");
    countEl.classList.add("neuroglancer-segment-query-result-tag-count");
    if (!inQuery) {
      countEl.textContent = String(chip.count);
    }
    chipElement.appendChild(countEl);
    list.appendChild(chipElement);
  }
  return list;
}
