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

import './shader_controls.css';

import debounce from 'lodash/debounce';
import {DisplayContext} from 'neuroglancer/display_context';
import {TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {ColorWidget} from 'neuroglancer/widget/color';
import {RangeWidget} from 'neuroglancer/widget/range';
import {Tab} from 'neuroglancer/widget/tab_view';

export interface ShaderControlsOptions {
  visibility?: WatchableVisibilityPriority;
}

export class ShaderControls extends Tab {
  private controlDisposer: RefCounted|undefined = undefined;

  constructor(
      public state: ShaderControlState, public display: DisplayContext,
      public options: ShaderControlsOptions = {}) {
    super(options.visibility);
    const {element} = this;
    element.classList.add('neuroglancer-shader-controls');
    const {controls} = state;
    this.registerDisposer(
        controls.changed.add(this.registerCancellable(debounce(() => this.updateControls(), 0))));
    this.updateControls();
  }

  updateControls() {
    const {element} = this;
    if (this.controlDisposer !== undefined) {
      this.controlDisposer.dispose();
      removeChildren(element);
    }
    const controlDisposer = this.controlDisposer = new RefCounted();
    for (const [name, controlState] of this.state.state) {
      const {control} = controlState;
      const label = document.createElement('label');
      label.textContent = name;
      element.appendChild(label);
      switch (control.type) {
        case 'slider': {
          const widget = controlDisposer.registerDisposer(new RangeWidget(
              controlState.trackable, {min: control.min, max: control.max, step: control.step}));
          element.appendChild(widget.element);
          break;
        }
        case 'color': {
          const widget = controlDisposer.registerDisposer(
              new ColorWidget(controlState.trackable as TrackableRGB));
          element.appendChild(widget.element);
          break;
        }
      }
    }
  }

  disposed() {
    this.controlDisposer?.dispose();
    super.disposed();
  }
}
