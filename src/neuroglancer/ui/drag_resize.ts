
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

import 'neuroglancer/ui/drag_resize.css';

import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';

export class DragResizablePanel extends RefCounted {
  gutter = document.createElement('div');

  private sizeProp: 'width'|'height' = this.direction === 'horizontal' ? 'width' : 'height';

  constructor(
      public element: HTMLElement, public visible: WatchableValueInterface<boolean>,
      public size: WatchableValueInterface<number>, public direction: 'horizontal'|'vertical',
      public minSize = 0) {
    super();
    const {gutter} = this;
    gutter.className = `neuroglancer-resize-gutter-${direction}`;
    element.insertAdjacentElement('beforebegin', gutter);
    this.registerDisposer(visible.changed.add(() => this.updateView()));
    this.registerDisposer(size.changed.add(() => this.updateView()));
    const dragStart = (event: MouseEvent) => {
      if ('button' in event && event.button !== 0) {
        return;
      }
      event.preventDefault();
      // Get initial size
      const initialRect = element.getBoundingClientRect();
      let size = initialRect[this.sizeProp];
      const visibleCutoff = this.minSize / 2;
      startRelativeMouseDrag(event, (_event, deltaX: number, deltaY: number) => {
        size -= (direction === 'horizontal' ? deltaX : deltaY);
        if (size < visibleCutoff) {
          this.visible.value = false;
        } else if (this.visible.value === false && size > visibleCutoff) {
          this.visible.value = true;
        }
        this.size.value = Math.max(this.minSize, size);
      });
    };
    this.registerEventListener(gutter, 'pointerdown', dragStart);
    this.updateView();
  }

  private updateView() {
    const {element, gutter} = this;
    const {visible} = this;
    if (!visible.value) {
      element.style.display = 'none';
      gutter.style.display = 'none';
      return;
    }
    element.style.display = '';
    gutter.style.display = '';
    element.style[this.sizeProp] = Math.max(this.minSize, this.size.value) + 'px';
  }

  disposed() {
    removeFromParent(this.gutter);
    super.disposed();
  }
}
