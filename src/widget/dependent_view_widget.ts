/**
 * @license
 * Copyright 2019 Google Inc.
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

import type { WatchableValueInterface } from "#src/trackable_value.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted, registerEventListener } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";

const focusedEditorGuards = new WeakMap<Element, () => boolean>();
const pointerPressGuards = new WeakMap<Element, () => boolean>();

export class DependentViewContext extends RefCounted {
  constructor(public redraw: () => void) {
    super();
  }

  /** Keep this editor and its ancestor views intact until blur or invalidation. */
  deferUpdatesWhileFocused(element: HTMLElement, isCurrent: () => boolean) {
    focusedEditorGuards.set(element, isCurrent);
    this.registerDisposer(() => focusedEditorGuards.delete(element));
  }

  /** Keep controls in this container and their ancestor views intact during a press. */
  deferUpdatesWhilePointerPressed(
    element: HTMLElement,
    isCurrent: () => boolean,
  ) {
    pointerPressGuards.set(element, isCurrent);
    this.registerDisposer(() => pointerPressGuards.delete(element));
  }
}

export class DependentViewWidget<T> extends RefCounted {
  element = document.createElement("div");

  private generation = -1;
  private cancelDeferredUpdate: (() => void) | undefined;
  private pointerPress:
    | { isCurrent: () => boolean; lifetime: RefCounted }
    | undefined;
  private currentViewDisposer: RefCounted | undefined = undefined;
  private debouncedUpdateView = this.registerCancellable(
    animationFrameDebounce(() => this.updateView()),
  );
  private debouncedForceUpdateView = () => {
    this.generation = -1;
    this.debouncedUpdateView();
  };

  constructor(
    public model: WatchableValueInterface<T>,
    public render: (
      value: T,
      parent: HTMLElement,
      context: DependentViewContext,
    ) => void,
    public visibility = new WatchableVisibilityPriority(
      WatchableVisibilityPriority.VISIBLE,
    ),
  ) {
    super();
    this.element.style.display = "contents";
    this.registerEventListener(
      this.element,
      "pointerdown",
      (event: PointerEvent) => this.preservePointerPress(event),
      { capture: true },
    );
    this.registerDisposer(model.changed.add(this.debouncedUpdateView));
    this.registerDisposer(
      visibility.changed.add(() => {
        if (this.visible) this.debouncedUpdateView();
      }),
    );
    this.updateView();
  }

  get visible() {
    return this.visibility.visible;
  }

  private preservePointerPress(event: PointerEvent) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const document = this.element.ownerDocument;
    const focused = document.activeElement;
    let isCurrent =
      focused !== null && this.element.contains(focused)
        ? focusedEditorGuards.get(focused)
        : undefined;
    for (
      let target = event.target instanceof Element ? event.target : null;
      isCurrent === undefined && target !== null;
      target = target.parentElement
    ) {
      isCurrent = pointerPressGuards.get(target);
      if (target === this.element) break;
    }
    if (isCurrent === undefined || !isCurrent()) return;

    // Keep the clicked control alive through pointerup and click, whether blur
    // submits an edit or an earlier edit's acknowledgement dirties the view.
    // Ancestor views must preserve the same interaction.
    this.clearPointerPress();
    const lifetime = new RefCounted();
    this.pointerPress = { isCurrent, lifetime };
    const finish = () => {
      this.clearPointerPress();
      // The click following pointerup runs before this animation-frame update.
      this.debouncedUpdateView();
    };
    const finishPointer = (end: PointerEvent) => {
      if (end.pointerId === event.pointerId) finish();
    };
    lifetime.registerEventListener(document, "pointerup", finishPointer, {
      capture: true,
    });
    lifetime.registerEventListener(document, "pointercancel", finishPointer, {
      capture: true,
    });
    if (document.defaultView !== null) {
      lifetime.registerEventListener(document.defaultView, "blur", finish);
    }
  }

  private clearPointerPress() {
    this.pointerPress?.lifetime.dispose();
    this.pointerPress = undefined;
  }

  private updateView() {
    if (!this.visible) return;
    const { model } = this;
    const generation = model.changed.count;
    if (generation === this.generation) return;
    this.cancelDeferredUpdate?.();
    this.cancelDeferredUpdate = undefined;
    if (this.pointerPress?.isCurrent()) return;
    this.clearPointerPress();
    const focused = document.activeElement;
    if (
      focused !== null &&
      this.element.contains(focused) &&
      focusedEditorGuards.get(focused)?.()
    ) {
      // Rebuilding even an ancestor loses native text Undo and cancels any
      // context-owned pending save. Retry with the latest model after blur.
      this.cancelDeferredUpdate = registerEventListener(
        focused,
        "blur",
        this.debouncedUpdateView,
        { once: true },
      );
      return;
    }
    this.disposeCurrentView();
    const currentViewDisposer = (this.currentViewDisposer =
      new DependentViewContext(this.debouncedForceUpdateView));
    this.render(model.value, this.element, currentViewDisposer);
    this.generation = generation;
  }

  private disposeCurrentView() {
    this.clearPointerPress();
    this.cancelDeferredUpdate?.();
    this.cancelDeferredUpdate = undefined;
    const { currentViewDisposer } = this;
    if (currentViewDisposer !== undefined) {
      currentViewDisposer.dispose();
    }
    removeChildren(this.element);
  }

  disposed() {
    this.disposeCurrentView();
    super.disposed();
  }
}
