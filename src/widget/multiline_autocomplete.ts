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

import "#src/widget/multiline_autocomplete.css";

import { debounce } from "lodash-es";
import type {
  BasicCompletionResult,
  Completion,
  CompletionWithDescription,
} from "#src/util/completion.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren, removeFromParent } from "#src/util/dom.js";
import { positionDropdown } from "#src/util/dropdown.js";
import { formatErrorMessage } from "#src/util/error.js";
import {
  EventActionMap,
  KeyboardEventBinder,
  registerActionListener,
} from "#src/util/keyboard_bindings.js";
import { longestCommonPrefix } from "#src/util/longest_common_prefix.js";
import type { ProgressListener } from "#src/util/progress_listener.js";
import { Signal } from "#src/util/signal.js";
import { ProgressListenerWidget } from "#src/widget/progress_listener.js";
import { VirtualList } from "#src/widget/virtual_list.js";

export type {
  Completion,
  CompletionWithDescription,
} from "#src/util/completion.js";

const ACTIVE_COMPLETION_CLASS_NAME =
  "neuroglancer-multiline-autocomplete-completion-active";

const DEBUG_DROPDOWN = false;

export interface CompletionResult extends BasicCompletionResult {
  showSingleResult?: boolean;
  selectSingleResult?: boolean;
  makeElement?: (this: CompletionResult, completion: Completion) => HTMLElement;
}

export function makeDefaultCompletionElement(completion: Completion) {
  const element = document.createElement("div");
  element.textContent = completion.value;
  return element;
}

export interface SyntaxHighlighter {
  splitPattern: RegExp;
  getSeparatorNode: (text: string) => HTMLElement;
}

const DEFAULT_SYNTAX_HIGHLIGHTER: SyntaxHighlighter = {
  splitPattern: /.*/gs,
  getSeparatorNode: () => document.createElement("wbr"),
};

export function makeCompletionElementWithDescription(
  completion: CompletionWithDescription,
) {
  const element = document.createElement("div");
  element.className =
    "neuroglancer-multiline-autocomplete-completion-with-description";
  element.textContent = completion.value;
  const descriptionElement = document.createElement("div");
  descriptionElement.className =
    "neuroglancer-multiline-autocomplete-completion-description";
  descriptionElement.textContent = completion.description || "";
  element.appendChild(descriptionElement);
  return element;
}

const keyMap = EventActionMap.fromObject({
  arrowdown: { action: "cycle-next-active-completion" },
  arrowup: { action: "cycle-prev-active-completion" },
  home: { action: "home" },
  end: { action: "end" },
  tab: { action: "choose-active-completion-or-prefix", preventDefault: false },
  enter: { action: "commit" },
  escape: { action: "cancel", preventDefault: false, stopPropagation: false },
});

export interface CompletionRequest {
  value: string;
  selectionRange?: { begin: number; end: number } | undefined;
}
export type Completer = (
  request: CompletionRequest,
  signal: AbortSignal,
  progressListener: ProgressListener,
) => Promise<CompletionResult> | null;

const DEFAULT_COMPLETION_DELAY = 200; // milliseconds

export class AutocompleteTextInput extends RefCounted {
  element = document.createElement("div");
  inputElement = document.createElement("span");
  hintElement = document.createElement("span");
  private completionsVirtualList: VirtualList | undefined = undefined;
  onCommit = new Signal<(value: string, explicit: boolean) => void>();
  onInput = new Signal<(value: string) => void>();
  private prevInputValue: string | undefined = "";
  private completionsVisible = false;
  private activeCompletionPromise: Promise<CompletionResult> | null = null;
  private activeCompletionAbortController: AbortController | undefined =
    undefined;
  private activeCompletionProgressListener: ProgressListenerWidget | undefined =
    undefined;
  private completionErrorElement: HTMLElement | undefined;
  private hasFocus = false;
  private completionResult: CompletionResult | null = null;
  private dropdownContentsStale = true;
  private hasResultForDropdown = false;
  private commonPrefix = "";
  private completionDisabled = -1;

  disableCompletion() {
    const selectionRange = this.getSelectionRange();
    this.completionDisabled =
      selectionRange !== undefined &&
      selectionRange.end === selectionRange.begin
        ? selectionRange.end
        : -1;
  }

  get placeholder() {
    return this.inputElement.dataset.placeholder || "";
  }

  set placeholder(value: string) {
    this.inputElement.dataset.placeholder = value;
  }

  private getSelectionRange() {
    const s = window.getSelection();
    if (s === null) return undefined;
    if (s.rangeCount === 0) return undefined;
    const startRange = s.getRangeAt(0);
    const { inputElement } = this;
    const beforeRange = document.createRange();
    beforeRange.setStart(inputElement, 0);
    beforeRange.setEnd(startRange.startContainer, startRange.startOffset);
    const begin = beforeRange.toString().length;
    const length = s.toString().length;
    return { begin, end: begin + length };
  }

  setValueAndSelection(
    value: string,
    selection: { begin: number; end: number } | undefined = undefined,
  ) {
    const completionDisabled = this.completionDisabled !== -1;
    this.onInput.dispatch(value);
    const { inputElement, syntaxHighlighter } = this;
    removeChildren(inputElement);
    let outputOffset = 0;
    const r = selection !== undefined ? document.createRange() : undefined;
    let isFirst = true;
    for (const text of value.match(syntaxHighlighter.splitPattern)!) {
      if (!text) continue;
      if (!isFirst) {
        inputElement.appendChild(syntaxHighlighter.getSeparatorNode(text));
      }
      isFirst = false;
      const newOutputOffset = outputOffset + text.length;
      const node = document.createTextNode(text);
      inputElement.appendChild(node);
      if (r !== undefined) {
        const { begin, end } = selection!;
        if (begin >= outputOffset && begin <= newOutputOffset) {
          r.setStart(node, begin - outputOffset);
        }
        if (end >= outputOffset && end <= newOutputOffset) {
          r.setEnd(node, end - outputOffset);
        }
      }
      outputOffset = newOutputOffset;
    }
    if (r !== undefined) {
      if (isFirst) {
        r.setStart(inputElement, 0);
        r.setEnd(inputElement, 0);
      }
      const s = window.getSelection();
      if (s !== null) {
        s.removeAllRanges();
        s.addRange(r);
      }
    }
    this.completionDisabled =
      completionDisabled &&
      selection !== undefined &&
      selection.end === selection.begin
        ? selection.end
        : -1;
  }

  /**
   * Index of the active completion.  The active completion is displayed as the hint text and is
   * highlighted in the dropdown.
   */
  private activeIndex = -1;

  private dropdownStyleStale = true;

  private scheduleUpdateCompletions: () => void;
  completer: Completer;

  private resizeHandler = () => {
    this.updateDropdownStyle();
  };

  private resizeObserver = new ResizeObserver(this.resizeHandler);

  private syntaxHighlighter: SyntaxHighlighter;

  constructor(options: {
    completer: Completer;
    syntaxHighlighter?: SyntaxHighlighter;
    delay?: number;
  }) {
    super();
    this.completer = options.completer;
    const {
      delay = DEFAULT_COMPLETION_DELAY,
      syntaxHighlighter = DEFAULT_SYNTAX_HIGHLIGHTER,
    } = options;
    this.syntaxHighlighter = syntaxHighlighter;

    const debouncedCompleter = (this.scheduleUpdateCompletions = debounce(
      () => {
        const abortController = (this.activeCompletionAbortController =
          new AbortController());
        const progressListener = this.makeCompletionProgressListener();
        const activeCompletionPromise = (this.activeCompletionPromise =
          this.completer(
            {
              value: this.value,
              selectionRange: this.getSelectionRange(),
            },
            abortController.signal,
            progressListener,
          ));
        if (activeCompletionPromise !== null) {
          activeCompletionPromise.then(
            (completionResult) => {
              if (this.activeCompletionPromise === activeCompletionPromise) {
                this.setCompletions(completionResult);
                this.activeCompletionPromise = null;
                this.removeProgressListener();
              }
            },
            (reason) => {
              if (this.activeCompletionPromise === activeCompletionPromise) {
                this.removeProgressListener();
                this.showCompletionError(reason);
              }
            },
          );
        }
      },
      delay,
    ));
    this.registerDisposer(() => {
      debouncedCompleter.cancel();
    });

    const { element, inputElement, hintElement } = this;
    element.classList.add("neuroglancer-multiline-autocomplete");
    this.registerEventListener(window, "resize", this.resizeHandler);

    this.resizeObserver.observe(element);
    this.registerDisposer(() => this.resizeObserver.unobserve(inputElement));

    inputElement.contentEditable = "true";
    inputElement.spellcheck = false;
    element.appendChild(inputElement);
    element.appendChild(hintElement);
    element.appendChild(document.createTextNode("\u200b")); // Prevent input area from collapsing
    inputElement.classList.add("neuroglancer-multiline-autocomplete-input");
    hintElement.classList.add("neuroglancer-multiline-autocomplete-hint");
    inputElement.addEventListener("input", () => {
      this.completionDisabled = -1;
      this.setValueAndSelection(this.value, this.getSelectionRange());
      this.debouncedUpdateHintState();
    });
    inputElement.addEventListener("copy", (event) => {
      // Ensure selected text is copied as plain text.
      const { clipboardData } = event;
      if (clipboardData !== null) {
        const selection = window.getSelection();
        if (
          selection !== null &&
          !selection.isCollapsed &&
          selection.containsNode(
            inputElement,
            /*allowPartialContainment=*/ true,
          )
        ) {
          clipboardData.setData("text/plain", selection.toString());
        }
      }
      event.preventDefault();
      event.stopPropagation();
    });
    this.registerEventListener(document, "selectionchange", () => {
      const newSelection = this.getSelectionRange();
      const { completionDisabled } = this;
      if (
        newSelection !== undefined &&
        newSelection.begin === completionDisabled &&
        newSelection.end === completionDisabled
      ) {
        return;
      }
      this.completionDisabled = -1;
      this.debouncedUpdateHintState();
    });
    this.setValueAndSelection("");
    this.updateHintState();

    element.addEventListener("pointerdown", (event: PointerEvent) => {
      const { target } = event;
      if (target instanceof Node) {
        if (inputElement.contains(target)) return;
        const { completionsVirtualList } = this;
        if (completionsVirtualList?.element.contains(target)) {
          return;
        }
      }
      if (inputElement === document.activeElement) {
        this.moveCaretToEndOfInput();
        event.stopPropagation();
        event.preventDefault();
      }
    });

    element.addEventListener("click", () => {
      inputElement.focus();
    });

    this.registerEventListener(this.inputElement, "focus", () => {
      if (!this.hasFocus) {
        this.hasFocus = true;
        this.dropdownStyleStale = true;
        this.updateDropdown();
        const r = document.createRange();
        const { childNodes } = inputElement;
        r.setStart(inputElement, 0);
        if (childNodes.length === 0) {
          r.setEnd(inputElement, 0);
        } else {
          r.setEndAfter(childNodes[childNodes.length - 1]);
        }
        const s = window.getSelection();
        if (s !== null) {
          s.removeAllRanges();
          s.addRange(r);
        }
        this.debouncedUpdateHintState();
      }
    });

    // Debounce blur handling to avoid spuriously closing the completions.
    const debouncedBlur = this.registerCancellable(
      debounce(() => {
        if (document.activeElement === this.inputElement) {
          // Ignore spurious blur events, or blur events from the browser
          // tab/window itself losing focus.
          return;
        }
        if (this.hasFocus) {
          if (DEBUG_DROPDOWN) return;
          this.hasFocus = false;
          this.updateDropdown();
        }
        this.debouncedUpdateHintState();
        const s = window.getSelection();
        if (s !== null) {
          if (s.containsNode(this.inputElement, true)) {
            s.removeAllRanges();
          }
        }
        this.onCommit.dispatch(this.value, false);
      }),
    );

    this.registerEventListener(this.inputElement, "blur", debouncedBlur);
    this.registerEventListener(window, "resize", () => {
      this.dropdownStyleStale = true;
    });

    this.registerEventListener(window, "scroll", () => {
      this.dropdownStyleStale = true;
    });

    const keyboardHandler = this.registerDisposer(
      new KeyboardEventBinder(inputElement, keyMap),
    );
    keyboardHandler.allShortcutsAreGlobal = true;

    registerActionListener(inputElement, "cycle-next-active-completion", () => {
      this.cycleActiveCompletion(+1);
    });

    registerActionListener(inputElement, "cycle-prev-active-completion", () => {
      this.cycleActiveCompletion(-1);
    });

    registerActionListener(inputElement, "home", () => {
      this.moveCaretToBeginningOfInput();
    });

    registerActionListener(inputElement, "end", () => {
      this.moveCaretToEndOfInput();
    });

    registerActionListener(
      inputElement,
      "choose-active-completion-or-prefix",
      (event: CustomEvent) => {
        if (this.selectActiveCompletion(/*allowPrefix=*/ true)) {
          event.preventDefault();
        }
      },
    );
    registerActionListener(inputElement, "commit", (event: CustomEvent) => {
      if (this.selectActiveCompletion(/*allowPrefix=*/ false)) {
        event.stopPropagation();
      } else {
        const explicit = !this.completionsVisible;
        this.disableCompletion();
        this.hideCompletions();
        this.onCommit.dispatch(this.value, explicit);
      }
    });
    registerActionListener(inputElement, "cancel", (event: CustomEvent) => {
      event.stopPropagation();
      if (this.cancel()) {
        event.detail.preventDefault();
        event.detail.stopPropagation();
      }
    });
  }

  private removeProgressListener() {
    if (this.activeCompletionProgressListener !== undefined) {
      this.element.removeChild(this.activeCompletionProgressListener.element);
      this.activeCompletionProgressListener = undefined;
    }
  }

  private makeCompletionProgressListener(): ProgressListenerWidget {
    const widget = new ProgressListenerWidget();
    this.element.appendChild(widget.element);
    widget.element.classList.add(
      "neuroglancer-multiline-autocomplete-progress",
    );
    this.activeCompletionProgressListener = widget;
    this.updateDropdownStyle();
    return widget;
  }

  private showCompletionError(reason: unknown) {
    if (reason === null) return;
    const element = document.createElement("div");
    this.completionErrorElement = element;
    element.classList.add("neuroglancer-multiline-autocomplete-error");
    element.textContent = formatErrorMessage(reason);
    this.element.appendChild(element);
    this.updateDropdownStyle();
  }

  private shouldAttemptCompletion() {
    const { inputElement } = this;
    if (document.activeElement !== inputElement) return false;
    const selection = this.getSelectionRange();
    return (
      selection !== undefined &&
      selection.end === selection.begin &&
      selection.end !== this.completionDisabled &&
      selection.end === this.value.length
    );
  }

  hideCompletions() {
    this.cancelActiveCompletion();
    this.clearCompletions();
    this.hintElement.textContent = "";
  }

  private debouncedUpdateHintState = this.registerCancellable(
    debounce(() => this.updateHintState(), 0),
  );

  private updateHintState() {
    this.debouncedUpdateHintState.cancel();
    if (!this.shouldAttemptCompletion()) {
      this.hideCompletions();
      return;
    }
    const { value } = this;
    if (value === this.prevInputValue) {
      // Completion already in progress.
      return;
    }
    this.hideCompletions();
    this.prevInputValue = value;
    this.scheduleUpdateCompletions();
  }

  private handleDropdownClick(event: MouseEvent) {
    const { completionsVirtualList } = this;
    if (completionsVirtualList === undefined) return;
    const dropdownElement = completionsVirtualList.element;
    for (
      let target: EventTarget | null = event.target;
      target instanceof HTMLElement && target !== dropdownElement;
      target = target.parentElement
    ) {
      const completionIndex = target.dataset.completionIndex;
      if (completionIndex !== undefined) {
        this.selectCompletion(Number(completionIndex));
        break;
      }
    }
  }

  cycleActiveCompletion(delta: number) {
    if (this.completionResult === null) {
      return;
    }
    let { activeIndex } = this;
    const numCompletions = this.completionResult.completions.length;
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

  private shouldShowDropdown() {
    const { completionResult } = this;
    if (completionResult === null || !this.hasFocus) {
      return false;
    }
    return this.hasResultForDropdown;
  }

  private updateDropdownStyle() {
    const widget =
      this.completionsVirtualList?.element ??
      this.activeCompletionProgressListener?.element ??
      this.completionErrorElement;
    if (widget !== undefined) {
      positionDropdown(widget, this.element, {
        horizontal: false,
      });
    }
    this.dropdownStyleStale = false;
  }

  private updateDropdown() {
    let { completionsVirtualList } = this;
    if (this.shouldShowDropdown()) {
      if (this.dropdownContentsStale) {
        if (completionsVirtualList !== undefined) {
          completionsVirtualList.dispose();
        }
        const completionResult = this.completionResult!;
        const { makeElement = makeDefaultCompletionElement } = completionResult;
        completionsVirtualList = this.completionsVirtualList = new VirtualList({
          source: {
            length: completionResult.completions.length,
            render: (index: number) => {
              const completion = completionResult.completions[index];
              const completionElement = makeElement.call(
                completionResult,
                completion,
              );
              completionElement.classList.add(
                "neuroglancer-multiline-autocomplete-completion",
              );
              completionElement.dataset.completionIndex = `${index}`;
              if (this.activeIndex === index) {
                completionElement.classList.add(ACTIVE_COMPLETION_CLASS_NAME);
              }
              return completionElement;
            },
          },
          selectedIndex: this.activeIndex === -1 ? undefined : this.activeIndex,
        });
        completionsVirtualList.element.classList.add(
          "neuroglancer-multiline-autocomplete-dropdown",
        );

        completionsVirtualList.element.addEventListener(
          "mousedown",
          (event) => {
            this.inputElement.focus();
            event.preventDefault();
          },
        );
        completionsVirtualList.element.addEventListener(
          "mouseup",
          this.handleDropdownClick.bind(this),
        );

        this.element.appendChild(completionsVirtualList.element);
        this.dropdownContentsStale = false;
      }
      if (this.dropdownStyleStale) {
        this.updateDropdownStyle();
      }
      if (!this.completionsVisible) {
        this.completionsVisible = true;
      }
      const { activeIndex } = this;
      if (activeIndex !== -1) {
        this.completionsVirtualList!.scrollItemIntoView(activeIndex);
      }
    } else if (this.completionsVisible) {
      if (completionsVirtualList !== undefined) {
        completionsVirtualList.dispose();
        this.completionsVirtualList = undefined;
        this.dropdownContentsStale = true;
      }
      this.completionsVisible = false;
    }
  }

  private setCompletions(completionResult: CompletionResult) {
    this.clearCompletions();
    const { completions } = completionResult;
    if (completions.length === 0) {
      return;
    }
    const value = this.prevInputValue;
    if (value === undefined) return;
    this.completionResult = completionResult;

    if (completions.length === 1) {
      const completion = completions[0];
      if (completionResult.showSingleResult) {
        this.hasResultForDropdown = true;
      } else {
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
      const commonResultPrefix =
        completionResult.defaultCompletion ??
        longestCommonPrefix(
          (function* () {
            for (const completion of completionResult.completions) {
              yield completion.value;
            }
          })(),
        );
      const commonPrefix = this.getCompletedValue(commonResultPrefix);
      if (commonPrefix.startsWith(value)) {
        this.commonPrefix = commonPrefix;
        this.setHintValue(commonPrefix);
      }
    }
    this.updateDropdown();
  }

  setHintValue(hintValue: string) {
    const value = this.prevInputValue;
    if (value === undefined) return;
    if (hintValue === value || !hintValue.startsWith(value)) {
      // If the hint value is identical to the current value, there is no need to show it.  Also,
      // if it is not a prefix of the current value, then we cannot show it either.
      hintValue = "";
    }
    hintValue = hintValue.substring(value.length);
    const { hintElement, syntaxHighlighter } = this;
    removeChildren(hintElement);
    let isFirst = true;
    for (const text of hintValue.match(syntaxHighlighter.splitPattern)!) {
      if (!text) continue;
      if (!isFirst) {
        hintElement.appendChild(syntaxHighlighter.getSeparatorNode(text));
      }
      isFirst = false;
      const node = document.createTextNode(text);
      hintElement.appendChild(node);
    }
  }

  /**
   * This sets the active completion, which causes it to be highlighted and displayed as the hint.
   * Additionally, if the user hits tab then it is chosen.
   */
  private setActiveIndex(index: number) {
    if (!this.dropdownContentsStale) {
      const { activeIndex } = this;
      const { completionsVirtualList } = this;
      if (completionsVirtualList !== undefined) {
        if (activeIndex !== -1) {
          const prevElement =
            completionsVirtualList.getItemElement(activeIndex);
          if (prevElement !== undefined) {
            prevElement.classList.remove(ACTIVE_COMPLETION_CLASS_NAME);
          }
        }
        if (index !== -1) {
          const completionElement =
            completionsVirtualList.getItemElement(index);
          if (completionElement !== undefined) {
            completionElement.classList.add(ACTIVE_COMPLETION_CLASS_NAME);
          }
          completionsVirtualList.scrollItemIntoView(index);
        }
      }
    }
    if (index !== -1) {
      this.setHintValue(this.getCompletedValueByIndex(index));
    }
    this.activeIndex = index;
  }

  private getCompletedValueByIndex(index: number) {
    return this.getCompletedValue(
      this.completionResult!.completions[index].value,
    );
  }

  private getCompletedValue(completionValue: string) {
    const completionResult = this.completionResult!;
    const value = this.prevInputValue;
    if (value === undefined) return "";
    return value.substring(0, completionResult.offset) + completionValue;
  }

  private moveCaretToBeginningOfInput() {
    const r = document.createRange();
    const { inputElement } = this;
    r.setStart(inputElement, 0);
    r.setEnd(inputElement, 0);
    const s = window.getSelection();
    if (s !== null) {
      s.removeAllRanges();
      s.addRange(r);
      this.debouncedUpdateHintState();
    }
  }

  private moveCaretToEndOfInput() {
    const r = document.createRange();
    const { inputElement } = this;
    const { childNodes } = inputElement;
    const lastNode = childNodes[childNodes.length - 1];
    if (lastNode === undefined) {
      r.setStart(inputElement, 0);
      r.setEnd(inputElement, 0);
    } else {
      r.setStartAfter(lastNode);
      r.setEndAfter(lastNode);
    }
    const s = window.getSelection();
    if (s !== null) {
      s.removeAllRanges();
      s.addRange(r);
      this.debouncedUpdateHintState();
    }
  }

  selectActiveCompletion(allowPrefix: boolean) {
    let { activeIndex } = this;
    if (activeIndex === -1) {
      if (!allowPrefix) {
        return false;
      }
      const { completionResult } = this;
      if (
        completionResult !== null &&
        completionResult.completions.length === 1
      ) {
        activeIndex = 0;
      } else {
        const { commonPrefix } = this;
        if (commonPrefix.length > this.value.length) {
          this.value = commonPrefix;
          this.moveCaretToEndOfInput();
          return true;
        }
        return false;
      }
    }
    const newValue = this.getCompletedValueByIndex(activeIndex);
    if (this.value === newValue) {
      return false;
    }
    this.value = newValue;
    this.moveCaretToEndOfInput();
    return true;
  }

  selectCompletion(index: number) {
    this.value = this.getCompletedValueByIndex(index);
    this.moveCaretToEndOfInput();
  }

  /**
   * Called when user presses escape.  Does nothing here, but may be overridden in a subclass.
   */
  cancel() {
    return false;
  }

  private cancelActiveCompletion() {
    this.prevInputValue = undefined;
    this.activeCompletionAbortController?.abort();
    this.activeCompletionAbortController = undefined;
    this.activeCompletionPromise = null;
    this.removeProgressListener();
  }

  private clearCompletions() {
    this.dropdownContentsStale = true;
    this.dropdownStyleStale = true;
    if (this.completionResult !== null) {
      this.activeIndex = -1;
      this.completionResult = null;
      this.commonPrefix = "";
      const { completionsVirtualList } = this;
      if (completionsVirtualList !== undefined) {
        completionsVirtualList.dispose();
        this.completionsVirtualList = undefined;
      }
      this.updateDropdown();
    }

    const { completionErrorElement } = this;
    if (completionErrorElement !== undefined) {
      this.element.removeChild(completionErrorElement);
      this.completionErrorElement = undefined;
    }
  }

  get value() {
    return this.inputElement.textContent || "";
  }

  set value(value: string) {
    if (value !== this.value) {
      this.completionDisabled = -1;
      this.setValueAndSelection(value);
      this.debouncedUpdateHintState();
    }
  }

  disposed() {
    const { completionsVirtualList } = this;
    if (completionsVirtualList !== undefined) {
      completionsVirtualList.dispose();
    }
    removeFromParent(this.element);
    this.cancelActiveCompletion();
    super.disposed();
  }
}
