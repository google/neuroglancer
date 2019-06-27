/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import './minimizable_group.css';

import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

export class MinimizableGroupWidget extends RefCounted {
  element = document.createElement('div');
  private label = document.createElement('div');
  private content = document.createElement('div');
  constructor(title: string) {
    super();
    const {label, content, element} = this;

    label.textContent = title;
    label.className = 'neuroglancer-minimizable-group-title';
    label.addEventListener('click', () => {
      content.classList.toggle('minimized');
      label.classList.toggle('minimized');
    });

    content.className = 'neuroglancer-minimizable-group-content';
    element.className = 'neuroglancer-minimizable-group';
    element.appendChild(label);
    element.appendChild(content);
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }

  appendFixedChild(el: HTMLElement) {
    const container = document.createElement('div');
    container.className = 'neuroglancer-minimizable-group-fixed';
    container.appendChild(el);
    this.content.appendChild(container);
  }

  appendFlexibleChild(el: HTMLElement) {
    const container = document.createElement('div');
    container.className = 'neuroglancer-minimizable-group-flexible';
    container.appendChild(el);
    this.content.appendChild(container);
  }
}
