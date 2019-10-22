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

import {RefCounted, registerEventListener} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {NullarySignal} from 'neuroglancer/util/signal';

import './context_menu.css';

export function positionContextMenu(menu: HTMLElement, event: MouseEvent) {
  const {offsetWidth, offsetHeight} = menu;
  const viewportWidth = document.documentElement!.clientWidth;
  const viewportHeight = document.documentElement!.clientHeight;
  const posX =
      document.documentElement!.scrollLeft + Math.min(viewportWidth - offsetWidth, event.clientX);
  const posY =
      document.documentElement!.scrollTop + Math.min(viewportHeight - offsetHeight, event.clientY);
  menu.style.left = posX + 'px';
  menu.style.top = posY + 'px';
  menu.style.visibility = null;
}

export class ContextMenu extends RefCounted {
  element = document.createElement('div');
  private menuDisposer: (() => void)|undefined;
  private parentDisposers = new Map<HTMLElement, () => void>();
  private disabledValue = false;
  opened = new NullarySignal();
  closed = new NullarySignal();
  get disabled () {
    return this.disabledValue;
  }
  set disabled(value: boolean) {
    if (this.disabledValue !== value) {
      this.disabledValue = value;
      if (value) {
        this.hide();
      }
    }
  }
  constructor(parent?: HTMLElement) {
    super();
    const {element} = this;
    element.className = 'neuroglancer-context-menu';
    element.style.visibility = 'hidden';
    element.tabIndex = -1;
    document.body.appendChild(element);

    if (parent !== undefined) {
      this.registerParent(parent);
    }
  }


  get open () {
    return this.menuDisposer !== undefined;
  }

  registerParent(parent: HTMLElement) {
    const {parentDisposers} = this;
    if (parentDisposers.has(parent)) {
      return;
    }
    parentDisposers.set(
        parent, registerEventListener(parent, 'contextmenu', (event: MouseEvent) => {
          this.show(event);
          event.stopPropagation();
          event.preventDefault();
        }));
  }

  show(originalEvent: MouseEvent) {
    if (this.disabledValue) {
      return;
    }
    this.hide();
    const {element} = this;
    const mousedownDisposer = registerEventListener(document, 'mousedown', (event: MouseEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) {
        this.hide();
      }
    }, /*capture=*/true);
    const keydownDisposer = registerEventListener(document, 'keydown', (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        this.hide();
      }
    }, /*capture=*/true);
    const menuDisposer = () => {
      keydownDisposer();
      mousedownDisposer();
      element.style.display = 'none';
    };
    element.style.display = null;
    element.style.visibility = 'hidden';
    this.opened.dispatch();
    positionContextMenu(element, originalEvent);
    this.menuDisposer = menuDisposer;
  }

  unregisterParent(parent: HTMLElement) {
    const {parentDisposers} = this;
    const disposer = parentDisposers.get(parent);
    if (disposer !== undefined) {
      disposer();
      parentDisposers.delete(parent);
    }
  }

  disposed() {
    const {parentDisposers} = this;
    for (const disposer of parentDisposers.values()) {
      disposer();
    }
    parentDisposers.clear();
    removeFromParent(this.element);
  }

  hide() {
    if (this.menuDisposer !== undefined) {
      this.menuDisposer();
      this.menuDisposer = undefined;
      this.closed.dispatch();
    }
  }
}
