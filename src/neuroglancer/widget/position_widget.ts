/**
 * @license
 * Copyright 2017-2019 Google Inc.
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

import './position_widget.css';

import {computeCombinedLowerUpperBound, CoordinateArray, CoordinateSpace, CoordinateSpaceCombiner, DimensionId, emptyInvalidCoordinateSpace, insertDimensionAt, makeCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {MouseSelectionState} from 'neuroglancer/layer';
import {Position} from 'neuroglancer/navigation_state';
import {StatusMessage} from 'neuroglancer/status';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {arraysEqual, binarySearch, filterArrayInplace} from 'neuroglancer/util/array';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent, updateChildren, updateInputFieldWidth} from 'neuroglancer/util/dom';
import {vec3} from 'neuroglancer/util/geom';
import {ActionEvent, KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {EventActionMap, MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {formatScaleWithUnit, parseScale} from 'neuroglancer/util/si_units';
import {makeCopyButton} from 'neuroglancer/widget/copy_button';

export const positionDragType = 'neuroglancer-position';

const inputEventMap = EventActionMap.fromObject({
  'arrowup': {action: 'adjust-up'},
  'arrowdown': {action: 'adjust-down'},
  'arrowleft': {action: 'maybe-tab-backward', preventDefault: false},
  'arrowright': {action: 'maybe-tab-forward', preventDefault: false},
  'tab': {action: 'tab-forward'},
  'shift+tab': {action: 'tab-backward'},
  'wheel': {action: 'adjust-via-wheel'},
  'backspace': {action: 'delete-backward', preventDefault: false},
  'enter': {action: 'commit'},
  'escape': {action: 'cancel'},
});

const widgetFieldGetters: ((widget: DimensionWidget) => HTMLInputElement)[] = [
  w => w.nameElement,
  w => w.coordinate,
  w => w.scaleElement,
];

// Returns the coordinate array for the specified dimension, if valid.
//
// If no coordinate array is specified, returns `undefined`.
//
// If a coordinate array is specified but there is a unit or scale specified, returns `null`.
//
// Otherwise, returns the coordinate array.
function getCoordinateArray(
    coordinateSpace: CoordinateSpace, dimensionIndex: number): CoordinateArray|undefined|null {
  const coordinateArray = coordinateSpace.coordinateArrays[dimensionIndex];
  if (coordinateArray === undefined) return coordinateArray;
  if (coordinateSpace.units[dimensionIndex] != '' || coordinateSpace.scales[dimensionIndex] !== 1) {
    return null;
  }
  return coordinateArray;
}

class DimensionWidget {
  container = document.createElement('div');
  nameContainer = document.createElement('span');
  nameElement = document.createElement('input');
  scaleContainer = document.createElement('span');
  scaleElement = document.createElement('input');
  coordinate = document.createElement('input');
  coordinateLabel = document.createElement('span')
  coordinateLabelWidth = 0;
  dropdownOwner: RefCounted|undefined = undefined;
  modified = false;
  draggingPosition = false;
  hasFocus = false;

  constructor(public coordinateSpace: CoordinateSpace, initialDimensionIndex: number) {
    const {
      container,
      scaleElement,
      scaleContainer,
      coordinate,
      nameElement,
      nameContainer,
      coordinateLabel
    } = this;
    container.title = '';
    container.classList.add('neuroglancer-position-dimension');
    container.draggable = true;
    container.tabIndex = -1;
    container.appendChild(nameContainer);
    container.appendChild(scaleElement);
    nameContainer.appendChild(nameElement);
    nameContainer.title = `Drag to reorder, double click to rename.  Names ending in ' or ^ indicate dimensions local to the layer; names ending in ^ indicate channel dimensions (image layers only).`;
    scaleContainer.appendChild(scaleElement);
    nameElement.classList.add('neuroglancer-position-dimension-name');
    nameElement.disabled = true;
    nameElement.spellcheck = false;
    nameElement.autocomplete = 'off';
    nameElement.required = true;
    nameElement.placeholder = ' ';
    scaleContainer.classList.add('neuroglancer-position-dimension-scale-container');
    scaleElement.classList.add('neuroglancer-position-dimension-scale');
    scaleElement.disabled = true;
    scaleElement.spellcheck = false;
    scaleElement.autocomplete = 'off';
    container.appendChild(scaleContainer);
    container.appendChild(coordinate);
    coordinate.type = 'text';
    coordinate.classList.add('neuroglancer-position-dimension-coordinate');
    coordinate.spellcheck = false;
    coordinate.autocomplete = 'off';
    coordinate.pattern = String.raw`(-?\d+(?:\.(?:\d+)?)?)`;
    const coordinateArray = getCoordinateArray(coordinateSpace, initialDimensionIndex);
    if (coordinateArray != null) {
      let maxLabelWidth = 0;
      for (const label of coordinateArray.labels) {
        maxLabelWidth = Math.max(maxLabelWidth, label.length);
      }
      this.coordinateLabelWidth = maxLabelWidth;
      coordinateLabel.style.width = `${maxLabelWidth + 2}ch`;
      container.appendChild(coordinateLabel);
    }
    coordinate.required = true;
    coordinate.placeholder = ' ';
    coordinateLabel.classList.add('neuroglancer-position-dimension-coordinate-label');
  }
}

interface NormalizedDimensionBounds {
  lowerBound: number;
  upperBound: number;
  normalizedBounds: readonly{lower: number, upper: number}[];
}


function getCanvasYFromCoordinate(
    coordinate: number, lowerBound: number, upperBound: number, canvasHeight: number) {
  return Math.floor((coordinate - lowerBound) * (canvasHeight - 1) / (upperBound - lowerBound));
}

function getNormalizedDimensionBounds(
    coordinateSpace: CoordinateSpace, dimensionIndex: number,
    height: number): NormalizedDimensionBounds|undefined {
  const {boundingBoxes, bounds} = coordinateSpace;
  const lowerBound = Math.floor(bounds.lowerBounds[dimensionIndex]);
  const upperBound = Math.ceil(bounds.upperBounds[dimensionIndex] - 1);
  if (!Number.isFinite(lowerBound) || !Number.isFinite(upperBound)) {
    return undefined;
  }
  const normalizedBounds: {lower: number, upper: number}[] = [];
  const normalize = (x: number) => {
    return getCanvasYFromCoordinate(x, lowerBound, upperBound, height);
  };
  const {rank} = coordinateSpace;
  for (const boundingBox of boundingBoxes) {
    const result = computeCombinedLowerUpperBound(boundingBox, dimensionIndex, rank);
    if (result === undefined) continue;
    result.lower = normalize(result.lower);
    result.upper = normalize(Math.ceil(result.upper - 1));
    normalizedBounds.push(result);
  }
  normalizedBounds.sort((a, b) => {
    const lowerDiff = a.lower - b.lower;
    if (lowerDiff !== 0) return lowerDiff;
    return b.upper - b.upper;
  });
  filterArrayInplace(normalizedBounds, (x, i) => {
    if (i === 0) return true;
    const prev = normalizedBounds[i - 1];
    return (prev.lower !== x.lower || prev.upper !== x.upper);
  });
  return {lowerBound, upperBound, normalizedBounds};
}

const tickWidth = 10;
const barWidth = 15;
const barRightMargin = 10;
const canvasWidth = tickWidth + barWidth + barRightMargin;

function drawDimensionBounds(
    canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, bounds: NormalizedDimensionBounds) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const {normalizedBounds} = bounds;
  function drawTick(x: number) {
    ctx.fillRect(0, x, tickWidth, 1);
  }
  ctx.fillStyle = '#fff';
  for (const {lower, upper} of normalizedBounds) {
    drawTick(lower);
    drawTick(upper);
  }
  const length = normalizedBounds.length;
  ctx.fillStyle = '#ccc';
  for (let i = 0; i < length; ++i) {
    const {lower, upper} = normalizedBounds[i];
    const startX = Math.floor(i * barWidth / length);
    const width = Math.max(1, barWidth / length);
    ctx.fillRect(startX + tickWidth, lower, width, upper + 1 - lower);
  }
}

function updateCoordinateFieldWidth(element: HTMLInputElement, value: string) {
  updateInputFieldWidth(element, value.length + 1);
}

function updateScaleElementStyle(scaleElement: HTMLInputElement) {
  const {value} = scaleElement;
  updateInputFieldWidth(scaleElement);
  scaleElement.parentElement!.dataset.isEmpty = value === '' ? 'true' : 'false';
}

export class PositionWidget extends RefCounted {
  element = document.createElement('div');
  private dimensionContainer = document.createElement('div');
  private coordinateSpace: CoordinateSpace|undefined = undefined;

  private dimensionWidgets = new Map<DimensionId, DimensionWidget>();
  private dimensionWidgetList: DimensionWidget[] = [];

  private openRegularDropdown(widget: DimensionWidget, dropdown: HTMLDivElement) {
    dropdown.classList.add('neuroglancer-position-dimension-dropdown');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    const lowerBoundElement = document.createElement('div');
    const lowerBoundContainer = document.createElement('div');
    lowerBoundContainer.appendChild(lowerBoundElement);
    const lowerBoundText = document.createTextNode('');
    lowerBoundElement.appendChild(lowerBoundText);
    const upperBoundElement = document.createElement('div');
    const hoverElement = document.createElement('div');
    lowerBoundContainer.classList.add('neuroglancer-position-dimension-dropdown-lowerbound');
    upperBoundElement.classList.add('neuroglancer-position-dimension-dropdown-upperbound');
    hoverElement.classList.add('neuroglancer-position-dimension-dropdown-hoverposition');
    dropdown.appendChild(lowerBoundContainer);
    dropdown.appendChild(upperBoundElement);
    dropdown.appendChild(hoverElement);
    dropdown.appendChild(canvas);

    const canvasHeight = 100;

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    upperBoundElement.style.marginTop = `${canvasHeight-1}px`;

    let prevLowerBound: number|undefined, prevUpperBound: number|undefined;

    let hoverPosition: number|undefined = undefined;
    const updateView = () => {
      const dimensionIndex = this.dimensionWidgetList.indexOf(widget);
      if (dimensionIndex === -1) return;
      const {coordinateSpace} = widget;
      const normalizedDimensionBounds =
          getNormalizedDimensionBounds(coordinateSpace, dimensionIndex, canvasHeight);
      if (normalizedDimensionBounds === undefined ||
          coordinateSpace.bounds.lowerBounds[dimensionIndex] + 1 ===
              coordinateSpace.bounds.upperBounds[dimensionIndex]) {
        dropdown.style.display = 'none';
        widget.container.dataset.dropdownVisible = undefined;
        return;
      }
      widget.container.dataset.dropdownVisible = 'true';
      dropdown.style.display = '';
      const {lowerBound, upperBound} = normalizedDimensionBounds;
      prevLowerBound = lowerBound;
      prevUpperBound = upperBound;
      lowerBoundText.textContent = lowerBound.toString();
      upperBoundElement.textContent = upperBound.toString();
      drawDimensionBounds(canvas, ctx, normalizedDimensionBounds);
      const curPosition = this.position.value[dimensionIndex];
      if (curPosition >= lowerBound && curPosition <= upperBound) {
        ctx.fillStyle = '#f66';
        ctx.fillRect(
            0, getCanvasYFromCoordinate(curPosition, lowerBound, upperBound, canvasHeight),
            canvasWidth, 1);
      }
      if (hoverPosition !== undefined && hoverPosition >= lowerBound &&
          hoverPosition <= upperBound) {
        ctx.fillStyle = '#66f';
        const hoverOffset =
            getCanvasYFromCoordinate(hoverPosition, lowerBound, upperBound, canvasHeight);
        ctx.fillRect(0, hoverOffset, canvasWidth, 1);
        hoverElement.textContent = hoverPosition.toString();
        const labelHeight = lowerBoundElement.clientHeight;
        lowerBoundElement.style.visibility = (hoverOffset > labelHeight) ? '' : 'hidden';
        upperBoundElement.style.visibility =
            (hoverOffset < canvasHeight - labelHeight) ? '' : 'hidden';
        hoverElement.style.display = '';
        hoverElement.style.visibility = 'visible';
        hoverElement.style.marginTop = `${hoverOffset}px`;
      } else {
        lowerBoundElement.style.visibility = '';
        hoverElement.style.display = 'none';
        upperBoundElement.style.visibility = '';
      }
    };
    const dropdownOwner = widget.dropdownOwner!;
    const scheduleUpdateView =
        dropdownOwner.registerCancellable(animationFrameDebounce(updateView));
    dropdownOwner.registerDisposer(this.position.changed.add(scheduleUpdateView));
    const getPositionFromMouseEvent = (event: MouseEvent): number|undefined => {
      if (prevLowerBound === undefined || prevUpperBound === undefined) return undefined;
      const canvasBounds = canvas.getBoundingClientRect();
      let relativeY = (event.clientY - canvasBounds.top) / canvasBounds.height;
      relativeY = Math.max(0, relativeY);
      relativeY = Math.min(1, relativeY);
      return Math.round(relativeY * (prevUpperBound - prevLowerBound)) + prevLowerBound;
    };
    const setPositionFromMouse = (event: MouseEvent) => {
      const dimensionIndex = this.dimensionWidgetList.indexOf(widget);
      if (dimensionIndex === -1) return;
      const x = getPositionFromMouseEvent(event);
      if (x === undefined) return;
      const {position} = this;
      const voxelCoordinates = position.value;
      voxelCoordinates[dimensionIndex] = x + 0.5;
      widget.modified = false;
      position.value = voxelCoordinates;
    };

    canvas.addEventListener('pointermove', (event: MouseEvent) => {
      const x = getPositionFromMouseEvent(event);
      hoverPosition = x;
      scheduleUpdateView();
    });
    canvas.addEventListener('pointerleave', () => {
      hoverPosition = undefined;
      scheduleUpdateView();
    });

    canvas.addEventListener('pointerdown', (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) {
        return;
      }
      startRelativeMouseDrag(
          event,
          (newEvent: MouseEvent) => {
            if (widget.dropdownOwner === undefined) return;
            hoverPosition = undefined;
            setPositionFromMouse(newEvent);
            scheduleUpdateView();
            widget.draggingPosition = true;
          },
          () => {
            widget.draggingPosition = false;
            this.updateDropdownVisibility(widget);
          });
      setPositionFromMouse(event);
    });
    updateView();
  }

  private openCoordinateArrayDropdown(widget: DimensionWidget, dropdown: HTMLDivElement, coordinateArray: CoordinateArray) {
    dropdown.classList.add('neuroglancer-position-dimension-coordinate-dropdown');
    const {coordinates, labels} = coordinateArray;
    const entries: {entryElement: HTMLDivElement, coordinateElement: HTMLDivElement, labelElement: HTMLDivElement}[] = [];
    const length = coordinates.length;
    dropdown.style.setProperty(
        '--neuroglancer-coordinate-label-width', `${widget.coordinateLabelWidth}ch`);
    for (let i = 0; i < length; ++i) {
      const entryElement = document.createElement('div');
      entryElement.classList.add('neuroglancer-dimension-dropdown-coordinate-entry');
      const coordinateElement = document.createElement('div');
      coordinateElement.classList.add('neuroglancer-dimension-dropdown-coordinate');
      const labelElement = document.createElement('div');
      labelElement.classList.add('neuroglancer-dimension-dropdown-coordinate-label');
      labelElement.textContent = labels[i];
      coordinateElement.textContent = coordinates[i].toString();
      entryElement.appendChild(coordinateElement);
      entryElement.appendChild(labelElement);
      entryElement.addEventListener('click', () => {
        const dimensionIndex = this.dimensionWidgetList.indexOf(widget);
        if (dimensionIndex === -1) return;
        const {position} = this;
        const voxelCoordinates = position.value;
        voxelCoordinates[dimensionIndex] = coordinates[i] + 0.5;
        widget.modified = false;
        position.value = voxelCoordinates;
      });
      dropdown.appendChild(entryElement);
      entries.push({entryElement, coordinateElement, labelElement});
    }
    //const dropdownOwner = widget.dropdownOwner!;
  }

  private openDropdown(widget: DimensionWidget) {
    if (widget.dropdownOwner !== undefined) return;
    const initialDimensionIndex = this.dimensionWidgetList.indexOf(widget);
    if (initialDimensionIndex === -1) return;
    this.closeDropdown();
    const dropdownOwner = widget.dropdownOwner = new RefCounted();
    const dropdown = document.createElement('div');
    dropdown.draggable = true;
    dropdown.addEventListener('dragstart', event => {
      event.stopPropagation();
      event.preventDefault();
    });
    dropdown.addEventListener('pointerenter', () => {
      widget.hasFocus = true;
    });
    dropdown.tabIndex = -1;
    widget.container.appendChild(dropdown);

    const coordinateArray = getCoordinateArray(widget.coordinateSpace, initialDimensionIndex);
    if (coordinateArray == null) {
      this.openRegularDropdown(widget, dropdown);
    } else {
      this.openCoordinateArrayDropdown(widget, dropdown, coordinateArray);
    }

    this.widgetWithOpenDropdown = widget;

    dropdownOwner.registerDisposer(() => {
      removeFromParent(dropdown);
      widget.dropdownOwner = undefined;
      delete widget.container.dataset.dropdownVisible;
      this.widgetWithOpenDropdown = undefined;
    });

    dropdownOwner.registerEventListener(document, 'pointerdown', (event: MouseEvent) => {
      const {target} = event;
      if (target instanceof Node && widget.container.contains(target)) {
        return;
      }
      this.closeDropdown(widget);
    }, {capture: true});
  }

  private widgetWithOpenDropdown: DimensionWidget|undefined;

  private closeDropdown(widget = this.widgetWithOpenDropdown) {
    if (widget === undefined) return;
    const {dropdownOwner} = widget;
    if (dropdownOwner === undefined) return;
    dropdownOwner.dispose();
  }

  private pasteString(widget: DimensionWidget, s: string) {
    while (true) {
      widget.coordinate.focus();
      const m = s.match(/^\s*(-?\d+(?:\.(?:\d+)?)?)((?:\s+(?![\s,]))|(?:\s*,\s*))?/);
      if (m === null) break;
      if (m[1] !== undefined) {
        document.execCommand('insertText', undefined, m[1]);
      }
      if (m[2] !== undefined) {
        const {dimensionWidgetList} = this;
        const dimensionIndex = dimensionWidgetList.indexOf(widget);
        if (dimensionIndex === -1 || dimensionIndex + 1 === dimensionWidgetList.length) {
          break;
        }
        const remaining = s.substring(m[0].length);
        const nextWidget = dimensionWidgetList[dimensionIndex + 1];
        widget = nextWidget;
        s = remaining;
        continue;
      }
      break;
    }
  }

  private dragSource: DimensionWidget|undefined = undefined;

  private reorderDimensionTo(targetIndex: number, sourceIndex: number) {
    if (targetIndex === sourceIndex) return;
    const {coordinateSpace} = this.position;
    coordinateSpace.value = insertDimensionAt(coordinateSpace.value, targetIndex, sourceIndex);
  }

  private updateDropdownVisibility(widget: DimensionWidget) {
    if (widget.hasFocus || widget.draggingPosition) {
      this.openDropdown(widget);
    } else {
      this.closeDropdown(widget);
    }
  }

  private newDimension(coordinateSpace: CoordinateSpace, initialDimensionIndex: number) {
    const widget = new DimensionWidget(coordinateSpace, initialDimensionIndex);
    widget.container.addEventListener('dragstart', (event: DragEvent) => {
      this.dragSource = widget;
      event.stopPropagation();
      event.dataTransfer!.setData('neuroglancer-dimension', '');
    });
    widget.container.addEventListener('dragenter', (event: DragEvent) => {
      const {dragSource} = this;
      if (dragSource === undefined || dragSource === widget) return;
      const {dimensionWidgetList} = this;
      const sourceIndex = dimensionWidgetList.indexOf(dragSource);
      const targetIndex = dimensionWidgetList.indexOf(widget);
      if (sourceIndex === -1 || targetIndex === -1) return;
      event.preventDefault();
      this.reorderDimensionTo(targetIndex, sourceIndex);
    });
    widget.container.addEventListener('dragend', (event: DragEvent) => {
      event;
      if (this.dragSource === widget) {
        this.dragSource = undefined;
      }
    });
    widget.nameContainer.addEventListener('dblclick', () => {
      widget.nameElement.disabled = false;
      widget.nameElement.focus();
      widget.nameElement.select();
    });
    widget.scaleContainer.addEventListener('dblclick', () => {
      widget.scaleElement.disabled = false;
      widget.scaleElement.focus();
      widget.scaleElement.select();
    });
    widget.coordinate.addEventListener('focus', () => {
      widget.coordinate.select();
    });
    widget.container.addEventListener('focusin', () => {
      widget.hasFocus = true;
      this.updateDropdownVisibility(widget);
    });
    widget.container.addEventListener('focusout', (event: FocusEvent) => {
      const {relatedTarget} = event;
      if (relatedTarget instanceof Node && widget.container.contains(relatedTarget)) {
        return;
      }
      widget.hasFocus = false;
      this.updateDropdownVisibility(widget);
    });
    widget.container.addEventListener('click', (event: PointerEvent) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.disabled) {
        widget.coordinate.focus();
      }
    });
    widget.coordinate.addEventListener('paste', (event: ClipboardEvent) => {
      const input = widget.coordinate;
      const value = input.value;
      const {clipboardData} = event;
      if (clipboardData === null) return;
      let text = clipboardData.getData('text');
      let {selectionEnd, selectionStart} = input;
      if (selectionStart !== 0 || selectionEnd !== value.length) {
        if (selectionStart == null) selectionStart = 0;
        if (selectionEnd == null) selectionEnd = 0;
        const invalidMatch = text.match(/[^\-0-9\.]/);
        if (invalidMatch !== null) {
          text = text.substring(0, invalidMatch.index);
        }
        if (text.length > 0) {
          document.execCommand('insertText', undefined, text);
        }
      } else {
        this.pasteString(widget, text);
      }
      event.preventDefault();
      event.stopPropagation();
    });
    widget.coordinate.addEventListener('input', () => {
      widget.modified = true;
      const input = widget.coordinate;
      const value = input.value;
      let {selectionDirection, selectionEnd, selectionStart} = input;
      if (selectionStart === null) selectionStart = 0;
      if (selectionEnd === null) selectionEnd = selectionStart;
      let newValue = '';
      const invalidPattern = /[^\-0-9\.]/g;
      newValue += value.substring(0, selectionStart).replace(invalidPattern, '');
      const newSelectionStart = newValue.length;
      newValue += value.substring(selectionStart, selectionEnd).replace(invalidPattern, '');
      const newSelectionEnd = newValue.length;
      newValue += value.substring(selectionEnd).replace(invalidPattern, '');
      input.value = newValue;
      input.selectionStart = newSelectionStart;
      input.selectionEnd = newSelectionEnd;
      input.selectionDirection = selectionDirection;
      updateCoordinateFieldWidth(input, newValue);
      if (selectionEnd === selectionStart && selectionEnd === value.length &&
          value.match(/^(-?\d+(?:\.(?:\d+)?)?)((?:\s+(?![\s,]))|(?:\s*,\s*))$/)) {
        this.selectAdjacentCoordinate(widget, 1);
      }
    });

    widget.nameElement.addEventListener('input', () => {
      const {nameElement} = widget;
      updateInputFieldWidth(nameElement);
      this.updateNameValidity();
    });

    widget.scaleElement.addEventListener('input', () => {
      const {scaleElement} = widget;
      updateScaleElementStyle(scaleElement);
      this.updateScaleValidity(widget);
    });

    widget.coordinate.addEventListener('blur', event => {
      const {relatedTarget} = event;
      if (this.dimensionWidgetList.some(widget => widget.coordinate === relatedTarget)) {
        return;
      }
      if (widget.modified) {
        this.updatePosition();
      }
    });

    widget.nameElement.addEventListener('blur', event => {
      widget.nameElement.disabled = true;
      const {relatedTarget} = event;
      if (this.dimensionWidgetList.some(widget => widget.nameElement === relatedTarget)) {
        return;
      }
      if (!this.updateNames()) {
        this.forceUpdateDimensions();
      }
    });

    widget.scaleElement.addEventListener('blur', event => {
      widget.scaleElement.disabled = true;
      const {relatedTarget} = event;
      if (this.dimensionWidgetList.some(widget => widget.scaleElement === relatedTarget)) {
        return;
      }
      if (!this.updateScales()) {
        this.forceUpdateDimensions();
      }
    });

    registerActionListener<WheelEvent>(widget.container, 'adjust-via-wheel', actionEvent => {
      const event = actionEvent.detail;
      const {deltaY} = event;
      if (deltaY === 0) {
        return;
      }
      this.adjustDimension(widget, Math.sign(deltaY));
    });

    registerActionListener(widget.container, 'adjust-up', () => {
      this.adjustDimension(widget, -1);
    });
    registerActionListener(widget.container, 'adjust-down', () => {
      this.adjustDimension(widget, 1);
    });

    for (const getter of widgetFieldGetters) {
      const e = getter(widget);
      registerActionListener<Event>(e, 'maybe-tab-forward', event => {
        this.handleLeftRightMovement(event, widget, 1, getter);
      });
      registerActionListener<Event>(e, 'maybe-tab-backward', event => {
        this.handleLeftRightMovement(event, widget, -1, getter);
      });
      registerActionListener<Event>(e, 'tab-forward', () => {
        this.selectAdjacentField(widget, 1, getter);
      });
      registerActionListener<Event>(e, 'tab-backward', () => {
        this.selectAdjacentField(widget, -1, getter);
      });
    }

    registerActionListener(widget.coordinate, 'commit', () => {
      this.updatePosition();
    });

    registerActionListener(widget.nameElement, 'commit', () => {
      this.updateNames();
    });

    registerActionListener(widget.scaleElement, 'commit', () => {
      this.updateScales();
    });

    registerActionListener(widget.coordinate, 'delete-backward', event => {
      event.stopPropagation();
      const {coordinate} = widget;
      if (coordinate.selectionStart === coordinate.selectionEnd &&
          coordinate.selectionStart === 0) {
        event.preventDefault();
        this.selectAdjacentCoordinate(widget, -1);
      }
    });


    return widget;
  }

  private forceUpdateDimensions() {
    let {position: {coordinateSpace: {value: coordinateSpace}}} = this;
    if (!coordinateSpace.valid) {
      coordinateSpace = emptyInvalidCoordinateSpace;
    }
    this.coordinateSpace = coordinateSpace;
    const {dimensionWidgets, dimensionWidgetList} = this;
    dimensionWidgetList.length = 0;
    const {
      names,
      ids,
      scales,
      units,
    } = coordinateSpace;
    updateChildren(this.dimensionContainer, ids.map((id, i) => {
      let widget = dimensionWidgets.get(id);
      if (widget === undefined) {
        widget = this.newDimension(coordinateSpace, i);
        dimensionWidgets.set(id, widget);
      } else {
        widget.coordinateSpace = coordinateSpace;
      }
      const name = names[i]
      widget.nameElement.value = name;
      delete widget.nameElement.dataset.isValid;
      updateInputFieldWidth(widget.nameElement);
      const coordinateArray = getCoordinateArray(coordinateSpace, i);
      if (coordinateArray === undefined) {
        widget.container.dataset.coordinateArray = 'none';
      } else if (coordinateArray === null) {
        widget.container.dataset.coordinateArray = 'invalid';
      } else {
        widget.container.dataset.coordinateArray = 'valid';
      }
      widget.scaleContainer.title = 'Drag to reorder, double click to change scale';
      if (coordinateArray === null) {
        widget.scaleContainer.title +=
            '.  Coordinate array disabled.  To use the coordinate array, remove the unit/scale.'
      }
      const {scale, prefix, unit} = formatScaleWithUnit(scales[i], units[i]);
      const scaleString = `${scale}${prefix}${unit}`;
      widget.scaleElement.value = scaleString;
      delete widget.scaleElement.dataset.isValid;
      updateScaleElementStyle(widget.scaleElement);
      dimensionWidgetList.push(widget);
      return widget.container;
    }));
    for (const [id, widget] of dimensionWidgets) {
      if (widget.coordinateSpace !== coordinateSpace) {
        this.closeDropdown(widget);
        dimensionWidgets.delete(id);
      }
    }
  }

  private updateDimensions() {
    const {position: {coordinateSpace: {value: coordinateSpace}}} = this;
    if (coordinateSpace === this.coordinateSpace) return;
    this.forceUpdateDimensions();
  }

  private selectAdjacentField(
      widget: DimensionWidget, dir: number,
      fieldGetter: (widget: DimensionWidget) => HTMLInputElement) {
    const {dimensionWidgetList} = this;
    let axisIndex = dimensionWidgetList.indexOf(widget);
    if (axisIndex === -1) return;
    while (true) {
      axisIndex += dir;
      if (axisIndex < 0 || axisIndex >= dimensionWidgetList.length) {
        return false;
      }
      const newWidget = dimensionWidgetList[axisIndex];
      const field = fieldGetter(newWidget);
      if (field.style.display === 'none') continue;
      field.disabled = false;
      field.focus();
      field.selectionStart = 0;
      field.selectionEnd = field.value.length;
      field.selectionDirection = dir === 1 ? 'forward' : 'backward';
      return true;
    }
  }

  private selectAdjacentCoordinate(widget: DimensionWidget, dir: number) {
    return this.selectAdjacentField(widget, dir, w => w.coordinate);
  }

  private handleLeftRightMovement(
      event: ActionEvent<Event>, widget: DimensionWidget, dir: number,
      getter: (widget: DimensionWidget) => HTMLInputElement) {
    event.stopPropagation();
    const element = getter(widget);
    if (element.selectionStart !== element.selectionEnd ||
        element.selectionStart !== (dir === 1 ? element.value.length : 0)) {
      return;
    }
    if (this.selectAdjacentField(widget, dir, getter)) {
      event.preventDefault();
    }
  }

  private updateNameValidity() {
    const {dimensionWidgetList} = this;
    const names = dimensionWidgetList.map(w => w.nameElement.value);
    const rank = names.length;
    const isValid = this.combiner.getRenameValidity(names);
    for (let i = 0; i < rank; ++i) {
      dimensionWidgetList[i].nameElement.dataset.isValid =
          (isValid[i] === false) ? 'false' : 'true';
    }
  }

  private updateScaleValidity(widget: DimensionWidget) {
    const isValid = parseScale(widget.scaleElement.value) !== undefined;
    widget.scaleElement.dataset.isValid = isValid.toString();
  }

  constructor(
      public position: Borrowed<Position>, public combiner: CoordinateSpaceCombiner,
      {copyButton = true} = {}) {
    super();
    const {element, dimensionContainer} = this;
    this.registerDisposer(position.coordinateSpace.changed.add(
        this.registerCancellable(animationFrameDebounce(() => this.updateDimensions()))));
    element.className = 'neuroglancer-position-widget';
    dimensionContainer.style.display = 'contents';
    element.appendChild(dimensionContainer);
    if (copyButton) {
      const copyButton = makeCopyButton({
        title: 'Copy position to clipboard',
        onClick: () => {
          const result = setClipboard(this.getPositionText());
          StatusMessage.showTemporaryMessage(
              result ? 'Position copied to clipboard' : 'Failed to copy position to clipboard');
        }
      });
      copyButton.addEventListener('dragstart', event => {
        event.dataTransfer!.setData(
            positionDragType,
            JSON.stringify(
                {position: position.toJSON(), dimensions: position.coordinateSpace.value.names}));
        event.dataTransfer!.setData('text', this.getPositionText());
        event.stopPropagation();
      });
      copyButton.draggable = true;
      element.appendChild(copyButton);
    }
    this.registerDisposer(position.changed.add(
        this.registerCancellable(animationFrameDebounce(() => this.updateView()))));

    const keyboardHandler = this.registerDisposer(new KeyboardEventBinder(element, inputEventMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    this.registerDisposer(registerActionListener(element, 'cancel', event => {
      this.coordinateSpace = undefined;
      this.updateView();
      this.closeDropdown();
      const {target} = event;
      if (target instanceof HTMLElement) {
        target.blur();
      }
    }));
    this.updateView();
  }


  private adjustDimension(widget: DimensionWidget, adjustment: number) {
    const axisIndex = this.dimensionWidgetList.indexOf(widget);
    if (axisIndex === -1) return;
    this.updatePosition();
    const {position} = this;
    if (!position.valid) {
      return;
    }
    const coordinateSpace = position.coordinateSpace.value;
    const {bounds} = coordinateSpace;
    const voxelCoordinates = Float32Array.from(position.value);
    let newValue = Math.floor(voxelCoordinates[axisIndex] + adjustment);
    if (adjustment > 0) {
      const bound = bounds.upperBounds[axisIndex];
      if (Number.isFinite(bound)) {
        newValue = Math.min(newValue, Math.ceil(bound - 1));
      }
    } else {
      const bound = bounds.lowerBounds[axisIndex];
      if (Number.isFinite(bound)) {
        newValue = Math.max(newValue, Math.floor(bound));
      }
    }
    voxelCoordinates[axisIndex] = newValue + 0.5;
    this.position.value = voxelCoordinates;
    this.updateView();
  }

  private updatePosition() {
    const {dimensionWidgetList} = this;
    const {position} = this;
    const {value: voxelCoordinates} = position;
    if (voxelCoordinates === undefined) return;
    const rank = dimensionWidgetList.length;
    for (let i = 0; i < rank; ++i) {
      const widget = dimensionWidgetList[i];
      widget.modified = false;
      const value = Number(widget.coordinate.value);
      if (Number.isFinite(value)) {
        voxelCoordinates[i] = value + (Number.isInteger(value) ? 0.5 : 0);
      }
    }
    position.value = voxelCoordinates;
  }

  private updateNames() {
    const {dimensionWidgetList} = this;
    const {position: {coordinateSpace}} = this;
    const existing = coordinateSpace.value;
    const names = dimensionWidgetList.map(x => x.nameElement.value);
    if (this.combiner.getRenameValidity(names).includes(false)) return false;
    const existingNames = existing.names;
    if (arraysEqual(existingNames, names)) return false;
    const timestamps = existing.timestamps.map(
        (t, i) => (existingNames[i] === names[i]) ? t : Date.now());
    const newSpace = {...existing, names, timestamps};
    coordinateSpace.value = newSpace;
    return true;
  }

  private updateScales() {
    const {dimensionWidgetList} = this;
    const {position: {coordinateSpace}} = this;
    const existing = coordinateSpace.value;
    const scalesAndUnits = dimensionWidgetList.map(x => parseScale(x.scaleElement.value));
    if (scalesAndUnits.includes(undefined)) {
      return false;
    }
    const newScales = Float64Array.from(scalesAndUnits, x => x!.scale);
    const newUnits = Array.from(scalesAndUnits, x => x!.unit);
    const {scales, units} = existing;
    if (arraysEqual(scales, newScales) && arraysEqual(units, newUnits)) return false;
    const timestamps = existing.timestamps.map(
        (t, i) => (newScales[i] === scales[i] && newUnits[i] === units[i]) ? t : Date.now());
    const newSpace = makeCoordinateSpace({
      valid: existing.valid,
      rank: existing.rank,
      scales: newScales,
      units: newUnits,
      timestamps,
      ids: existing.ids,
      names: existing.names,
      boundingBoxes: existing.boundingBoxes,
      coordinateArrays: existing.coordinateArrays,
    });
    coordinateSpace.value = newSpace;
    return true;
  }

  private getPositionText() {
    const {position} = this;
    if (position.valid) {
      return position.value.map(x => Math.floor(x)).join(', ');
    } else {
      return '';
    }
  }

  private updateView() {
    this.updateDimensions();
    const {position: {value: voxelCoordinates}, dimensionWidgetList} = this;
    const rank = dimensionWidgetList.length;
    if (voxelCoordinates === undefined) {
      return;
    }
    const coordinateSpace = this.coordinateSpace!;
    for (let i = 0; i < rank; ++i) {
      const widget = dimensionWidgetList[i];
      const inputElement = widget.coordinate;
      const newCoord = Math.floor(voxelCoordinates[i]);
      const newValue = newCoord.toString();
      updateCoordinateFieldWidth(inputElement, newValue);
      inputElement.value = newValue;
      const coordinateArray = getCoordinateArray(coordinateSpace, i);
      let label = '';
      if (coordinateArray != null) {
        const {coordinates} = coordinateArray;
        const index = binarySearch(coordinates, newCoord, (a, b) => a - b);
        if (index !== coordinates.length) {
          label = coordinateArray.labels[index];
        }
      }
      const labelElement = widget.coordinateLabel;
      labelElement.textContent = label;
    }
  }

  disposed() {
    this.closeDropdown();
    removeFromParent(this.element);
    super.disposed();
  }
}

export class MousePositionWidget extends RefCounted {
  tempPosition = vec3.create();
  constructor(
      public element: HTMLElement, public mouseState: MouseSelectionState,
      public coordinateSpace: WatchableValueInterface<CoordinateSpace|undefined>) {
    super();
    element.className = 'neuroglancer-mouse-position-widget';
    const updateViewFunction =
        this.registerCancellable(animationFrameDebounce(() => this.updateView()));
    this.registerDisposer(mouseState.changed.add(updateViewFunction));
    this.registerDisposer(coordinateSpace.changed.add(updateViewFunction));
  }
  updateView() {
    let text = '';
    const {mouseState, coordinateSpace: {value: coordinateSpace}} = this;
    if (mouseState.active && coordinateSpace !== undefined) {
      const p = mouseState.position;
      const {rank, names} = coordinateSpace;
      for (let i = 0; i < rank; ++i) {
        if (i !== 0) text += '  ';
        text += `${names[i]} ${Math.floor(p[i])}`;
      }
    }
    this.element.textContent = text;
  }
  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
