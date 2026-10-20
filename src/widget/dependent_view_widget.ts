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
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";

export class DependentViewContext extends RefCounted {
  constructor(public redraw: () => void) {
    super();
  }
}

export interface DependentViewWidgetOptions {
  // A rebuild would remove the element being edited or pressed, losing its value, caret, undo history or click.
  readonly deferRebuildWhileInteracting?: boolean;
}

export class DependentViewWidget<T> extends RefCounted {
  element = document.createElement("div");

  private generation = -1;
  private pointerPressed = false;
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
    private readonly options: DependentViewWidgetOptions = {},
  ) {
    super();
    this.element.style.display = "contents";
    if (options.deferRebuildWhileInteracting) {
      const releasePointer = () => {
        if (!this.pointerPressed) return;
        this.pointerPressed = false;
        this.debouncedUpdateView();
      };
      this.registerEventListener(
        this.element,
        "pointerdown",
        () => {
          this.pointerPressed = true;
        },
        { capture: true },
      );
      this.registerEventListener(window, "pointerup", releasePointer, {
        capture: true,
      });
      this.registerEventListener(window, "pointercancel", releasePointer, {
        capture: true,
      });
      this.registerEventListener(this.element, "focusout", () =>
        this.debouncedUpdateView(),
      );
    }
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

  private updateView() {
    if (!this.visible) return;
    const { model } = this;
    const generation = model.changed.count;
    if (generation === this.generation) return;
    if (this.options.deferRebuildWhileInteracting && this.isInteracting()) {
      return;
    }
    this.disposeCurrentView();
    const currentViewDisposer = (this.currentViewDisposer =
      new DependentViewContext(this.debouncedForceUpdateView));
    this.render(model.value, this.element, currentViewDisposer);
    this.generation = generation;
  }

  private isInteracting() {
    if (this.pointerPressed) return true;
    const { activeElement } = document;
    return (
      activeElement instanceof HTMLElement &&
      this.element.contains(activeElement) &&
      (activeElement.isContentEditable ||
        activeElement.matches("input, select, textarea"))
    );
  }

  private disposeCurrentView() {
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
