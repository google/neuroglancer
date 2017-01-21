/**
 * @license
 * Copyright 2016 Google Inc.
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

import debounce from 'lodash/debounce';
import {CancellationToken, CancellationTokenSource} from 'neuroglancer/util/cancellation';
import {BasicCompletionResult, Completion, CompletionWithDescription} from 'neuroglancer/util/completion';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {positionDropdown} from 'neuroglancer/util/dropdown';
import {KeyboardShortcutHandler, KeySequenceMap} from 'neuroglancer/util/keyboard_shortcut_handler';
import {longestCommonPrefix} from 'neuroglancer/util/longest_common_prefix';
import {scrollIntoViewIfNeeded} from 'neuroglancer/util/scroll_into_view';
import {Signal} from 'neuroglancer/util/signal';
import {associateLabelWithElement} from 'neuroglancer/widget/associate_label';

export {Completion, CompletionWithDescription} from 'neuroglancer/util/completion';

require('./autocomplete.css');

const ACTIVE_COMPLETION_CLASS_NAME = 'autocomplete-completion-active';

const AUTOCOMPLETE_INDEX_SYMBOL = Symbol('autocompleteIndex');

export interface CompletionResult extends BasicCompletionResult {
  showSingleResult?: boolean;
  selectSingleResult?: boolean;
  makeElement?: (completion: Completion) => HTMLElement;
}

export function makeDefaultCompletionElement(completion: Completion) {
  let element = document.createElement('div');
  element.textContent = completion.value;
  return element;
}

export function makeCompletionElementWithDescription(completion: CompletionWithDescription) {
  let element = document.createElement('div');
  element.className = 'autocomplete-completion-with-description';
  element.textContent = completion.value;
  let descriptionElement = document.createElement('div');
  descriptionElement.className = 'autocomplete-completion-description';
  descriptionElement.textContent = completion.description || '';
  element.appendChild(descriptionElement);
  return element;
}

const KEY_MAP = new KeySequenceMap({
  'arrowdown': 'cycle-next-active-completion',
  'arrowup': 'cycle-prev-active-completion',
  'tab': 'choose-active-completion-or-prefix',
  'enter': 'choose-active-completion',
  'escape': 'cancel',
});

const KEY_COMMANDS = new Map<string, (this: AutocompleteTextInput) => boolean>([
  [
    'cycle-next-active-completion',
    function() {
      this.cycleActiveCompletion(+1);
      return true;
    }
  ],
  [
    'cycle-prev-active-completion',
    function() {
      this.cycleActiveCompletion(-1);
      return true;
    }
  ],
  [
    'choose-active-completion-or-prefix',
    function() {
      return this.selectActiveCompletion(/*allowPrefix=*/true);
    }
  ],
  [
    'choose-active-completion',
    function() {
      return this.selectActiveCompletion(/*allowPrefix=*/false);
    }
  ],
  [
    'cancel',
    function() {
      return this.cancel();
    }
  ],
]);

export type Completer = (value: string, cancellationToken: CancellationToken) =>
    Promise<CompletionResult>| null;

const DEFAULT_COMPLETION_DELAY = 200;  // milliseconds

export class AutocompleteTextInput extends RefCounted {
  element: HTMLDivElement;
  promptElement: HTMLLabelElement;
  inputWrapperElement: HTMLDivElement;
  inputElement: HTMLInputElement;
  hintElement: HTMLInputElement;
  dropdownElement: HTMLDivElement;
  inputChanged = new Signal<(value: string) => void>();
  private prevInputValue = '';
  private completionsVisible = false;
  private activeCompletionPromise: Promise<CompletionResult>|null = null;
  private activeCompletionCancellationToken: CancellationTokenSource|undefined = undefined;
  private hasFocus = false;
  private completionResult: CompletionResult|null = null;
  private dropdownContentsStale = true;
  private updateHintScrollPositionTimer: number|null = null;
  private keyboardHandler: KeyboardShortcutHandler;
  private completionElements: HTMLElement[]|null = null;
  private hasResultForDropdown = false;
  private commonPrefix = '';

  /**
   * Index of the active completion.  The active completion is displayed as the hint text and is
   * highlighted in the dropdown.
   */
  private activeIndex = -1;

  private dropdownStyleStale = true;

  private scheduleUpdateCompletions: () => void;
  completer: Completer;

  constructor(options: {completer: Completer, delay?: number}) {
    super();
    this.completer = options.completer;
    let {delay = DEFAULT_COMPLETION_DELAY} = options;

    let debouncedCompleter = this.scheduleUpdateCompletions = debounce(() => {
      const cancellationToken = this.activeCompletionCancellationToken =
          new CancellationTokenSource();
      let activeCompletionPromise = this.activeCompletionPromise =
          this.completer(this.value, cancellationToken);
      if (activeCompletionPromise !== null) {
        activeCompletionPromise.then(completionResult => {
          if (this.activeCompletionPromise === activeCompletionPromise) {
            this.setCompletions(completionResult);
            this.activeCompletionPromise = null;
          }
        });
      }
    }, delay);
    this.registerDisposer(() => {
      debouncedCompleter.cancel();
    });

    let element = this.element = document.createElement('div');
    element.className = 'autocomplete';

    let dropdownAndInputWrapper = document.createElement('div');
    dropdownAndInputWrapper.className = 'autocomplete-dropdown-wrapper';

    let dropdownElement = this.dropdownElement = document.createElement('div');
    dropdownElement.className = 'autocomplete-dropdown';

    let promptElement = this.promptElement = document.createElement('label');
    promptElement.className = 'autocomplete-prompt';

    let inputWrapperElement = this.inputWrapperElement = document.createElement('div');
    inputWrapperElement.className = 'autocomplete-input-wrapper';

    element.appendChild(promptElement);

    let inputElement = this.inputElement = document.createElement('input');
    inputElement.type = 'text';
    inputElement.autocomplete = 'off';
    inputElement.spellcheck = false;
    inputElement.className = 'autocomplete-input';
    associateLabelWithElement(promptElement, inputElement);

    let hintElement = this.hintElement = document.createElement('input');
    hintElement.type = 'text';
    hintElement.spellcheck = false;
    hintElement.className = 'autocomplete-hint';
    hintElement.disabled = true;
    inputWrapperElement.appendChild(hintElement);
    inputWrapperElement.appendChild(inputElement);

    dropdownAndInputWrapper.appendChild(inputWrapperElement);
    dropdownAndInputWrapper.appendChild(dropdownElement);
    element.appendChild(dropdownAndInputWrapper);

    this.registerInputHandler();
    this.handleInputChanged('');

    this.registerEventListener(this.inputElement, 'focus', () => {
      if (!this.hasFocus) {
        this.hasFocus = true;
        this.dropdownStyleStale = true;
        this.updateDropdown();
      }
    });
    this.registerEventListener(this.inputElement, 'blur', () => {
      if (this.hasFocus) {
        this.hasFocus = false;
        this.updateDropdown();
      }
    });
    this.registerEventListener(element.ownerDocument.defaultView, 'resize', () => {
      this.dropdownStyleStale = true;
    });

    this.registerEventListener(element.ownerDocument.defaultView, 'scroll', () => {
      this.dropdownStyleStale = true;
    });

    this.registerEventListener(
        this.dropdownElement, 'mousedown', this.handleDropdownMousedown.bind(this));

    this.registerEventListener(this.inputElement, 'keydown', () => {
      // User may have used a keyboard shortcut to scroll the input.
      this.hintScrollPositionMayBeStale();
    });

    this.registerEventListener(this.inputElement, 'mousemove', (event: MouseEvent) => {
      if (event.buttons !== 0) {
        // May be dragging the text, which could cause scrolling.  This is not perfect, because we
        // don't detect mouse movements outside of the input box.
        this.hintScrollPositionMayBeStale();
      }
    });

    let keyboardHandler = this.keyboardHandler = this.registerDisposer(
        new KeyboardShortcutHandler(inputElement, KEY_MAP, this.handleKeyCommand.bind(this)));
    keyboardHandler.allShortcutsAreGlobal = true;
  }

  private hintScrollPositionMayBeStale() {
    if (this.hintElement.value !== '') {
      this.scheduleUpdateHintScrollPosition();
    }
  }

  get disabled() {
    return this.inputElement.disabled;
  }

  set disabled(value: boolean) {
    this.inputElement.disabled = value;
  }

  private handleDropdownMousedown(event: MouseEvent) {
    this.inputElement.focus();
    let {dropdownElement} = this;
    for (let target: EventTarget|null = event.target; target instanceof HTMLElement;
         target = target.parentElement) {
      let index = (<any>target)[AUTOCOMPLETE_INDEX_SYMBOL];
      if (index !== undefined) {
        this.selectCompletion(index);
        break;
      }
      if (target === dropdownElement) {
        break;
      }
    }
    event.preventDefault();
  }

  cycleActiveCompletion(delta: number) {
    if (this.completionResult === null) {
      return;
    }
    let {activeIndex} = this;
    let numCompletions = this.completionResult.completions.length;
    if (activeIndex === -1) {
      if (delta > 0) {
        activeIndex = 0;
      } else {
        activeIndex = numCompletions - 1;
      }
    } else {
      activeIndex = (activeIndex + delta + numCompletions) % numCompletions;
    }
    this.setActiveIndex(activeIndex);
  }

  private handleKeyCommand(action: string) {
    return KEY_COMMANDS.get(action)!.call(this);
  }

  private registerInputHandler() {
    const handler = (_event: Event) => {
      let value = this.inputElement.value;
      if (value !== this.prevInputValue) {
        this.prevInputValue = value;
        this.handleInputChanged(value);
      }
    };
    for (let eventType of ['input']) {
      this.registerEventListener(this.inputElement, eventType, handler, /*useCapture=*/false);
    }
  }

  private shouldShowDropdown() {
    let {completionResult} = this;
    if (completionResult === null || !this.hasFocus) {
      return false;
    }
    return this.hasResultForDropdown;
  }

  private updateDropdownStyle() {
    let {element, dropdownElement, inputElement} = this;
    positionDropdown(dropdownElement, inputElement, {horizontal: false});
    this.dropdownStyleStale = false;
  }

  private updateDropdown() {
    if (this.shouldShowDropdown()) {
      let {dropdownElement} = this;
      let {activeIndex} = this;
      if (this.dropdownContentsStale) {
        let completionResult = this.completionResult!;
        let {makeElement = makeDefaultCompletionElement} = completionResult;
        this.completionElements = completionResult.completions.map((completion, index) => {
          let completionElement = makeElement.call(completionResult, completion);
          (<any>completionElement)[AUTOCOMPLETE_INDEX_SYMBOL] = index;
          completionElement.classList.add('autocomplete-completion');
          if (activeIndex === index) {
            completionElement.classList.add(ACTIVE_COMPLETION_CLASS_NAME);
          }
          dropdownElement.appendChild(completionElement);
          return completionElement;
        });
        this.dropdownContentsStale = false;
      }
      if (this.dropdownStyleStale) {
        this.updateDropdownStyle();
      }
      if (!this.completionsVisible) {
        dropdownElement.style.display = 'block';
        this.completionsVisible = true;
      }
      if (activeIndex !== -1) {
        let completionElement = this.completionElements![activeIndex];
        scrollIntoViewIfNeeded(completionElement);
      }
    } else if (this.completionsVisible) {
      this.dropdownElement.style.display = 'none';
      this.completionsVisible = false;
    }
  }

  private setCompletions(completionResult: CompletionResult) {
    this.clearCompletions();
    let {completions} = completionResult;
    if (completions.length === 0) {
      return;
    }
    this.completionResult = completionResult;

    if (completions.length === 1) {
      let completion = completions[0];
      if (completionResult.showSingleResult) {
        this.hasResultForDropdown = true;
      } else {
        let value = this.prevInputValue;
        if (!completion.value.startsWith(value)) {
          this.hasResultForDropdown = true;
        } else {
          this.hasResultForDropdown = false;
        }
      }
      if (completionResult.selectSingleResult) {
        this.setActiveIndex(0);
      } else {
        this.setHintValue(this.getCompletedValueByIndex(0));
      }
    } else {
      this.hasResultForDropdown = true;
      // Check for a common prefix.
      let commonResultPrefix = longestCommonPrefix(function*() {
        for (let completion of completionResult.completions) {
          yield completion.value;
        }
      }());
      let commonPrefix = this.getCompletedValue(commonResultPrefix);
      let value = this.prevInputValue;
      if (commonPrefix.startsWith(value)) {
        this.commonPrefix = commonPrefix;
        this.setHintValue(commonPrefix);
      }
    }
    this.updateDropdown();
  }

  private scheduleUpdateHintScrollPosition() {
    if (this.updateHintScrollPositionTimer === null) {
      this.updateHintScrollPositionTimer = setTimeout(() => {
        this.updateHintScrollPosition();
      }, 0);
    }
  }

  setHintValue(hintValue: string) {
    let value = this.prevInputValue;
    if (hintValue === value || !hintValue.startsWith(value)) {
      // If the hint value is identical to the current value, there is no need to show it.  Also,
      // if it is not a prefix of the current value, then we cannot show it either.
      hintValue = '';
    }
    this.hintElement.value = hintValue;
    this.scheduleUpdateHintScrollPosition();
  }

  /**
   * This sets the active completion, which causes it to be highlighted and displayed as the hint.
   * Additionally, if the user hits tab then it is chosen.
   */
  private setActiveIndex(index: number) {
    if (!this.dropdownContentsStale) {
      let {activeIndex} = this;
      if (activeIndex !== -1) {
        this.completionElements![activeIndex].classList.remove(ACTIVE_COMPLETION_CLASS_NAME);
      }
      if (index !== -1) {
        let completionElement = this.completionElements![index];
        completionElement.classList.add(ACTIVE_COMPLETION_CLASS_NAME);
        scrollIntoViewIfNeeded(completionElement);
      }
    }
    if (index !== -1) {
      this.setHintValue(this.getCompletedValueByIndex(index));
    }
    this.activeIndex = index;
  }

  private getCompletedValueByIndex(index: number) {
    return this.getCompletedValue(this.completionResult!.completions[index].value);
  }

  private getCompletedValue(completionValue: string) {
    let completionResult = this.completionResult!;
    let value = this.prevInputValue;
    return value.substring(0, completionResult.offset) + completionValue;
  }

  selectActiveCompletion(allowPrefix: boolean) {
    let {activeIndex} = this;
    if (activeIndex === -1) {
      if (!allowPrefix) {
        return false;
      }
      let {completionResult} = this;
      if (completionResult !== null && completionResult.completions.length === 1) {
        activeIndex = 0;
      } else {
        let {commonPrefix} = this;
        if (commonPrefix.length > this.value.length) {
          this.value = commonPrefix;
          return true;
        }
        return false;
      }
    }
    let newValue = this.getCompletedValueByIndex(activeIndex);
    if (this.value === newValue) {
      return false;
    }
    this.value = newValue;
    return true;
  }

  selectCompletion(index: number) {
    this.value = this.getCompletedValueByIndex(index);
  }

  /**
   * Called when user presses escape.  Does nothing here, but may be overridden in a subclass.
   */
  cancel() {
    return false;
  }

  /**
   * Updates the hintElement scroll position to match the scroll position of inputElement.
   *
   * This is called asynchronously after the input changes because automatic scrolling appears to
   * take place after the 'input' event fires.
   */
  private updateHintScrollPosition() {
    this.updateHintScrollPositionTimer = null;
    this.hintElement.scrollLeft = this.inputElement.scrollLeft;
  }

  private cancelActiveCompletion() {
    const token = this.activeCompletionCancellationToken;
    if (token !== undefined) {
      token.cancel();
    }
    this.activeCompletionCancellationToken = undefined;
    this.activeCompletionPromise = null;
  }

  private handleInputChanged(value: string) {
    this.cancelActiveCompletion();
    this.hintElement.value = '';
    this.clearCompletions();
    this.inputChanged.dispatch(value);
    this.scheduleUpdateCompletions();
  }

  private clearCompletions() {
    if (this.completionResult !== null) {
      this.activeIndex = -1;
      this.completionResult = null;
      this.completionElements = null;
      this.dropdownContentsStale = true;
      this.dropdownStyleStale = true;
      this.commonPrefix = '';
      removeChildren(this.dropdownElement);
      this.updateDropdown();
    }
  }

  get value() {
    return this.prevInputValue;
  }

  set value(value: string) {
    if (value !== this.prevInputValue) {
      this.inputElement.value = value;
      this.prevInputValue = value;
      this.handleInputChanged(value);
    }
  }

  disposed() {
    removeFromParent(this.element);
    this.cancelActiveCompletion();
    if (this.updateHintScrollPositionTimer !== null) {
      clearTimeout(this.updateHintScrollPositionTimer);
      this.updateHintScrollPositionTimer = null;
    }
    super.disposed();
  }
}
