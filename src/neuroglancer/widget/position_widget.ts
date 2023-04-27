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

import svg_pause from 'ikonate/icons/pause.svg';
import svg_play from 'ikonate/icons/play.svg';
import svg_video from 'ikonate/icons/video.svg';
import {clampAndRoundCoordinateToVoxelCenter, CoordinateArray, CoordinateSpace, CoordinateSpaceCombiner, DimensionId, emptyInvalidCoordinateSpace, insertDimensionAt, makeCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
import {LayerGroupViewer} from 'neuroglancer/layer_group_viewer';
import {CoordinateSpacePlaybackVelocity, Position, VelocityBoundaryBehavior} from 'neuroglancer/navigation_state';
import {StatusMessage} from 'neuroglancer/status';
import {makeCachedDerivedWatchableValue, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {LocalToolBinder, makeToolActivationStatusMessage, makeToolButton, registerTool, Tool, ToolActivation} from 'neuroglancer/ui/tool';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {arraysEqual, binarySearch} from 'neuroglancer/util/array';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent, updateChildren, updateInputFieldWidth} from 'neuroglancer/util/dom';
import {vec3} from 'neuroglancer/util/geom';
import {verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import {ActionEvent, KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {EventActionMap, MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {formatScaleWithUnit, parseScale} from 'neuroglancer/util/si_units';
import {TrackableEnum} from 'neuroglancer/util/trackable_enum';
import {getWheelZoomAmount} from 'neuroglancer/util/wheel_zoom';
import {Viewer} from 'neuroglancer/viewer';
import {CheckboxIcon} from 'neuroglancer/widget/checkbox_icon';
import {makeCopyButton} from 'neuroglancer/widget/copy_button';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {makeIcon} from 'neuroglancer/widget/icon';
import {NumberInputWidget} from 'neuroglancer/widget/number_input_widget';
import {PositionPlot} from 'neuroglancer/widget/position_plot';

export const positionDragType = 'neuroglancer-position';

const inputEventMap = EventActionMap.fromObject({
  'arrowup': {action: 'adjust-up'},
  'arrowdown': {action: 'adjust-down'},
  'arrowleft': {action: 'maybe-tab-backward', preventDefault: false},
  'arrowright': {action: 'maybe-tab-forward', preventDefault: false},
  'tab': {action: 'tab-forward'},
  'shift+tab': {action: 'tab-backward'},
  'wheel': {action: 'adjust-via-wheel'},
  'alt+wheel': {action: 'adjust-velocity-via-wheel'},
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
  playButton = document.createElement('div');
  pauseButton = document.createElement('div');
  coordinateLabelWidth = 0;

  // Maximum possible position width given the current coordinate space.
  maxPositionWidth: number = 0;

  // Maximum position width seen so far.
  //
  // If the bounds are known when this DimensionWidget is first created, this is initialized to
  // `maxPositionWidth`.  Otherwise it is initialized to `0`.
  maxPositionWidthSeen: number = 0;

  dropdownOwner: RefCounted|undefined = undefined;
  modified = false;
  draggingPosition = false;
  hasFocus = false;

  constructor(
      public coordinateSpace: CoordinateSpace, public id: DimensionId,
      initialDimensionIndex: number, options: {allowFocus: boolean, showPlayback: boolean}) {
    const {
      container,
      scaleElement,
      scaleContainer,
      coordinate,
      nameElement,
      nameContainer,
      coordinateLabel,
      playButton,
      pauseButton,
    } = this;
    container.title = '';
    container.classList.add('neuroglancer-position-dimension');
    const {allowFocus, showPlayback} = options;
    if (allowFocus) {
      container.draggable = true;
      container.tabIndex = -1;
    }
    container.appendChild(nameContainer);
    container.appendChild(scaleElement);
    nameContainer.appendChild(nameElement);
    nameContainer.title =
        `Drag to reorder, double click to rename.  Names ending in ' or ^ indicate dimensions local to the layer; names ending in ^ indicate channel dimensions (image layers only).`;
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

    if (showPlayback) {
      playButton.classList.add('neuroglancer-icon');
      pauseButton.classList.add('neuroglancer-icon');
      playButton.innerHTML = svg_play;
      pauseButton.innerHTML = svg_pause;
      container.appendChild(playButton);
      container.appendChild(pauseButton);
    }

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

    if (allowFocus) {
      nameContainer.addEventListener('dblclick', () => {
        nameElement.disabled = false;
        nameElement.focus();
        nameElement.select();
      });
      scaleContainer.addEventListener('dblclick', () => {
        scaleElement.disabled = false;
        scaleElement.focus();
        scaleElement.select();
      });
      coordinate.addEventListener('focus', () => {
        coordinate.select();
      });
      container.addEventListener('click', (event: PointerEvent) => {
        if (!(event.target instanceof HTMLInputElement) || event.target.disabled) {
          coordinate.focus();
        }
      });
    }
  }
}

// Updates the width of the coordinate field to the max of:
//
// - The current size.
//
// - Maximum size seen so far, bounded by maximum width for the current lower/upper
//   bounds.
//
// The purpose of this is to avoid repeatedly changing the layout when using velocity, and also
// changing the layout as Neuroglancer first loads and the bounds are not yet known.
function updateCoordinateFieldWidth(widget: DimensionWidget, value: string) {
  const curLength = value.length;
  if (curLength > widget.maxPositionWidthSeen) {
    widget.maxPositionWidthSeen = curLength;
  }
  updateInputFieldWidth(
      widget.coordinate,
      Math.max(Math.min(widget.maxPositionWidth, widget.maxPositionWidthSeen), curLength));
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
  private velocity: CoordinateSpacePlaybackVelocity|undefined;
  private singleDimensionId: DimensionId|undefined;
  private getToolBinder: (() => (LocalToolBinder | undefined))|undefined;
  private allowFocus: boolean;
  private showPlayback: boolean;

  private dimensionWidgets = new Map<DimensionId, DimensionWidget>();
  private dimensionWidgetList: DimensionWidget[] = [];

  getDimensionIndex(id: DimensionId): number {
    const coordinateSpace = this.position.coordinateSpace.value;
    return coordinateSpace.ids.indexOf(id);
  }

  private openRegularDropdown(widget: DimensionWidget, dropdown: HTMLDivElement) {
    dropdown.classList.add('neuroglancer-position-dimension-dropdown');

    const dropdownOwner = widget.dropdownOwner!;
    const toolBinder = this.getToolBinder?.();
    if (toolBinder !== undefined) {
      const dimensionIndex = this.getDimensionIndex(widget.id);
      const toolButton = makeToolButton(dropdownOwner, toolBinder, {
        toolJson:
            {type: DIMENSION_TOOL_ID, dimension: widget.coordinateSpace.names[dimensionIndex]},
      });
      dropdown.appendChild(toolButton);
    }

    const plot = dropdownOwner.registerDisposer(new PositionPlot(this.position, widget.id));
    dropdown.appendChild(plot.element);

    const watchableVelocity = this.velocity?.dimensionVelocity(dropdownOwner, widget.id);
    if (watchableVelocity !== undefined) {
      const playbackElement = document.createElement('div');
      playbackElement.classList.add('neuroglancer-position-dimension-playback');
      const header = document.createElement('div');
      header.classList.add('neuroglancer-position-dimension-playback-header');
      playbackElement.appendChild(header);
      header.appendChild(
          dropdownOwner
              .registerDisposer(new CheckboxIcon(this.velocity!.playbackEnabled(widget.id), {
                svg: svg_video,
                enableTitle: 'Enable playback/velocity',
                disableTitle: 'Disable playback/velocity',
                backgroundScheme: 'dark',
              }))
              .element);
      header.appendChild(document.createTextNode('Playback'));
      dropdown.appendChild(playbackElement);
      const enabled = dropdownOwner.registerDisposer(
          makeCachedDerivedWatchableValue(value => value !== undefined, [watchableVelocity]));
      playbackElement.appendChild(
          dropdownOwner
              .registerDisposer(new DependentViewWidget(
                  enabled,
                  (enabledValue, parent, context) => {
                    if (!enabledValue) return;
                    const velocityModel = new WatchableValue<number>(0);
                    velocityModel.changed.add(() => {
                      const newValue = velocityModel.value;
                      const velocity = watchableVelocity.value;
                      if (velocity === undefined) return;
                      if (velocity.velocity === newValue) return;
                      watchableVelocity.value = {...velocity, velocity: newValue};
                    });
                    const negateButton = makeIcon({
                      text: '±',
                      title: 'Negate velocity',
                      onClick: () => {
                        velocityModel.value = -velocityModel.value;
                      },
                    });
                    const velocityInputWidget =
                        context.registerDisposer(new NumberInputWidget(velocityModel));
                    velocityInputWidget.element.insertBefore(
                        negateButton, velocityInputWidget.element.firstChild);
                    velocityInputWidget.element.title = 'Velocity in coordinates per second';
                    const rateSpan = document.createElement('span');
                    rateSpan.textContent = '/s';
                    velocityInputWidget.element.appendChild(rateSpan);
                    parent.appendChild(velocityInputWidget.element);
                    const trackableEnum = new TrackableEnum<VelocityBoundaryBehavior>(
                        VelocityBoundaryBehavior, VelocityBoundaryBehavior.STOP);
                    const watchableVelocityChanged = () => {
                      trackableEnum.value =
                          watchableVelocity.value?.atBoundary ?? VelocityBoundaryBehavior.STOP;
                      velocityModel.value = watchableVelocity.value?.velocity ?? 0;
                    };
                    watchableVelocityChanged();
                    context.registerDisposer(
                        watchableVelocity.changed.add(watchableVelocityChanged));
                    trackableEnum.changed.add(() => {
                      const atBoundary = trackableEnum.value;
                      const velocity = watchableVelocity.value;
                      if (velocity === undefined) return;
                      if (velocity.atBoundary === atBoundary) return;
                      watchableVelocity.value = {...velocity, atBoundary};
                    });
                    const selectWidget = new EnumSelectWidget(trackableEnum).element;
                    parent.appendChild(selectWidget);
                    selectWidget.title = 'Behavior when lower/upper bound is reached';
                  }))
              .element);
    }
    plot.dragging.changed.add(() => {
      const newValue = widget.draggingPosition = plot.dragging.value;
      if (newValue === false) {
        this.updateDropdownVisibility(widget);
      }
    });
  }

  private openCoordinateArrayDropdown(
      widget: DimensionWidget, dropdown: HTMLDivElement, coordinateArray: CoordinateArray) {
    dropdown.classList.add('neuroglancer-position-dimension-coordinate-dropdown');
    const {coordinates, labels} = coordinateArray;
    const entries: {
      entryElement: HTMLDivElement,
      coordinateElement: HTMLDivElement,
      labelElement: HTMLDivElement
    }[] = [];
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
        const dimensionIndex = this.getDimensionIndex(widget.id);
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
    // const dropdownOwner = widget.dropdownOwner!;
  }

  private openDropdown(widget: DimensionWidget) {
    if (widget.dropdownOwner !== undefined) return;
    const dimensionIndex = this.getDimensionIndex(widget.id);
    if (dimensionIndex === -1) return;
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

    const coordinateArray = getCoordinateArray(widget.coordinateSpace, dimensionIndex);
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

  private newDimension(
      coordinateSpace: CoordinateSpace, id: DimensionId, initialDimensionIndex: number) {
    const widget = new DimensionWidget(
        coordinateSpace, id, initialDimensionIndex,
        {allowFocus: this.allowFocus, showPlayback: this.showPlayback});
    if (this.singleDimensionId === undefined) {
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
    }
    if (this.allowFocus) {
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
        updateCoordinateFieldWidth(widget, newValue);
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
    } else {
      widget.coordinate.disabled = true;
    }

    registerActionListener<WheelEvent>(widget.container, 'adjust-via-wheel', actionEvent => {
      const event = actionEvent.detail;
      const {deltaY} = event;
      if (deltaY === 0) {
        return;
      }
      this.adjustDimensionPosition(widget.id, Math.sign(deltaY));
    });

    registerActionListener<WheelEvent>(
        widget.container, 'adjust-velocity-via-wheel', actionEvent => {
          const event = actionEvent.detail;
          this.adjustDimensionVelocity(widget, getWheelZoomAmount(event));
        });

    registerActionListener(widget.container, 'adjust-up', () => {
      this.adjustDimensionPosition(widget.id, -1);
    });
    registerActionListener(widget.container, 'adjust-down', () => {
      this.adjustDimensionPosition(widget.id, 1);
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

    if (this.showPlayback) {
      const setPaused = (paused: boolean) => {
        this.velocity?.togglePlayback(widget.id, paused);
      };
      widget.playButton.addEventListener('click', () => setPaused(false));
      widget.pauseButton.addEventListener('click', () => setPaused(true));
    }

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
      bounds: {lowerBounds, upperBounds},
    } = coordinateSpace;
    const getDimensionWidget = (id: DimensionId, i: number) => {
      // Calculate max position width.
      const lower = lowerBounds[i];
      const upper = upperBounds[i];
      const maxPositionWidth = Math.max(
          Number.isFinite(lower) ? Math.floor(lower).toString().length : 0,
          Number.isFinite(upper) ? Math.ceil(upper).toString().length : 0);
      let widget = dimensionWidgets.get(id);
      if (widget === undefined) {
        widget = this.newDimension(coordinateSpace, id, i);
        dimensionWidgets.set(id, widget);
        widget.maxPositionWidthSeen = maxPositionWidth;
      } else {
        widget.coordinateSpace = coordinateSpace;
      }
      widget.maxPositionWidth = maxPositionWidth;
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
    };
    const {singleDimensionId} = this;
    if (singleDimensionId !== undefined) {
      const dimensionIndex = this.getDimensionIndex(singleDimensionId);
      if (dimensionIndex === -1) {
        updateChildren(this.dimensionContainer, []);
      } else {
        updateChildren(
            this.dimensionContainer, [getDimensionWidget(singleDimensionId, dimensionIndex)]);
      }
    } else {
      updateChildren(this.dimensionContainer, ids.map(getDimensionWidget));
    }
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

  constructor(public position: Borrowed<Position>, public combiner: CoordinateSpaceCombiner, {
    copyButton = true,
    velocity = undefined,
    singleDimensionId = undefined,
    getToolBinder = undefined,
    allowFocus = true,
    showPlayback = true,
  }: {
    copyButton?: boolean,
    velocity?: CoordinateSpacePlaybackVelocity,
    singleDimensionId?: DimensionId,
    getToolBinder?: (() => (LocalToolBinder | undefined))|undefined,
    allowFocus?: boolean,
    showPlayback?: boolean,
  } = {}) {
    super();
    const {element, dimensionContainer} = this;
    this.velocity = velocity;
    this.singleDimensionId = singleDimensionId;
    this.getToolBinder = getToolBinder;
    this.allowFocus = allowFocus;
    this.showPlayback = showPlayback;
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

    const debouncedUpdateView =
        this.registerCancellable(animationFrameDebounce(() => this.updateView()));
    this.registerDisposer(position.changed.add(debouncedUpdateView));
    if (velocity !== undefined) {
      this.registerDisposer(velocity.changed.add(debouncedUpdateView));
    }

    const shouldIgnoreEvent = (event: Event) => {
      const target = event.target;
      if (target instanceof Element &&
          target.matches('.neuroglancer-position-dimension-playback *')) {
        return true;
      }
      return false;
    };
    if (allowFocus) {
      const keyboardHandler =
          this.registerDisposer(new KeyboardEventBinder(element, inputEventMap));
      keyboardHandler.allShortcutsAreGlobal = true;
      keyboardHandler.shouldIgnore = shouldIgnoreEvent;
    }
    const mouseHandler = this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    mouseHandler.shouldIgnore = shouldIgnoreEvent;
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


  adjustDimensionPosition(id: DimensionId, adjustment: number) {
    const axisIndex = this.getDimensionIndex(id);
    if (axisIndex === -1) return;
    this.updatePosition();
    const {position} = this;
    if (!position.valid) {
      return;
    }
    const coordinateSpace = position.coordinateSpace.value;
    const {bounds} = coordinateSpace;
    const voxelCoordinates = Float32Array.from(position.value);
    voxelCoordinates[axisIndex] = clampAndRoundCoordinateToVoxelCenter(
        bounds, axisIndex, voxelCoordinates[axisIndex] + adjustment);
    this.position.value = voxelCoordinates;
    this.updateView();
  }

  adjustDimensionVelocity(widget: DimensionWidget, factor: number) {
    const {velocity} = this;
    if (velocity === undefined) return;
    velocity.multiplyVelocity(widget.id, factor);
  }

  private updatePosition() {
    if (!this.allowFocus) return;
    const {dimensionWidgetList} = this;
    const {position} = this;
    const {value: voxelCoordinates} = position;
    const coordinateSpace = position.coordinateSpace.value;
    if (voxelCoordinates === undefined) return;
    const rank = dimensionWidgetList.length;
    let modified = false;
    for (let i = 0; i < rank; ++i) {
      const widget = dimensionWidgetList[i];
      if (!widget.modified) continue;
      widget.modified = false;
      modified = true;
      const valueString = widget.coordinate.value;
      let value = Number(valueString);
      if (!Number.isFinite(value)) continue;
      // If `valueString` contains a decimal point, don't adjust to voxel center.
      if (Number.isInteger(value) && !valueString.includes('.') && coordinateSpace !== undefined &&
          !coordinateSpace.bounds.voxelCenterAtIntegerCoordinates[i]) {
        value += 0.5;
      }
      voxelCoordinates[i] = value;
    }
    if (modified) {
      position.value = voxelCoordinates;
    }
  }

  private updateNames() {
    if (!this.allowFocus) return;
    const {dimensionWidgetList} = this;
    const {position: {coordinateSpace}} = this;
    const existing = coordinateSpace.value;
    const names = dimensionWidgetList.map(x => x.nameElement.value);
    if (this.combiner.getRenameValidity(names).includes(false)) return false;
    const existingNames = existing.names;
    if (arraysEqual(existingNames, names)) return false;
    const timestamps =
        existing.timestamps.map((t, i) => (existingNames[i] === names[i]) ? t : Date.now());
    const newSpace = {...existing, names, timestamps};
    coordinateSpace.value = newSpace;
    return true;
  }

  private updateScales() {
    if (!this.allowFocus) return;
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
    const {velocity} = this;
    for (let i = 0; i < rank; ++i) {
      const widget = dimensionWidgetList[i];
      const inputElement = widget.coordinate;
      const newCoord = Math.floor(voxelCoordinates[i]);
      const newValue = newCoord.toString();
      updateCoordinateFieldWidth(widget, newValue);
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
      if (this.showPlayback) {
        const velocityInfo = velocity?.value?.[i];
        if (velocityInfo !== undefined) {
          const paused = velocityInfo.paused;
          widget.playButton.style.display = paused ? '' : 'none';
          widget.pauseButton.style.display = (!paused) ? '' : 'none';
        } else {
          widget.playButton.style.display = 'none';
          widget.pauseButton.style.display = 'none';
        }
      }
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

const DIMENSION_TOOL_ID = 'dimension';

interface SupportsDimensionTool<ToolContext extends Object = Object> {
  position: Position;
  velocity: CoordinateSpacePlaybackVelocity;
  coordinateSpaceCombiner: CoordinateSpaceCombiner;
  toolBinder: LocalToolBinder<ToolContext>;
}

const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
  'at:shift?+wheel': {action: 'adjust-position-via-wheel'},
  'at:shift?+alt+wheel': {action: 'adjust-velocity-via-wheel'},
  'shift?+alt?+space': {action: 'toggle-playback'},
  'at:shift?+alt?+mousedown0': {action: 'toggle-playback'},

});

class DimensionTool<Viewer extends Object> extends Tool<Viewer> {
  get position() {
    return this.viewer.position;
  }
  get velocity() {
    return this.viewer.velocity;
  }
  get coordinateSpace() {
    return this.viewer.coordinateSpaceCombiner.combined;
  }

  activate(activation: ToolActivation<this>) {
    const {viewer} = this;
    const {content} = makeToolActivationStatusMessage(activation);
    content.classList.add('neuroglancer-position-tool');
    activation.bindInputEventMap(TOOL_INPUT_EVENT_MAP);
    const positionWidget = new PositionWidget(viewer.position, viewer.coordinateSpaceCombiner, {
      velocity: viewer.velocity,
      singleDimensionId: this.dimensionId,
      copyButton: false,
      allowFocus: false,
      showPlayback: false,
    });
    positionWidget.element.style.userSelect = 'none';
    content.appendChild(activation.registerDisposer(positionWidget).element);
    const plot =
        activation.registerDisposer(new PositionPlot(viewer.position, this.dimensionId, 'row'));
    plot.element.style.flex = '1';
    content.appendChild(plot.element);
    activation.bindAction<WheelEvent>('adjust-position-via-wheel', actionEvent => {
      actionEvent.stopPropagation();
      const event = actionEvent.detail;
      const {deltaY} = event;
      if (deltaY === 0) {
        return;
      }
      positionWidget.adjustDimensionPosition(this.dimensionId, Math.sign(deltaY));
    });

    const watchableVelocity = this.velocity.dimensionVelocity(activation, this.dimensionId);
    const enabled = activation.registerDisposer(
        makeCachedDerivedWatchableValue(value => value !== undefined, [watchableVelocity]));
    content.appendChild(
        activation
            .registerDisposer(new DependentViewWidget(
                enabled,
                (enabledValue, parent, context) => {
                  if (!enabledValue) return;
                  parent.classList.add('neuroglancer-position-dimension-playback');
                  const playButton = document.createElement('div');
                  const pauseButton = document.createElement('div');
                  playButton.classList.add('neuroglancer-icon');
                  pauseButton.classList.add('neuroglancer-icon');
                  playButton.innerHTML = svg_play;
                  pauseButton.innerHTML = svg_pause;
                  parent.appendChild(playButton);
                  parent.appendChild(pauseButton);
                  const togglePlayback = () => viewer.velocity.togglePlayback(this.dimensionId);
                  playButton.addEventListener('click', togglePlayback);
                  pauseButton.addEventListener('click', togglePlayback);
                  const updatePlayPause = () => {
                    const paused = watchableVelocity.value?.paused;
                    playButton.style.display = paused ? '' : 'none';
                    pauseButton.style.display = (!paused) ? '' : 'none';
                  };
                  context.registerDisposer(watchableVelocity.changed.add(updatePlayPause));
                  updatePlayPause();
                  const velocityModel = new WatchableValue<number>(0);
                  velocityModel.changed.add(() => {
                    const newValue = velocityModel.value;
                    const velocity = watchableVelocity.value;
                    if (velocity === undefined) return;
                    if (velocity.velocity === newValue) return;
                    watchableVelocity.value = {...velocity, velocity: newValue};
                  });
                  const negateButton = makeIcon({
                    text: '±',
                    title: 'Negate velocity',
                    onClick: () => {
                      velocityModel.value = -velocityModel.value;
                    },
                  });
                  const velocityInputWidget =
                      context.registerDisposer(new NumberInputWidget(velocityModel));
                  velocityInputWidget.inputElement.disabled = true;
                  velocityInputWidget.element.insertBefore(
                      negateButton, velocityInputWidget.element.firstChild);
                  velocityInputWidget.element.title = 'Velocity in coordinates per second';
                  const rateSpan = document.createElement('span');
                  rateSpan.textContent = '/s';
                  velocityInputWidget.element.appendChild(rateSpan);
                  parent.appendChild(velocityInputWidget.element);
                  const trackableEnum = new TrackableEnum<VelocityBoundaryBehavior>(
                      VelocityBoundaryBehavior, VelocityBoundaryBehavior.STOP);
                  const watchableVelocityChanged = () => {
                    trackableEnum.value =
                        watchableVelocity.value?.atBoundary ?? VelocityBoundaryBehavior.STOP;
                    velocityModel.value = watchableVelocity.value?.velocity ?? 0;
                  };
                  watchableVelocityChanged();
                  context.registerDisposer(watchableVelocity.changed.add(watchableVelocityChanged));
                  trackableEnum.changed.add(() => {
                    const atBoundary = trackableEnum.value;
                    const velocity = watchableVelocity.value;
                    if (velocity === undefined) return;
                    if (velocity.atBoundary === atBoundary) return;
                    watchableVelocity.value = {...velocity, atBoundary};
                  });
                  const selectWidget = new EnumSelectWidget(trackableEnum).element;
                  parent.appendChild(selectWidget);
                  selectWidget.title = 'Behavior when lower/upper bound is reached';
                }))
            .element);
    content.appendChild(
        activation
            .registerDisposer(new CheckboxIcon(viewer.velocity.playbackEnabled(this.dimensionId), {
              svg: svg_video,
              enableTitle: 'Enable playback/velocity',
              disableTitle: 'Disable playback/velocity',
              backgroundScheme: 'dark',
            }))
            .element);

    activation.bindAction<WheelEvent>('adjust-velocity-via-wheel', actionEvent => {
      actionEvent.stopPropagation();
      const factor = getWheelZoomAmount(actionEvent.detail);
      viewer.velocity.multiplyVelocity(this.dimensionId, factor);
    });
    activation.bindAction<WheelEvent>('toggle-playback', event => {
      event.stopPropagation();
      viewer.velocity.togglePlayback(this.dimensionId);
    });
  }

  get description() {
    return `dim ${this.dimensionName}`;
  }

  dimensionIndex: number;
  dimensionName: string;

  constructor(public viewer: SupportsDimensionTool<Viewer>, public dimensionId: DimensionId) {
    super(viewer.toolBinder);
    const coordinateSpace = this.coordinateSpace.value;
    const i = this.dimensionIndex = coordinateSpace.ids.indexOf(dimensionId);
    this.dimensionName = coordinateSpace.names[i];
    this.registerDisposer(this.coordinateSpace.changed.add(() => {
      const coordinateSpace = this.coordinateSpace.value;
      const i = this.dimensionIndex = this.coordinateSpace.value.ids.indexOf(dimensionId);
      if (i === -1) {
        this.unbind();
        return;
      }
      const newName = coordinateSpace.names[i];
      if (this.dimensionName !== newName) {
        this.dimensionName = newName;
        this.changed.dispatch();
      }
    }));
  }

  toJSON() {
    return {
      'type': DIMENSION_TOOL_ID,
      'dimension': this.dimensionName,
    };
  }
}

function makeDimensionTool(viewer: SupportsDimensionTool, obj: unknown) {
  const dimension = verifyObjectProperty(obj, 'dimension', verifyString);
  const coordinateSpace = viewer.coordinateSpaceCombiner.combined.value;
  const dimensionIndex = coordinateSpace.names.indexOf(dimension);
  if (dimensionIndex === -1) {
    throw new Error(`Invalid dimension name: ${JSON.stringify(dimension)}`);
  }
  return new DimensionTool(viewer, coordinateSpace.ids[dimensionIndex]);
}

registerTool(
    Viewer, DIMENSION_TOOL_ID,
    (viewer, obj) => makeDimensionTool(
        {
          position: viewer.position,
          velocity: viewer.velocity,
          coordinateSpaceCombiner: viewer.layerSpecification.coordinateSpaceCombiner,
          toolBinder: viewer.toolBinder,
        },
        obj));

registerTool(
    UserLayer, DIMENSION_TOOL_ID,
    (layer, obj) => makeDimensionTool(
        {
          position: layer.localPosition,
          velocity: layer.localVelocity,
          coordinateSpaceCombiner: layer.localCoordinateSpaceCombiner,
          toolBinder: layer.toolBinder,
        },
        obj));

registerTool(
    LayerGroupViewer, DIMENSION_TOOL_ID,
    (layerGroupViewer, obj) => makeDimensionTool(
        {
          position: layerGroupViewer.viewerNavigationState.position.value,
          velocity: layerGroupViewer.viewerNavigationState.velocity.velocity,
          coordinateSpaceCombiner: layerGroupViewer.layerSpecification.root.coordinateSpaceCombiner,
          toolBinder: layerGroupViewer.toolBinder,
        },
        obj));
