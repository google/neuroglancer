/**
 * @license
 * Copyright 2018 Google Inc.
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
 * @file Tab for updating a coordinate transform.
 */

import './coordinate_transform.css';

import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {float32ToString} from 'neuroglancer/util/float32_to_string';
import {Tab} from 'neuroglancer/widget/tab_view';

export class CoordinateTransformTab extends Tab {
  private textArea = document.createElement('textarea');
  private modelGeneration = -1;
  constructor(public transform: CoordinateTransform) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-coordinate-transform-widget');
    const {textArea} = this;
    const textAreaLabel = document.createElement('label');
    textAreaLabel.className = 'neuroglancer-coordinate-transform-widget-homogeneous';
    textAreaLabel.textContent = '3×4 Homogeneous transformation matrix';
    textAreaLabel.appendChild(textArea);
    element.appendChild(textAreaLabel);
    this.registerDisposer(transform.changed.add(() => this.updateView()));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    textArea.addEventListener('change', () => this.updateModel());
    textArea.addEventListener('blur', () => this.updateModel());
    textArea.title = 'Homogeneous transformation matrix';
    textArea.rows = 3;
    const resetButton = document.createElement('button');
    resetButton.textContent = 'Reset to identity';
    resetButton.addEventListener('click', () => this.transform.reset());
    element.appendChild(resetButton);
    this.updateView();
  }

  private updateView() {
    if (!this.visible) {
      return;
    }
    const generation = this.transform.changed.count;
    if (this.modelGeneration !== generation) {
      let value = '';
      const {transform} = this.transform;
      for (let i = 0; i < 3; ++i) {
        if (i !== 0) {
          value += '\n';
        }
        for (let j = 0; j < 4; ++j) {
          const x = transform[j * 4 + i];
          if (j !== 0) {
            value += ' ';
          }
          value += float32ToString(x);
        }
      }
      this.textArea.value = value;
      this.modelGeneration = generation;
    }
  }

  private updateModel() {
    const parts = this.textArea.value.split(/[\s,\[\]\(\)\{\}]/).filter(x => x.length > 0);
    if (parts.length === 12) {
      const numbers: number[] = [];
      for (let i = 0; i < 12; ++i) {
        const n = parseFloat(parts[i]);
        if (Number.isNaN(n)) {
          return false;
        }
        numbers[i] = n;
      }
      const {transform} = this.transform;
      transform[3] = transform[7] = transform[10] = 0;
      transform[15] = 1;
      for (let i = 0; i < 4; ++i) {
        for (let j = 0; j < 3; ++j) {
          transform[i * 4 + j] = numbers[i + j * 4];
        }
      }
      this.transform.changed.dispatch();
      return true;
    }
    return false;
  }
}
