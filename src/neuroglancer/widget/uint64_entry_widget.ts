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

import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {Signal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';

import 'neuroglancer/noselect.css';
import './uint64_entry_widget.css';

export class Uint64EntryWidget extends RefCounted {
  element = document.createElement('form');
  label = document.createElement('label');
  input = document.createElement('input');
  valuesEntered = new Signal<(values: Uint64[]) => void>();

  constructor() {
    super();
    let {element, label, input} = this;
    element.className = 'uint64-entry neuroglancer-noselect';
    element.appendChild(label);
    label.appendChild(input);
    this.registerEventListener(element, 'submit', (event: Event) => {
      event.preventDefault();
      const values = this.validateInput();
      if (values !== undefined) {
        this.input.value = '';
        this.input.classList.remove('valid-input', 'invalid-input');
        this.valuesEntered.dispatch(values);
      }
    });
    this.registerEventListener(element, 'input', () => {
      if (this.input.value === '') {
        this.input.classList.remove('valid-input', 'invalid-input');
        return;
      }
      if (this.validateInput()) {
        this.input.classList.remove('invalid-input');
      } else {
        this.input.classList.add('invalid-input');
      }
    });
  }

  validateInput(): Uint64[]|undefined {
    let value = this.input.value;
    value = value.replace(/[\s,\(\)\[\]\{\};]+/g, ' ');
    value = value.trim();
    const parts = value.split(' ');
    if (parts.length === 0) {
      return undefined;
    }
    const results: Uint64[] = [];
    for (const part of parts) {
      const x = new Uint64();
      if (!x.tryParseString(part)) {
        return undefined;
      }
      results.push(x);
    }
    return results;
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
