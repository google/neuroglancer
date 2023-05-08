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

import './segment_list.css';

import debounce from 'lodash/debounce';
import throttle from 'lodash/throttle';
import {SegmentationDisplayState, SegmentWidgetWithExtraColumnsFactory} from 'neuroglancer/segmentation_display_state/frontend';
import {changeTagConstraintInSegmentQuery, executeSegmentQuery, ExplicitIdQuery, FilterQuery, findQueryResultIntersectionSize, forEachQueryResultSegmentIdGenerator, InlineSegmentNumericalProperty, isQueryUnconstrained, NumericalPropertyConstraint, parseSegmentQuery, PreprocessedSegmentPropertyMap, PropertyHistogram, queryIncludesColumn, QueryResult, unparseSegmentQuery, updatePropertyHistograms} from 'neuroglancer/segmentation_display_state/property_map';
import type {SegmentationUserLayer, SegmentationUserLayerGroupState} from 'neuroglancer/segmentation_user_layer';
import {observeWatchable, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {getDefaultSelectBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {ArraySpliceOp, getMergeSplices} from 'neuroglancer/util/array';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, updateInputFieldWidth} from 'neuroglancer/util/dom';
import {EventActionMap, KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {neverSignal, Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {CheckboxIcon} from 'neuroglancer/widget/checkbox_icon';
import {makeCopyButton} from 'neuroglancer/widget/copy_button';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';
import {Tab} from 'neuroglancer/widget/tab_view';
import {VirtualList, VirtualListSource} from 'neuroglancer/widget/virtual_list';
import {clampToInterval, computeInvlerp, dataTypeCompare, DataTypeInterval, dataTypeIntervalEqual, getClampedInterval, getIntervalBoundsEffectiveFraction, parseDataTypeValue} from 'neuroglancer/util/lerp';
import {CdfController, getUpdatedRangeAndWindowParameters, RangeAndWindowIntervals} from 'neuroglancer/widget/invlerp';
import {makeToolButton} from 'neuroglancer/ui/tool';
import {ANNOTATE_MERGE_SEGMENTS_TOOL_ID, ANNOTATE_SPLIT_SEGMENTS_TOOL_ID} from 'neuroglancer/ui/segment_split_merge_tools';
import {SELECT_SEGMENTS_TOOLS_ID} from 'neuroglancer/ui/segment_select_tools';
import {makeStarButton} from 'neuroglancer/widget/star_button';
import { DebouncedFunc } from 'lodash';

const tempUint64 = new Uint64();

abstract class SegmentListSource extends RefCounted implements VirtualListSource {
  length: number;
  changed = new Signal<(splices: readonly Readonly<ArraySpliceOp>[]) => void>();

  // The segment list is the concatenation of two lists: the `explicitSegments` list, specified as
  // explicit uint64 ids, and the `matches`, list, specifying the indices into the
  // `segmentPropertyMap` of the matching segments.
  explicitSegments: Uint64[]|undefined;
  explicitSegmentsVisible: boolean = false;

  debouncedUpdate = debounce(() => this.update(), 0);

  constructor(
      public segmentationDisplayState: SegmentationDisplayState,
      public parentElement: HTMLElement) {
    super();
  }

  abstract update(): void

  private updateRendering(element: HTMLElement) {
    this.segmentWidgetFactory.update(element);
  }

  segmentWidgetFactory: SegmentWidgetWithExtraColumnsFactory;

  abstract render(index: number): HTMLDivElement;

  updateRenderedItems(list: VirtualList) {
    list.forEachRenderedItem(element => {
      this.updateRendering(element);
    });
  }
}

class StarredSegmentsListSource extends SegmentListSource {
  explicitSegmentsVisible: true;

  constructor(
      public segmentationDisplayState: SegmentationDisplayState,
      public parentElement: HTMLElement) {
    super(segmentationDisplayState, parentElement);
    this.update();
    this.registerDisposer(
        segmentationDisplayState.segmentationGroupState.value.selectedSegments.changed.add(
            this.debouncedUpdate));
  }

  update() {
    const splices: ArraySpliceOp[] = [];
    const {selectedSegments} = this.segmentationDisplayState.segmentationGroupState.value;
    const newSelectedSegments = [...selectedSegments];
    const {explicitSegments} = this;
    if (explicitSegments === undefined) {
      splices.push(
          {retainCount: 0, insertCount: newSelectedSegments.length, deleteCount: 0});
    } else {
      splices.push(
          ...getMergeSplices(explicitSegments, newSelectedSegments, Uint64.compare));
    }
    this.explicitSegments = newSelectedSegments;
    this.length = selectedSegments.size;
    this.changed.dispatch(splices);
  }

  render = (index: number) => {
    const {explicitSegments} = this;
    const id = explicitSegments![index];
    return this.segmentWidgetFactory.get(id);
  };
}

class SegmentQueryListSource extends SegmentListSource {
  prevQuery: string|undefined;
  queryResult = new WatchableValue<QueryResult|undefined>(undefined);
  prevQueryResult = new WatchableValue<QueryResult|undefined>(undefined);
  statusText = new WatchableValue<string>('');
  selectedMatches: number = 0;
  matchStatusTextPrefix: string = '';
  selectedSegmentsGeneration = -1;
  explicitSegmentsVisible = false;

  get numMatches() {
    return this.queryResult.value?.count ?? 0;
  }

  update() {
    const query = this.query.value;
    const {segmentPropertyMap} = this;
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
    let matchStatusTextPrefix = '';
    const unconstrained = isQueryUnconstrained(queryResult.query);      
    if (!unconstrained) {
      if (this.explicitSegments !== undefined && this.explicitSegmentsVisible) {
        splices.push({deleteCount: this.explicitSegments.length, retainCount: 0, insertCount: 0});
        this.explicitSegments = undefined;
        changed = true;
      }
    }

    const {explicitIds} = queryResult;
    if (explicitIds !== undefined) {
      this.explicitSegments = explicitIds;
    } else if (!this.explicitSegmentsVisible) {
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
      matchStatusTextPrefix = `${queryResult.count} listed ids`;
    } else if (queryResult.total > 0) {
      matchStatusTextPrefix = `${queryResult.count}/${queryResult.total} matches`;
    }

    const {selectedSegments} = this.segmentationDisplayState.segmentationGroupState.value;
    const selectedSegmentsGeneration = selectedSegments.changed.count;
    const prevSelectedSegmentsGeneration = this.selectedSegmentsGeneration;
    const selectedChanged = prevSelectedSegmentsGeneration !== selectedSegmentsGeneration;
    this.selectedSegmentsGeneration = selectedSegmentsGeneration;


    if (prevQueryResult !== queryResult || selectedChanged) {
      let statusText = matchStatusTextPrefix;
      let selectedMatches = 0;
      if (segmentPropertyMap !== undefined && queryResult.count > 0) {
        // Recompute selectedMatches.
        const {selectedSegments} = this.segmentationDisplayState.segmentationGroupState.value;
        selectedMatches =
            findQueryResultIntersectionSize(segmentPropertyMap, queryResult, selectedSegments);
        statusText += ` (${selectedMatches} selected)`;
      }
      this.selectedMatches = selectedMatches;
      this.statusText.value = statusText;
    }
    this.prevQuery = query;
    this.matchStatusTextPrefix = matchStatusTextPrefix;
    this.length = queryResult.count;
    if (changed) {
      this.changed.dispatch(splices);
    }
  }

  constructor(
      public query: WatchableValueInterface<string>,
      public segmentPropertyMap: PreprocessedSegmentPropertyMap|undefined,
      public segmentationDisplayState: SegmentationDisplayState,
      public parentElement: HTMLElement) {
    super(segmentationDisplayState, parentElement);
    this.update();
    this.registerDisposer(
        segmentationDisplayState.segmentationGroupState.value.selectedSegments.changed.add(
            this.debouncedUpdate)); // to update statusText
    if (query) {
      this.registerDisposer(query.changed.add(this.debouncedUpdate));
    }
  }

  render = (index: number) => {
    const {explicitSegments} = this;
    let id: Uint64;
    if (explicitSegments !== undefined) {
      id = explicitSegments[index];
    } else {
      id = tempUint64;
      const propIndex = this.queryResult.value!.indices![index];
      const {ids} = this.segmentPropertyMap!.segmentPropertyMap.inlineProperties!;
      id.low = ids[propIndex * 2];
      id.high = ids[propIndex * 2 + 1];
    }
    return this.segmentWidgetFactory.get(id);
  };
}

const keyMap = EventActionMap.fromObject({
  'enter': {action: 'toggle-listed'},
  'shift+enter': {action: 'hide-listed'},
  'control+enter': {action: 'hide-all'},
  'escape': {action: 'cancel'},
});

const selectSegmentConfirmationThreshold = 100;

interface NumericalBoundElements {
  container: HTMLElement;
  inputs: [HTMLInputElement, HTMLInputElement];
  spacers: [HTMLElement, HTMLElement, HTMLElement]|undefined;
}

interface NumericalPropertySummary {
  element: HTMLElement;
  controller: CdfController<RangeAndWindowIntervals>;
  property: InlineSegmentNumericalProperty;
  boundElements: {
    window: NumericalBoundElements,
    range: NumericalBoundElements,
  };
  plotImg: HTMLImageElement;
  propertyHistogram: PropertyHistogram|undefined;
  bounds: RangeAndWindowIntervals;
  columnCheckbox: HTMLInputElement;
  sortIcon: HTMLElement;
}

function updateInputBoundWidth(inputElement: HTMLInputElement) {
  updateInputFieldWidth(inputElement, Math.max(1, inputElement.value.length + 0.1));
}

function updateInputBoundValue(inputElement: HTMLInputElement, bound: number) {
  let boundString: string;
  if (Number.isInteger(bound)) {
    boundString = bound.toString();
  } else {
    const sFull = bound.toString();
    const sPrecision = bound.toPrecision(6);
    boundString = (sFull.length < sPrecision.length) ? sFull : sPrecision;
  }
  inputElement.value = boundString;
  updateInputBoundWidth(inputElement);
}

function createBoundInput(boundType: 'range'|'window', endpointIndex: 0|1) {
  const e = document.createElement('input');
  e.addEventListener('focus', () => {
    e.select();
  });
  e.classList.add(`neuroglancer-segment-query-result-numerical-plot-${boundType}-bound`);
  e.classList.add('neuroglancer-segment-query-result-numerical-plot-bound');
  e.type = 'text';
  e.spellcheck = false;
  e.autocomplete = 'off';
  e.title = (endpointIndex === 0 ? 'Lower' : 'Upper') + ' bound ' +
      (boundType === 'range' ? 'range' : 'for distribution');
  e.addEventListener('input', () => {
    updateInputBoundWidth(e);
  });
  return e;
}

function toggleIncludeColumn(
    queryResult: QueryResult|undefined, setQuery: (query: FilterQuery) => void, fieldId: string) {
  if (queryResult === undefined) return;
  if (queryResult.indices === undefined) return;
  const query = queryResult.query as FilterQuery;
  let {sortBy, includeColumns} = query;
  const included = queryIncludesColumn(query, fieldId);
  if (included) {
    sortBy = sortBy.filter(x => x.fieldId !== fieldId);
    includeColumns = includeColumns.filter(x => x !== fieldId);
  } else {
    includeColumns.push(fieldId);
  }
  setQuery({...query, sortBy, includeColumns});
}

function toggleSortOrder(
    queryResult: QueryResult|undefined, setQuery: (query: FilterQuery) => void, id: string) {
  const query = queryResult?.query;
  const sortBy = query?.sortBy;
  if (sortBy === undefined) return;
  const {includeColumns} = (query as FilterQuery);
  const prevOrder = sortBy.find(x => x.fieldId === id)?.order;
  const newOrder = (prevOrder === '<') ? '>' : '<';
  const newIncludeColumns = includeColumns.filter(x => x !== id);
  for (const s of sortBy) {
    if (s.fieldId !== 'id' && s.fieldId !== 'label' && s.fieldId !== id) {
      newIncludeColumns.push(s.fieldId);
    }
  }
  setQuery({
    ...query as FilterQuery,
    sortBy: [{fieldId: id, order: newOrder}],
    includeColumns: newIncludeColumns,
  });
}

function updateColumnSortIcon(
    queryResult: QueryResult|undefined, sortIcon: HTMLElement, id: string) {
  const sortBy = queryResult?.query?.sortBy;
  const order = sortBy?.find(s => s.fieldId === id)?.order;
  sortIcon.textContent = order === '>' ? '▼' : '▲';
  sortIcon.style.visibility = order === undefined ? '' : 'visible';
  sortIcon.title = `Sort by ${id} in ${order === '<' ? 'descending' : 'ascending'} order`;
}

class NumericalPropertiesSummary extends RefCounted {
  listElement: HTMLElement|undefined;
  properties: NumericalPropertySummary[];
  propertyHistograms: PropertyHistogram[] = [];
  bounds = {
    window: new WatchableValue<DataTypeInterval[]>([]),
    range: new WatchableValue<DataTypeInterval[]>([]),
  };

  throttledUpdate = this.registerCancellable(throttle(() => this.updateHistograms(), 100));
  debouncedRender =
      this.registerCancellable(animationFrameDebounce(() => this.updateHistogramRenderings()));
  debouncedSetQuery = this.registerCancellable(debounce(() => this.setQueryFromBounds(), 200));

  constructor(
      public segmentPropertyMap: PreprocessedSegmentPropertyMap|undefined,
      public queryResult: WatchableValueInterface<QueryResult|undefined>,
      public setQuery: (query: FilterQuery) => void) {
    super();
    const properties = segmentPropertyMap?.numericalProperties;
    const propertySummaries: NumericalPropertySummary[] = [];
    let listElement: HTMLElement|undefined;
    if (properties !== undefined && properties.length > 0) {
      listElement = document.createElement('details');
      const summaryElement = document.createElement('summary');
      summaryElement.textContent = `${properties.length} numerical propert${properties.length > 1 ? 'ies' : 'y'}`;
      listElement.appendChild(summaryElement);
      listElement.classList.add('neuroglancer-segment-query-result-numerical-list');
      const windowBounds = this.bounds.window.value;
      for (let i = 0, numProperties = properties.length; i < numProperties; ++i) {
        const property = properties[i];
        const summary = this.makeNumericalPropertySummary(i, property);
        propertySummaries.push(summary);
        listElement.appendChild(summary.element);
        windowBounds[i] = property.bounds;
      }
    }
    this.listElement = listElement;
    this.properties = propertySummaries;
    this.registerDisposer(this.queryResult.changed.add(() => {
      this.handleNewQueryResult();
    }));
    // When window bounds change, we need to recompute histograms.  Throttle this to avoid
    // excessive computation time.
    this.registerDisposer(this.bounds.window.changed.add(this.throttledUpdate));
    // When window bounds or constraint bounds change, re-render the plot on the next animation
    // frame.
    this.registerDisposer(this.bounds.window.changed.add(this.debouncedRender));
    this.registerDisposer(this.bounds.range.changed.add(this.debouncedRender));
    this.registerDisposer(this.bounds.range.changed.add(this.debouncedSetQuery));
    this.handleNewQueryResult();
  }

  private setQueryFromBounds() {
    const queryResult = this.queryResult.value;
    if (queryResult === undefined) return;
    if (queryResult.indices === undefined) return;
    const query = queryResult.query as FilterQuery;
    const numericalConstraints: NumericalPropertyConstraint[] = [];
    const constraintBounds = this.bounds.range.value;
    const {properties} = this;
    for (let i = 0, numProperties = properties.length; i < numProperties; ++i) {
      const property = properties[i].property;
      numericalConstraints.push({fieldId: property.id, bounds: constraintBounds[i]});
    }
    this.setQuery({...query, numericalConstraints});
  }

  private getBounds(propertyIndex: number) {
    const {bounds} = this;
    return {range: bounds.range.value[propertyIndex], window: bounds.window.value[propertyIndex]};
  }

  private setBounds(propertyIndex: number, value: RangeAndWindowIntervals) {
    const {property} = this.properties[propertyIndex];
    let newRange = getClampedInterval(property.bounds, value.range);
    if (dataTypeCompare(newRange[0], newRange[1]) > 0) {
      newRange = [newRange[1], newRange[0]] as DataTypeInterval;
    }
    const newWindow = getClampedInterval(property.bounds, value.window);
    const oldValue = this.getBounds(propertyIndex);
    const {dataType} = this.properties[propertyIndex].property;
    if (!dataTypeIntervalEqual(dataType, newWindow, oldValue.window)) {
      this.bounds.window.value[propertyIndex] = newWindow;
      this.bounds.window.changed.dispatch();
    }
    if (!dataTypeIntervalEqual(dataType, newRange, oldValue.range)) {
      this.bounds.range.value[propertyIndex] = newRange;
      this.bounds.range.changed.dispatch();
    }
  }

  private setBound(
      boundType: 'range'|'window', endpoint: 0|1, propertyIndex: number, value: number) {
    const property = this.segmentPropertyMap!.numericalProperties[propertyIndex];
    const baseBounds = property.bounds;
    value = clampToInterval(baseBounds, value) as number;
    const params = this.getBounds(propertyIndex);
    const newParams = getUpdatedRangeAndWindowParameters(
        params, boundType, endpoint, value, /*fitRangeInWindow=*/ true);
    this.setBounds(propertyIndex, newParams);
  }

  private handleNewQueryResult() {
    const queryResult = this.queryResult.value;
    const {listElement} = this;
    if (listElement === undefined) return;
    if (queryResult?.indices !== undefined) {
      const {numericalConstraints} = (queryResult!.query as FilterQuery);
      const {numericalProperties} = this.segmentPropertyMap!;
      const constraintBounds = this.bounds.range.value;
      const numConstraints = numericalConstraints.length;
      const numProperties = numericalProperties.length;
      constraintBounds.length = numProperties;
      for (let i = 0; i < numProperties; ++i) {
        constraintBounds[i] = numericalProperties[i].bounds;
      }
      for (let i = 0; i < numConstraints; ++i) {
        const constraint = numericalConstraints[i];
        const propertyIndex = numericalProperties.findIndex(p => p.id === constraint.fieldId);
        constraintBounds[propertyIndex] = constraint.bounds;
      }
    }
    this.updateHistograms();
    this.throttledUpdate.cancel();
  }

  private updateHistograms() {
    const queryResult = this.queryResult.value;
    const {listElement} = this;
    if (listElement === undefined) return;
    updatePropertyHistograms(
        this.segmentPropertyMap, queryResult, this.propertyHistograms, this.bounds.window.value);
    this.updateHistogramRenderings();
  }

  private updateHistogramRenderings() {
    this.debouncedRender.cancel();
    const {listElement} = this;
    if (listElement === undefined) return;
    const {propertyHistograms} = this;
    if (propertyHistograms.length === 0) {
      listElement.style.display = 'none';
      return;
    }
    listElement.style.display = '';
    const {properties} = this;
    for (let i = 0, n = properties.length; i < n; ++i) {
      this.updateNumericalPropertySummary(i, properties[i], propertyHistograms[i]);
    }
  }

  private makeNumericalPropertySummary(
      propertyIndex: number, property: InlineSegmentNumericalProperty): NumericalPropertySummary {
    const plotContainer = document.createElement('div');
    plotContainer.classList.add('neuroglancer-segment-query-result-numerical-plot-container');
    const plotImg = document.createElement('img');
    plotImg.classList.add('neuroglancer-segment-query-result-numerical-plot');
    const controller = new CdfController(
        plotImg, property.dataType, () => this.getBounds(propertyIndex),
        bounds => this.setBounds(propertyIndex, bounds));
    const sortIcon = document.createElement('span');
    sortIcon.classList.add('neuroglancer-segment-query-result-numerical-plot-sort');
    const columnCheckbox = document.createElement('input');
    columnCheckbox.type = 'checkbox';
    columnCheckbox.addEventListener('click', () => {
      toggleIncludeColumn(this.queryResult.value, this.setQuery, property.id);
    });
    const makeBoundElements = (boundType: 'window'|'range'): NumericalBoundElements => {
      const container = document.createElement('div');
      container.classList.add('neuroglancer-segment-query-result-numerical-plot-bounds');
      container.classList.add(
          `neuroglancer-segment-query-result-numerical-plot-bounds-${boundType}`);
      const makeBoundElement = (endpointIndex: 0|1) => {
        const e = createBoundInput(boundType, endpointIndex);
        e.addEventListener('change', () => {
          const existingBounds = this.bounds[boundType].value[propertyIndex];
          if (existingBounds === undefined) return;
          try {
            const value = parseDataTypeValue(property.dataType, e.value);
            this.setBound(boundType, endpointIndex, propertyIndex, value as number);
            this.bounds[boundType].changed.dispatch();
          } catch {
          }
          updateInputBoundValue(
              e, this.bounds[boundType].value[propertyIndex][endpointIndex] as number);
        });
        return e;
      };
      const inputs: [HTMLInputElement, HTMLInputElement] =
          [makeBoundElement(0), makeBoundElement(1)];

      let spacers: [HTMLElement, HTMLElement, HTMLElement]|undefined;
      if (boundType === 'range') {
        spacers = [
          document.createElement('div'),
          document.createElement('div'),
          document.createElement('div'),
        ];
        spacers[1].classList.add(
            'neuroglancer-segment-query-result-numerical-plot-bound-constraint-spacer');
        spacers[1].appendChild(columnCheckbox);
        const label = document.createElement('span');
        label.classList.add('neuroglancer-segment-query-result-numerical-plot-label');
        label.appendChild(document.createTextNode(property.id));
        label.appendChild(sortIcon);
        label.addEventListener('click', () => {
          toggleSortOrder(this.queryResult.value, this.setQuery, property.id);
        });
        spacers[1].appendChild(label);
        const {description} = property;
        if (description) {
          spacers[1].title = description;
        }
        container.appendChild(spacers[0]);
        container.appendChild(inputs[0]);
        const lessEqual1 = document.createElement('div');
        lessEqual1.textContent = '≤';
        lessEqual1.classList.add(
            'neuroglancer-segment-query-result-numerical-plot-bound-constraint-symbol');
        container.appendChild(lessEqual1);
        container.appendChild(spacers[1]);
        const lessEqual2 = document.createElement('div');
        lessEqual2.textContent = '≤';
        lessEqual2.classList.add(
            'neuroglancer-segment-query-result-numerical-plot-bound-constraint-symbol');
        container.appendChild(lessEqual2);
        container.appendChild(inputs[1]);
        container.appendChild(spacers[2]);
      } else {
        container.appendChild(inputs[0]);
        container.appendChild(inputs[1]);
      }
      return {container, spacers, inputs};
    };
    const boundElements = {
      range: makeBoundElements('range'),
      window: makeBoundElements('window'),
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

  private updateNumericalPropertySummary(
      propertyIndex: number, summary: NumericalPropertySummary,
      propertyHistogram: PropertyHistogram) {
    const prevWindowBounds = summary.bounds.window;
    const windowBounds = this.bounds.window.value[propertyIndex]!;
    const prevConstraintBounds = summary.bounds.range;
    const constraintBounds = this.bounds.range.value[propertyIndex]!;
    const {property} = summary;
    const queryResult = this.queryResult.value;
    const isIncluded = queryIncludesColumn(queryResult?.query, property.id);
    summary.columnCheckbox.checked = isIncluded;
    summary.columnCheckbox.title =
        isIncluded ? 'Remove column from result table' : 'Add column to result table';
    updateColumnSortIcon(queryResult, summary.sortIcon, property.id);
    // Check if we need to update the image.
    if (summary.propertyHistogram === propertyHistogram &&
        dataTypeIntervalEqual(property.dataType, prevWindowBounds, windowBounds) &&
        dataTypeIntervalEqual(property.dataType, prevConstraintBounds, constraintBounds)) {
      return;
    }
    const {histogram} = propertyHistogram;
    const svgNs = 'http://www.w3.org/2000/svg';
    const plotElement = document.createElementNS(svgNs, 'svg');
    plotElement.setAttribute('width', `1`);
    plotElement.setAttribute('height', `1`);
    plotElement.setAttribute('preserveAspectRatio', 'none');
    const rect = document.createElementNS(svgNs, 'rect');
    const constraintStartX = computeInvlerp(windowBounds, constraintBounds[0]);
    const constraintEndX = computeInvlerp(windowBounds, constraintBounds[1]);
    rect.setAttribute('x', `${constraintStartX}`);
    rect.setAttribute('y', '0');
    rect.setAttribute('width', `${constraintEndX - constraintStartX}`);
    rect.setAttribute('height', '1');
    rect.setAttribute('fill', '#4f4f4f');
    plotElement.appendChild(rect);
    const numBins = histogram.length;
    const makeCdfLine =
        (startBinIndex: number, endBinIndex: number, endBinIndexForTotal: number) => {
          const polyLine = document.createElementNS(svgNs, 'polyline');
          let points = '';
          let totalCount = 0;
          for (let i = startBinIndex; i < endBinIndexForTotal; ++i) {
            totalCount += histogram[i];
          }
          if (totalCount === 0) return undefined;
          const startBinX = computeInvlerp(windowBounds, propertyHistogram.window[0]);
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
          polyLine.setAttribute('fill', 'none');
          polyLine.setAttribute('stroke-width', '1px');
          polyLine.setAttribute('points', points);
          polyLine.setAttribute('vector-effect', 'non-scaling-stroke');
          return polyLine;
        };

    {
      const polyLine = makeCdfLine(0, numBins - 1, numBins);
      if (polyLine !== undefined) {
        polyLine.setAttribute('stroke', 'cyan');
        plotElement.appendChild(polyLine);
      }
    }

    if (!dataTypeIntervalEqual(property.dataType, property.bounds, constraintBounds)) {
      // Also plot CDF restricted to data that satisfies the constraint.
      const constraintStartBin = Math.floor(
          Math.max(0, Math.min(1, computeInvlerp(propertyHistogram.window, constraintBounds[0]))) *
          (numBins - 2));
      const constraintEndBin = Math.ceil(
          Math.max(0, Math.min(1, computeInvlerp(propertyHistogram.window, constraintBounds[1]))) *
          (numBins - 2));
      const polyLine = makeCdfLine(constraintStartBin, constraintEndBin, constraintEndBin);
      if (polyLine !== undefined) {
        polyLine.setAttribute('stroke', 'white');
        plotElement.appendChild(polyLine);
      }
    }

    // Embed the svg as an img rather than embedding it directly, in order to
    // allow it to be scaled using CSS.
    const xml = (new XMLSerializer).serializeToString(plotElement);
    summary.plotImg.src = `data:image/svg+xml;base64,${btoa(xml)}`;
    summary.propertyHistogram = propertyHistogram;
    for (let endpointIndex = 0; endpointIndex < 2; ++endpointIndex) {
      prevWindowBounds[endpointIndex] = windowBounds[endpointIndex];
      updateInputBoundValue(
          summary.boundElements.window.inputs[endpointIndex],
          windowBounds[endpointIndex] as number);
      prevConstraintBounds[endpointIndex] = constraintBounds[endpointIndex];
      updateInputBoundValue(
          summary.boundElements.range.inputs[endpointIndex],
          constraintBounds[endpointIndex] as number);
    }

    const spacers = summary.boundElements.range.spacers!;
    const clampedRange = getClampedInterval(windowBounds, constraintBounds);
    const effectiveFraction = getIntervalBoundsEffectiveFraction(property.dataType, windowBounds);
    const leftOffset = computeInvlerp(windowBounds, clampedRange[0]) * effectiveFraction;
    const rightOffset =
        computeInvlerp(windowBounds, clampedRange[1]) * effectiveFraction + (1 - effectiveFraction);
    spacers[0].style.width = `${leftOffset * 100}%`;
    spacers[2].style.width = `${(1 - rightOffset) * 100}%`;
  }
}

function renderTagSummary(
    queryResult: QueryResult, setQuery: (query: FilterQuery) => void): HTMLElement|undefined {
  const {tags} = queryResult;
  if (tags === undefined || tags.length === 0) return undefined;
  const filterQuery = queryResult.query as FilterQuery;
  const tagList = document.createElement('div');
  tagList.classList.add('neuroglancer-segment-query-result-tag-list');
  for (const {tag, count} of tags) {
    const tagElement = document.createElement('div');
    tagElement.classList.add('neuroglancer-segment-query-result-tag');
    const tagName = document.createElement('span');
    tagName.classList.add('neuroglancer-segment-query-result-tag-name');
    tagName.textContent = tag;
    tagList.appendChild(tagElement);
    const included = filterQuery.includeTags.includes(tag);
    const excluded = filterQuery.excludeTags.includes(tag);
    let toggleTooltip: string;
    if (included) {
      toggleTooltip = 'Remove tag from required set';
    } else if (excluded) {
      toggleTooltip = 'Remove tag from excluded set';
    } else {
      toggleTooltip = 'Add tag to required set';
    }
    tagName.addEventListener('click', () => {
      setQuery(changeTagConstraintInSegmentQuery(filterQuery, tag, true, !included && !excluded));
    });
    tagName.title = toggleTooltip;
    const inQuery = included || excluded;
    const addIncludeExcludeButton = (include: boolean) => {
      const includeExcludeCount = include ? count : queryResult.count - count;
      const includeElement = document.createElement('div');
      includeElement.classList.add(`neuroglancer-segment-query-result-tag-toggle`);
      includeElement.classList.add(
          `neuroglancer-segment-query-result-tag-${include ? 'include' : 'exclude'}`);
      tagElement.appendChild(includeElement);
      if (!inQuery && includeExcludeCount === 0) return;
      const selected = include ? included : excluded;
      includeElement.appendChild(
          new CheckboxIcon(
              {
                get value() {
                  return selected;
                },
                set value(value: boolean) {
                  setQuery(changeTagConstraintInSegmentQuery(filterQuery, tag, include, value));
                },
                changed: neverSignal,
              },
              {
                text: include ? '+' : '-',
                enableTitle: `Add tag to ${include ? 'required' : 'exclusion'} set`,
                disableTitle: `Remove tag from ${include ? 'required' : 'exclusion'} set`,
                backgroundScheme: 'dark',
              })
              .element);
    };
    addIncludeExcludeButton(true);
    addIncludeExcludeButton(false);
    tagElement.appendChild(tagName);
    const numElement = document.createElement('span');
    numElement.classList.add('neuroglancer-segment-query-result-tag-count');
    if (!inQuery) {
      numElement.textContent = count.toString();
    }
    tagElement.appendChild(numElement);
  }
  return tagList;
}

abstract class SegmentListGroupBase extends RefCounted {
  confirmationContainer = document.createElement('span');
  confirmationCheckbox = document.createElement('input');
  confirmationMessage = document.createElement('span');

  element = document.createElement('div');
  prevNumDisplayed = -1;

  selectionStatusContainer = document.createElement('span');
  starAllButton: HTMLElement;
  selectionStatusMessage = document.createElement('span');
  selectionCopyButton: HTMLElement;
  visibilityToggleAllButton = document.createElement('input');

  private currentConfirmCallback: WatchableValueInterface<(() => void)|undefined> = new WatchableValue(undefined);

  makeSegmentsVisible(visible: boolean) {
    const {visibleSegments, selectedSegments} = this.group;
    const segments = [...this.listSegments(true)];
    if (visible) {
      selectedSegments.set(segments, visible);
    }
    visibleSegments.set(segments, visible);
  }

  selectSegments(select: boolean, changeVisibility=false) {
    const {selectedSegments, visibleSegments} = this.group;
    const segments = [...this.listSegments(true)];
    if (select || !changeVisibility) {
      selectedSegments.set(segments, select);
    }
    if (changeVisibility) {
      visibleSegments.set(segments, select);
    }
  }

  copySegments(onlyVisible=false) {
    let ids = [...this.listSegments(true)]
    if (onlyVisible) {
      ids = ids.filter(segment => this.group.visibleSegments.has(segment));
    }
    ids.sort(Uint64.compare);
    setClipboard(ids.join(', '));
  }

  clearConfirm() {
    this.currentConfirmCallback.value = undefined;
  }

  confirm(message: string, callback: () => void) {
    this.confirmationMessage.textContent = message;
    this.currentConfirmCallback.value = callback;
  }

  constructor(
      protected listSource: SegmentListSource,
      protected group: SegmentationUserLayerGroupState) {
    super();
    const {visibilityToggleAllButton} = this;

    const {element, confirmationContainer, confirmationCheckbox, confirmationMessage, currentConfirmCallback} = this;
    element.style.display = 'contents';
    confirmationContainer.classList.add('neuroglancer-segment-list-status')
    confirmationCheckbox.type = 'checkbox';
    confirmationCheckbox.title = "Confirm"
    confirmationCheckbox.addEventListener('click', event => {
      event.preventDefault();
      const callbackValue = currentConfirmCallback.value;
      if (callbackValue) {
        this.clearConfirm();
        callbackValue();
      }
    });
    this.confirmationContainer.style.display = 'none';
    currentConfirmCallback.changed.add(() => {
      if (currentConfirmCallback.value) {
        this.confirmationContainer.style.display = '';
      } else {
        this.confirmationContainer.style.display = 'none';
      }
    });
    confirmationContainer.appendChild(confirmationCheckbox);
    confirmationContainer.appendChild(confirmationMessage);
    this.element.appendChild(confirmationContainer);
    this.starAllButton = makeStarButton({
      title: 'Toggle star status',
      onClick: () => {
        const unstar = this.starAllButton.classList.contains('unstar');
        this.selectSegments(!unstar, false);
      }
    });
    this.starAllButton.classList.add('neuroglancer-segment-list-status-star');
    this.selectionCopyButton = makeCopyButton({
      title: 'Copy visible segment IDs',
      onClick: () => {
        this.copySegments(true);
      },
    });
    visibilityToggleAllButton.type = 'checkbox';
    visibilityToggleAllButton.checked = true;
    visibilityToggleAllButton.title = 'Deselect all segment IDs';
    visibilityToggleAllButton.addEventListener('change', () => {
      this.clearConfirm();
      const adding = visibilityToggleAllButton.checked;
      const {visibleSegments} = group;
      if (adding) {
        const newSegments = [...this.listSegments(true)];
        const existingVisible = newSegments.filter(segment => visibleSegments.has(segment));
        const newVisibleCount = newSegments.length - existingVisible.length;
        if (newVisibleCount > selectSegmentConfirmationThreshold) {
          this.confirm(`Confirm: show ${newVisibleCount} segments?`, () => {
            this.makeSegmentsVisible(adding);
          });
          return;
        }
      }
      this.makeSegmentsVisible(adding);
    });
    const {selectionStatusContainer} = this;
    selectionStatusContainer.classList.add('neuroglancer-segment-list-status');
    selectionStatusContainer.appendChild(this.selectionCopyButton);
    selectionStatusContainer.appendChild(this.starAllButton);
    selectionStatusContainer.appendChild(this.visibilityToggleAllButton);
    selectionStatusContainer.appendChild(this.selectionStatusMessage);
    this.element.appendChild(selectionStatusContainer);
    this.registerDisposer(group.visibleSegments.changed.add(() => this.updateStatus()));
    this.registerDisposer(group.selectedSegments.changed.add(() => this.updateStatus()));
    this.registerDisposer(listSource.changed.add(() => this.updateStatus()));
  }

  listSegments(safe = false): IterableIterator<Uint64> {
    safe;
    return [].values();
  }

  updateStatus() {
    this.clearConfirm();
    const {listSource, group,
      starAllButton, selectionStatusMessage, selectionCopyButton, visibilityToggleAllButton} = this;
    const {visibleSegments, selectedSegments} = group;
    let queryVisibleCount = 0;
    let querySelectedCount = 0;
    const numMatches = listSource instanceof SegmentQueryListSource ? listSource.numMatches : 0;
    if (numMatches) {
      for (const id of this.listSegments()) {
        if (selectedSegments.has(id)) {
          querySelectedCount++;
        }
        if (visibleSegments.has(id)) {
          queryVisibleCount++;
        }
      }
    }
    const selectedCount = selectedSegments.size;
    const visibleCount = visibleSegments.size;
    const visibleDisplayedCount = numMatches ? queryVisibleCount : visibleCount;
    const visibleSelectedCount = numMatches ? querySelectedCount : selectedCount;
    const totalDisplayed = numMatches || selectedCount;
    starAllButton.classList.toggle('unstar', visibleSelectedCount > 0);
    selectionStatusMessage.textContent = `${visibleDisplayedCount}/${totalDisplayed} visible`;
    if (this.prevNumDisplayed !== totalDisplayed) {
      this.prevNumDisplayed = totalDisplayed;
      selectionCopyButton.style.visibility = totalDisplayed ? 'visible' : 'hidden';
      starAllButton.style.visibility = totalDisplayed ? 'visible' : 'hidden';
      visibilityToggleAllButton.style.visibility = totalDisplayed ? 'visible' : 'hidden';
    }
    visibilityToggleAllButton.checked = visibleDisplayedCount > 0;
  };
}

class SegmentListGroupSelected extends SegmentListGroupBase {
  copySelectedMessage = document.createElement('span');
  copySelectedButton: HTMLElement;

  constructor(
      protected listSource: SegmentListSource,
      protected group: SegmentationUserLayerGroupState) {
    super(listSource, group);
    this.copySelectedButton = makeCopyButton({
      title: 'Copy selected segment IDs',
      onClick: () => {
        this.copySegments(false);
      }
    });
    const matchStatusContainer = document.createElement('span');
    matchStatusContainer.classList.add('neuroglancer-segment-list-status')
    matchStatusContainer.appendChild(this.copySelectedButton);
    matchStatusContainer.appendChild(this.copySelectedMessage);
    this.element.prepend(matchStatusContainer);
  }

  listSegments(safe = false) {
    safe;
    return this.group.selectedSegments[Symbol.iterator](); // TODO, better way to call the iterator?
  }
  
  updateStatus() {
    super.updateStatus();
    const {selectedSegments} = this.group;
    this.copySelectedMessage.textContent = `Copy ${selectedSegments.size} selected segment IDs`
  }
}

class SegmentListGroupQuery extends SegmentListGroupBase {
  hasConfirmed = false;
  matchStatusContainer = document.createElement('span');
  matchStatusMessage = document.createElement('span');
  matchCopyButton: HTMLElement;

  updateQuery() {
    const {listSource, debouncedUpdateQueryModel} = this;
    debouncedUpdateQueryModel();
    debouncedUpdateQueryModel.flush();
    listSource.debouncedUpdate.flush();
  }

  listSegments(safe = false): IterableIterator<Uint64> {
    const {listSource, segmentPropertyMap} = this;
    this.updateQuery();
    const queryResult = listSource.queryResult.value;
    return forEachQueryResultSegmentIdGenerator(segmentPropertyMap, queryResult, safe);
  }

  constructor(
      list: VirtualList,
      protected listSource: SegmentQueryListSource,
      group: SegmentationUserLayerGroupState,
      private segmentPropertyMap: PreprocessedSegmentPropertyMap | undefined,
      segmentQuery: WatchableValueInterface<string>,
      queryElement: HTMLInputElement,
      private debouncedUpdateQueryModel: DebouncedFunc<() => void>) {
    super(listSource, group);
    const setQuery = (newQuery: ExplicitIdQuery|FilterQuery) => {
      queryElement.focus();
      queryElement.select();
      const value = unparseSegmentQuery(segmentPropertyMap, newQuery);
      document.execCommand('insertText', false, value);
      segmentQuery.value = value;
      queryElement.select();
    };
    const queryStatisticsContainer = document.createElement('div');
      queryStatisticsContainer.classList.add(
          'neuroglancer-segment-query-result-statistics');
    const queryStatisticsSeparator = document.createElement('div');
      queryStatisticsSeparator.classList.add(
          'neuroglancer-segment-query-result-statistics-separator');
    const queryErrors = document.createElement('ul');
      queryErrors.classList.add('neuroglancer-segment-query-errors');
    this.matchCopyButton = makeCopyButton({
      onClick: () => {
        this.copySegments(false);
      }
    });
    const {matchStatusContainer, matchCopyButton, matchStatusMessage} = this;
    matchStatusContainer.classList.add('neuroglancer-segment-list-status')
    matchStatusContainer.appendChild(matchCopyButton);
    matchStatusContainer.appendChild(matchStatusMessage);
    // push them in front of the base list elements
    this.element.prepend(queryErrors, queryStatisticsContainer, queryStatisticsSeparator, matchStatusContainer);
    this.registerEventListener(queryElement, 'input', () => {
      debouncedUpdateQueryModel();
      this.clearConfirm();
    });
    this.registerDisposer(registerActionListener(queryElement, 'cancel', () => {
      queryElement.focus();
      queryElement.select();
      document.execCommand('delete');
      queryElement.blur();
      queryElement.value = '';
      segmentQuery.value = '';
      this.hasConfirmed = false;
    }));
    this.registerDisposer(
      registerActionListener(queryElement, 'toggle-listed', this.toggleMatches));
    this.registerDisposer(registerActionListener(queryElement, 'hide-all', () => {
      for (const id of this.listSegments()) {
        group.visibleSegments.delete(id);
      }
    }));
    this.registerDisposer(
      registerActionListener(queryElement, 'hide-listed', () => {
        debouncedUpdateQueryModel();
        debouncedUpdateQueryModel.flush();
        listSource.debouncedUpdate.flush();
        const {visibleSegments} = group;
        if (segmentQuery.value === '') {
          visibleSegments.clear();
        } else {
          for (const id of this.listSegments()) {
            visibleSegments.delete(id);
          }
        }
      }));
    const numericalPropertySummaries =
                      this.registerDisposer(new NumericalPropertiesSummary(
                          segmentPropertyMap, listSource.queryResult, setQuery));
    {
      const {listElement} = numericalPropertySummaries;
      if (listElement !== undefined) {
        queryStatisticsContainer.appendChild(listElement);
      }
    }
    const updateQueryErrors = (queryResult: QueryResult|undefined) => {
      const errors = queryResult?.errors;
      removeChildren(queryErrors);
      if (errors === undefined) return;
      for (const error of errors) {
        const errorElement = document.createElement('li');
        errorElement.textContent = error.message;
        queryErrors.appendChild(errorElement);
      }
    };

    let tagSummary: HTMLElement|undefined = undefined;
    observeWatchable((queryResult: QueryResult|undefined) => {
      listSource.segmentWidgetFactory = new SegmentWidgetWithExtraColumnsFactory(
          listSource.segmentationDisplayState, listSource.parentElement,
          property => queryIncludesColumn(queryResult?.query, property.id));
      list.scrollToTop();
      removeChildren(list.header);
      if (segmentPropertyMap !== undefined) {
        const header = listSource.segmentWidgetFactory.getHeader();
        header.container.classList.add('neuroglancer-segment-list-header');
        for (const headerLabel of header.propertyLabels) {
          const {label, sortIcon, id} = headerLabel;
          label.addEventListener('click', () => {
            toggleSortOrder(listSource.queryResult.value, setQuery, id);
          });
          updateColumnSortIcon(queryResult, sortIcon, id);
        }
        list.header.appendChild(header.container);
      }
      updateQueryErrors(queryResult);
      queryStatisticsSeparator.style.display = 'none';
      tagSummary?.remove();
      if (queryResult === undefined) return;
      let {query} = queryResult;
      if (query.errors !== undefined || query.ids !== undefined) return;
      tagSummary = renderTagSummary(queryResult, setQuery);
      if (tagSummary !== undefined) {
        queryStatisticsContainer.appendChild(tagSummary);
      }
      if (numericalPropertySummaries.properties.length > 0 ||
          tagSummary !== undefined) {
        queryStatisticsSeparator.style.display = '';
      }
    }, listSource.queryResult);
  }

  updateStatus(): void {
    super.updateStatus();
    const {listSource, visibilityToggleAllButton, matchStatusMessage, matchCopyButton, matchStatusContainer, selectionStatusContainer} = this;
    matchStatusMessage.textContent = listSource.statusText.value;
    const {numMatches, selectedMatches} = listSource;
    matchCopyButton.style.visibility = numMatches ? 'visible' : 'hidden';
    matchCopyButton.title = `Copy ${numMatches} segment ID(s)`;
    if (selectedMatches === 0) {
      visibilityToggleAllButton.title = `Show ${numMatches} segment ID(s)`;
    } else if (selectedMatches === numMatches) {
      visibilityToggleAllButton.title = `Hide ${selectedMatches} segment ID(s)`;
    } else {
      visibilityToggleAllButton.title = `Hide ${selectedMatches} segment ID(s)`;
    }
    matchStatusContainer.style.display = numMatches ? '' : 'none';
    selectionStatusContainer.style.display = numMatches ? '' : 'none';
  }

  toggleMatches() {
    const {listSource} = this;
    this.updateQuery();
    const queryResult = listSource.queryResult.value;
    if (queryResult === undefined) return;
    const {selectedMatches} = listSource;
    const shouldSelect = (selectedMatches !== queryResult.count);
    if (shouldSelect &&
        queryResult.count - selectedMatches > selectSegmentConfirmationThreshold) {
      this.confirm(`Confirm: show ${queryResult.count - selectedMatches} segments?`, () => {
        this.selectSegments(shouldSelect, true);
      });
      return false;
    }
    this.selectSegments(shouldSelect, true);
    return true;
  };
}

export class SegmentDisplayTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-segment-display-tab');
    element.appendChild(
        this.registerDisposer(new DependentViewWidget(
                                  layer.displayState.segmentationGroupState.value.graph,
                                  (graph, parent, context) => {
                                    if (graph === undefined) return;
                                    if (graph.tabContents) return
                                    const toolbox = document.createElement('div');
                                    toolbox.className = 'neuroglancer-segmentation-toolbox';
                                    toolbox.appendChild(makeToolButton(context, layer.toolBinder, {
                                      toolJson: ANNOTATE_MERGE_SEGMENTS_TOOL_ID,
                                      label: 'Merge',
                                      title: 'Merge segments'
                                    }));
                                    toolbox.appendChild(makeToolButton(context, layer.toolBinder, {
                                      toolJson: ANNOTATE_SPLIT_SEGMENTS_TOOL_ID,
                                      label: 'Split',
                                      title: 'Split segments'
                                    }));
                                    parent.appendChild(toolbox);
                                  }))
            .element);


    const toolbox = document.createElement('div');
    toolbox.className ='neuroglancer-segmentation-toolbox';
    toolbox.appendChild(makeToolButton(this, layer.toolBinder, {
      toolJson: SELECT_SEGMENTS_TOOLS_ID,
      label: 'Select',
      title: 'Select/Deselect segments'
    }));
    element.appendChild(toolbox);

    const queryElement = document.createElement('input');
    queryElement.classList.add('neuroglancer-segment-list-query');
    queryElement.addEventListener('focus', () => {
      queryElement.select();
    });
    const keyboardHandler = this.registerDisposer(new KeyboardEventBinder(queryElement, keyMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    const {segmentQuery} = this.layer.displayState;
    const debouncedUpdateQueryModel = this.registerCancellable(debounce(() => {
      segmentQuery.value = queryElement.value;
    }, 200));
    queryElement.autocomplete = 'off';
    queryElement.title = keyMap.describe();
    queryElement.spellcheck = false;
    queryElement.placeholder = 'Enter ID, name prefix or /regexp';
    this.registerDisposer(observeWatchable(q => {
      queryElement.value = q;
    }, segmentQuery));
    this.registerDisposer(observeWatchable(t => {
      if (Date.now() - t < 100) {
        setTimeout(() => {
          queryElement.focus();
        }, 0);
        this.layer.segmentQueryFocusTime.value = Number.NEGATIVE_INFINITY;
      }
    }, this.layer.segmentQueryFocusTime));

    element.appendChild(queryElement);
    element.appendChild(
        this
            .registerDisposer(new DependentViewWidget(
                // segmentLabelMap is guaranteed to change if segmentationGroupState changes.
                layer.displayState.segmentPropertyMap,
                (segmentPropertyMap, parent, context) => {



                  const listSource = context.registerDisposer(new SegmentQueryListSource(
                      segmentQuery, segmentPropertyMap, layer.displayState, parent));
                  const selectedSegmentsListSource = context.registerDisposer(
                      new StarredSegmentsListSource(layer.displayState, parent));
                  const list = context.registerDisposer(
                      new VirtualList({source: listSource, horizontalScroll: true}));
                  const selectedSegmentsList = context.registerDisposer(
                      new VirtualList({source: selectedSegmentsListSource, horizontalScroll: true}));

                  const group = layer.displayState.segmentationGroupState.value;

                  const segList = context.registerDisposer(new SegmentListGroupQuery(list, listSource, group, segmentPropertyMap, segmentQuery, queryElement, debouncedUpdateQueryModel));
                  segList.updateStatus();
                  segList.element.appendChild(list.element);
                  parent.appendChild(segList.element);
                  const segList2 = context.registerDisposer(new SegmentListGroupSelected(selectedSegmentsListSource, group));
                  segList2.updateStatus();
                  segList2.element.appendChild(selectedSegmentsList.element);
                  parent.appendChild(segList2.element);
                  const updateListItems = context.registerCancellable(animationFrameDebounce(() => {
                    listSource.updateRenderedItems(list);
                    selectedSegmentsListSource.updateRenderedItems(selectedSegmentsList);
                  }));
                  const {displayState} = this.layer;
                  context.registerDisposer(
                      displayState.segmentSelectionState.changed.add(updateListItems));
                  context.registerDisposer(group.selectedSegments.changed.add(updateListItems));
                  context.registerDisposer(group.visibleSegments.changed.add(updateListItems));
                  context.registerDisposer(
                      displayState.segmentColorHash.changed.add(updateListItems));
                  context.registerDisposer(
                      displayState.segmentStatedColors.changed.add(updateListItems));
                  context.registerDisposer(
                      displayState.segmentDefaultColor.changed.add(updateListItems));
                  list.element.classList.add('neuroglancer-segment-list');
                  list.element.classList.add('neuroglancer-preview-list');
                  selectedSegmentsList.element.classList.add('neuroglancer-segment-list');

                  context.registerDisposer(layer.bindSegmentListWidth(list.element));
                  context.registerDisposer(layer.bindSegmentListWidth(selectedSegmentsList.element));
                  context.registerDisposer(
                      new MouseEventBinder(list.element, getDefaultSelectBindings()));
                  context.registerDisposer(
                      new MouseEventBinder(selectedSegmentsList.element, getDefaultSelectBindings()));

                  // list2 doesn't depend on queryResult, maybe move this into class
                  selectedSegmentsListSource.segmentWidgetFactory = new SegmentWidgetWithExtraColumnsFactory(
                    selectedSegmentsListSource.segmentationDisplayState, selectedSegmentsListSource.parentElement,
                    property => queryIncludesColumn(undefined, property.id));
                  selectedSegmentsList.scrollToTop();
                  removeChildren(selectedSegmentsList.header);
                }))
            .element);
  }
}
