/**
 * @license
 * Copyright 2017 Google Inc.
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

import {MouseSelectionState} from 'neuroglancer/layer';
import {SpatialPosition, VoxelSize} from 'neuroglancer/navigation_state';
import {StatusMessage} from 'neuroglancer/status';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {EventActionMap, registerActionListener} from 'neuroglancer/util/event_action_map';
import {vec3} from 'neuroglancer/util/geom';
import {KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {numberToStringFixed} from 'neuroglancer/util/number_to_string';
import {pickLengthUnit} from 'neuroglancer/widget/scale_bar';

import './position_widget.css';
import 'neuroglancer/ui/button.css';

export const positionDragType = 'neuroglancer-position';

const inputEventMap = EventActionMap.fromObject({
  'tab': {action: 'tab-forward', preventDefault: false},
  'arrowup': {action: 'adjust-up'},
  'arrowdown': {action: 'adjust-down'},
  'wheel': {action: 'adjust-via-wheel'},
  'shift+tab': {action: 'tab-backward', preventDefault: false},
  'backspace': {action: 'delete-backward', preventDefault: false},
  'escape': {action: 'cancel'},
  'mouseup0': {action: 'select-all-if-was-not-focused', preventDefault: false},
});

const normalizedPrefixString = '  ';
const normalizedSeparatorString = ',   ';

export class PositionWidget extends RefCounted {
  element = document.createElement('div');
  inputContainer = document.createElement('div');
  inputElement = document.createElement('input');
  hintElement = document.createElement('input');

  tempPosition = vec3.create();

  inputFieldWidth: number;

  constructor(public position: SpatialPosition, public maxNumberWidth = 6) {
    super();
    const {element, inputElement, hintElement, inputContainer} = this;
    inputContainer.className = 'neuroglancer-position-widget-input-container';
    inputElement.className = 'neuroglancer-position-widget-input';
    hintElement.className = 'neuroglancer-position-widget-hint';

    this.inputFieldWidth =
        maxNumberWidth * 3 + normalizedPrefixString.length + normalizedSeparatorString.length * 2 + 1;

    for (const x of [inputElement, hintElement]) {
      x.spellcheck = false;
      x.autocomplete = 'off';
      x.type = 'text';
      x.style.width = this.inputFieldWidth + 'ch';
    }
    hintElement.disabled = true;
    const copyButton = document.createElement('div');
    copyButton.textContent = '⧉';
    copyButton.className = 'neuroglancer-copy-button neuroglancer-button';
    copyButton.title = 'Copy position to clipboard';
    copyButton.addEventListener('click', () => {
      const result = setClipboard(this.getPositionText());
      StatusMessage.showTemporaryMessage(
          result ? 'Position copied to clipboard' : 'Failed to copy position to clipboard');
    });
    copyButton.addEventListener('dragstart', event => {
      event.dataTransfer!.setData(positionDragType, JSON.stringify(position.toJSON()));
      event.dataTransfer!.setData('text', this.getPositionText());
      event.stopPropagation();
    });
    copyButton.draggable = true;
    element.appendChild(copyButton);
    element.appendChild(inputContainer);
    inputContainer.appendChild(inputElement);
    inputContainer.appendChild(hintElement);
    element.className = 'neuroglancer-position-widget';
    this.registerDisposer(position.changed.add(
        this.registerCancellable(animationFrameDebounce(() => this.updateView()))));

    const keyboardHandler =
        this.registerDisposer(new KeyboardEventBinder(inputElement, inputEventMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    this.registerDisposer(new MouseEventBinder(inputElement, inputEventMap));

    this.registerEventListener(inputElement, 'change', () => this.updatePosition());
    this.registerEventListener(inputElement, 'blur', () => this.updatePosition());
    this.registerEventListener(inputElement, 'input', () => this.cleanInput());
    this.registerEventListener(inputElement, 'keydown', this.updateHintScrollPosition);
    this.registerEventListener(inputElement, 'copy', (event: ClipboardEvent) => {
      const {selectionStart, selectionEnd} = inputElement;
      let selection = inputElement.value.substring(selectionStart || 0, selectionEnd || 0);
      selection = selection.trim().replace(/\s+/g, ' ');
      const {clipboardData} = event;
      if (clipboardData !== null) {
        clipboardData.setData('text/plain', selection);
      }
      event.stopPropagation();
      event.preventDefault();
    });
    let wasFocused = false;
    this.registerEventListener(inputElement, 'mousedown', () => {
      wasFocused = document.activeElement === inputElement;
    });

    this.registerDisposer(
        registerActionListener(inputElement, 'select-all-if-was-not-focused', event => {
          if (wasFocused) {
            return;
          }
          inputElement.selectionStart = 0;
          inputElement.selectionEnd = inputElement.value.length;
          inputElement.selectionDirection = 'forward';
          event.preventDefault();
        }));

    this.registerDisposer(registerActionListener(inputElement, 'tab-forward', event => {
      const selectionStart =
          Math.min(inputElement.selectionStart || 0, inputElement.selectionEnd || 0);
      const valueSubstring = inputElement.value.substring(selectionStart);
      const match = valueSubstring.match(/^([^,\s]*)((?:\s+)|(?:\s*,\s*))?([^,\s]*)/);
      if (match !== null) {
        // Already on a field.  Pick the next field.
        if (match[2] !== undefined) {
          inputElement.selectionStart = selectionStart + match[1].length + match[2].length;
          inputElement.selectionEnd = inputElement.selectionStart + match[3].length;
          inputElement.selectionDirection = 'forward';
          event.preventDefault();
          return;
        }
      }
    }));

    this.registerDisposer(registerActionListener(inputElement, 'tab-backward', event => {
      const selectionEnd =
          Math.max(inputElement.selectionStart || 0, inputElement.selectionEnd || 0);
      const valueSubstring = inputElement.value.substring(0, selectionEnd);
      const match = valueSubstring.match(/([^,\s]*)((?:\s+)|(?:\s*,\s*))?([^,\s]*)$/);
      if (match !== null) {
        // Already on a field.  Pick the previous field.
        if (match[2] !== undefined) {
          inputElement.selectionStart = match.index!;
          inputElement.selectionEnd = inputElement.selectionStart + match[1].length;
          inputElement.selectionDirection = 'forward';
          event.preventDefault();
          return;
        }
      }
    }));

    this.registerDisposer(registerActionListener(inputElement, 'delete-backward', event => {
      if (inputElement.selectionStart === inputElement.selectionEnd &&
          inputElement.selectionStart === inputElement.value.length) {
        const match = inputElement.value.match(/^(.*)(?![\s])(?:(?:\s+)|(?:\s*,\s*))$/);
        if (match !== null) {
          inputElement.value = match[1];
          this.cleanInput();
          event.preventDefault();
          return;
        }
      }
    }));

    this.registerDisposer(registerActionListener(inputElement, 'cancel', () => {
      this.updateView();
      this.inputElement.blur();
    }));

    this.registerDisposer(
        registerActionListener<WheelEvent>(inputElement, 'adjust-via-wheel', actionEvent => {
          const event = actionEvent.detail;
          const {deltaY} = event;
          if (deltaY === 0) {
            return;
          }
          const mouseCursorPosition = Math.ceil(
              (inputElement.scrollLeft + event.offsetX - inputElement.clientLeft) /
              (inputElement.scrollWidth / this.inputFieldWidth));

          this.adjustFromCursor(mouseCursorPosition, -Math.sign(deltaY));
        }));

    this.registerDisposer(registerActionListener<WheelEvent>(inputElement, 'adjust-up', () => {
      this.adjustFromCursor(undefined, 1);
    }));
    this.registerDisposer(registerActionListener<WheelEvent>(inputElement, 'adjust-down', () => {
      this.adjustFromCursor(undefined, -1);
    }));
    this.updateView();
  }

  private adjustFromCursor(cursorPosition: number|undefined, adjustment: number) {
    const {inputElement} = this;
    if (cursorPosition === undefined) {
      cursorPosition =
          (inputElement.selectionDirection === 'forward' ? inputElement.selectionEnd :
                                                           inputElement.selectionStart) ||
          0;
    }
    if (this.cleanInput() === undefined) {
      return;
    }

    const substring = inputElement.value.substring(0, cursorPosition);
    const axisIndex = substring.split(',').length - 1;
    this.updatePosition();
    const voxelCoordinates = this.tempPosition;
    if (this.position.getVoxelCoordinates(voxelCoordinates)) {
      voxelCoordinates[axisIndex] += adjustment;
      this.position.setVoxelCoordinates(voxelCoordinates);
      this.updateView();
    }
  }

  private cleanInput(): {position?: vec3}|undefined {
    const s = this.inputElement.value;
    const cursorPosition = this.inputElement.selectionStart || 0;
    const numberPattern = /(-?\d+(?:\.(?:\d+)?)?)/.source;
    const separatorPattern = /((?:\s+(?![\s,]))|(?:\s*,\s*))/.source;
    const startAndEndPattern = /([\[\]{}()\s]*)/.source;
    const pattern = new RegExp(
        `^${startAndEndPattern}(?![\\s])${numberPattern}?` +
        `(?:${separatorPattern}${numberPattern}?(?:${separatorPattern}${numberPattern}?)?)?` +
        `${startAndEndPattern}$`);

    const match = s.match(pattern);
    if (match !== null) {
      let cleanInput = normalizedPrefixString;
      let hint = 'x ';
      let cleanCursor = 2;
      let curFieldStart = match[1].length;

      const processField =
          (matchText: string|undefined, replacementText: string|undefined = undefined,
           hintText: string|undefined = undefined) => {
            if (matchText === undefined) {
              return;
            }
            let curFieldEnd = curFieldStart + matchText.length;
            if (replacementText === undefined) {
              replacementText = matchText;
              hintText = ' '.repeat(replacementText.length);
            }

            if (cursorPosition >= curFieldStart) {
              if (cursorPosition === curFieldEnd) {
                cleanCursor = cleanInput.length + replacementText.length;
              } else {
                cleanCursor = cleanInput.length +
                    Math.min(replacementText.length, cursorPosition - curFieldStart);
              }
            }
            cleanInput += replacementText;
            hint += hintText;
            curFieldStart = curFieldEnd;
          };

      processField(match[2]);
      processField(match[3], normalizedSeparatorString, '  y ');
      processField(match[4]);
      processField(match[5], normalizedSeparatorString, '  z ');
      processField(match[6]);
      this.hintElement.value = hint;

      if (this.inputElement.value !== cleanInput) {
        this.inputElement.value = cleanInput;
        this.inputElement.selectionEnd = cleanCursor;
        this.inputElement.selectionStart = cleanCursor;
      }

      this.updateHintScrollPosition();

      if (match[2] !== undefined && match[4] !== undefined && match[6] !== undefined) {
        return {
          position: vec3.set(
              this.tempPosition, parseFloat(match[2]), parseFloat(match[4]), parseFloat(match[6]))
        };
      }
      return {};
    } else {
      this.hintElement.value = '';
    }
    return undefined;
  }

  private updatePosition() {
    const cleanResult = this.cleanInput();
    if (cleanResult !== undefined && cleanResult.position !== undefined) {
      this.position.setVoxelCoordinates(cleanResult.position);
    }
  }

  private getPositionText() {
    const {position} = this;
    const voxelPosition = this.tempPosition;
    if (position.getVoxelCoordinates(voxelPosition)) {
      return `${Math.floor(voxelPosition[0])}, ${Math.floor(voxelPosition[1])}, ${
          Math.floor(voxelPosition[2])}`;
    } else {
      return '<unspecified position>';
    }
  }

  private updateHintScrollPosition = this.registerCancellable(animationFrameDebounce(() => {
    this.hintElement.scrollLeft = this.inputElement.scrollLeft;
  }));

  private updateView() {
    const {position} = this;
    const voxelPosition = this.tempPosition;
    if (position.getVoxelCoordinates(voxelPosition)) {
      const {inputElement} = this;
      const inputText = `  ${Math.floor(voxelPosition[0])},   ${Math.floor(voxelPosition[1])},   ${
          Math.floor(voxelPosition[2])}`;
      const firstComma = inputText.indexOf(',');
      const secondComma = inputText.indexOf(',', firstComma + 1);
      const xLen = firstComma - 2;
      const yLen = secondComma - firstComma - 4;
      let hintText = `x ${' '.repeat(xLen)}  y ${' '.repeat(yLen)}  z`;

      const prevSelectionStart = inputElement.selectionStart || 0;
      const prevSelectionEnd = inputElement.selectionEnd || 0;
      const prevSelectionDirection: any = inputElement.selectionDirection || undefined;
      inputElement.value = inputText;
      inputElement.setSelectionRange(prevSelectionStart, prevSelectionEnd, prevSelectionDirection);
      this.hintElement.value = hintText + ' '.repeat(inputText.length - hintText.length);
      this.updateHintScrollPosition();
    } else {
      this.inputElement.value = '';
      this.hintElement.value = '';
    }
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}

export class VoxelSizeWidget extends RefCounted {
  dimensionsContainer = document.createElement('span');
  unitsElement = document.createElement('span');

  constructor (public element: HTMLElement, public voxelSize: VoxelSize) {
    super();
    const {dimensionsContainer, unitsElement} = this;
    element.className = 'neuroglancer-voxel-size-widget';
    element.title = 'Voxel size';
    dimensionsContainer.className = 'neuroglancer-voxel-size-dimensions-container';
    element.appendChild(dimensionsContainer);
    element.appendChild(unitsElement);
    unitsElement.className = 'neuroglancer-voxel-size-units';
    this.registerDisposer(voxelSize.changed.add(
        this.registerCancellable(animationFrameDebounce(() => this.updateView()))));
    this.updateView();
  }

  private updateView() {
    const {dimensionsContainer, unitsElement} = this;
    removeChildren(dimensionsContainer);
    if (!this.voxelSize.valid) {
      this.element.style.display = 'none';
    } else {
      this.element.style.display = null;
    }
    const {size} = this.voxelSize;
    const minVoxelSize = Math.min(size[0], size[1], size[2]);
    const unit = pickLengthUnit(minVoxelSize);
    unitsElement.textContent = unit.unit;
    for (let i = 0; i < 3; ++i) {
      const s = numberToStringFixed(size[i] / unit.lengthInNanometers, 2);
      const dimElement = document.createElement('span');
      dimElement.className = 'neuroglancer-voxel-size-dimension';
      dimElement.textContent = s;
      dimensionsContainer.appendChild(dimElement);
    }
  }
  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}

export class MousePositionWidget extends RefCounted {
  tempPosition = vec3.create();
  constructor (public element: HTMLElement, public mouseState: MouseSelectionState, public voxelSize: VoxelSize) {
    super();
    element.className = 'neuroglancer-mouse-position-widget';
    const updateViewFunction =
        this.registerCancellable(animationFrameDebounce(() => this.updateView()));
    this.registerDisposer(mouseState.changed.add(updateViewFunction));
    this.registerDisposer(voxelSize.changed.add(updateViewFunction));
  }
  updateView() {
    let text = '';
    const {mouseState, voxelSize} = this;
    if (mouseState.active && voxelSize.valid) {
      const p = this.tempPosition;
      voxelSize.voxelFromSpatial(p, mouseState.position);
      text = `x ${Math.floor(p[0])},  y ${Math.floor(p[1])},  z ${Math.floor(p[2])}`;
    }
    this.element.textContent = text;
  }
  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
