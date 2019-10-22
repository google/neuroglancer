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

import debounce from 'lodash/debounce';
import {TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {ColorWidget} from 'neuroglancer/widget/color';
import {RangeWidget} from 'neuroglancer/widget/range';


export class ShaderControls extends RefCounted {
  element = document.createElement('div');
  private controlDisposer: RefCounted|undefined = undefined;

  constructor(public state: ShaderControlState) {
    super();
    const {controls} = state;
    this.registerDisposer(
        controls.changed.add(this.registerCancellable(debounce(() => this.updateControls(), 0))));
    this.updateControls();
  }

  updateControls() {
    if (this.controlDisposer !== undefined) {
      this.controlDisposer.dispose();
      removeChildren(this.element);
    }
    const controlDisposer = this.controlDisposer = new RefCounted();
    for (const [name, controlState] of this.state.state) {
      const {control} = controlState;
      switch (control.type) {
        case 'slider': {
          const widget = controlDisposer.registerDisposer(new RangeWidget(
              controlState.trackable, {min: control.min, max: control.max, step: control.step}));
          widget.promptElement.textContent = name;
          this.element.appendChild(widget.element);
          break;
        }
        case 'color': {
          const label = document.createElement('label');
          label.textContent = name;
          const widget = controlDisposer.registerDisposer(
              new ColorWidget(controlState.trackable as TrackableRGB));
          this.element.appendChild(label);
          label.appendChild(widget.element);
          break;
        }
      }
    }
  }

  disposed() {
    const {controlDisposer} = this;
    if (controlDisposer !== undefined) {
      controlDisposer.dispose();
    }
    super.disposed();
  }
}
