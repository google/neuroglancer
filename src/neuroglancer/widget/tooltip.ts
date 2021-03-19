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

/**
 * @file Facilities for creating tooltips.
 */

import './tooltip.css';

import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

export class Tooltip extends RefCounted {
  element = document.createElement('div');
  constructor() {
    super();
    const {element} = this;
    element.className = 'neuroglancer-tooltip';
    element.style.visibility = 'hidden';
    document.body.appendChild(element);
  }

  updatePosition(pageX: number, pageY: number) {
    const {element} = this;
    element.style.left = pageX + 'px';
    element.style.top = pageY + 'px';
    element.style.visibility = 'inherit';
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
