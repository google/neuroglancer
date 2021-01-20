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
import {Position} from 'neuroglancer/navigation_state';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {arraysEqual} from 'neuroglancer/util/array';
import {TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {ParameterizedEmitterDependentShaderOptions, ParameterizedShaderGetterResult} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {ColorWidget} from 'neuroglancer/widget/color';
import {InvlerpWidget} from 'neuroglancer/widget/invlerp';
import {PositionWidget} from 'neuroglancer/widget/position_widget';
import {RangeWidget} from 'neuroglancer/widget/range';
import {Tab} from 'neuroglancer/widget/tab_view';

export interface LegendShaderOptions extends ParameterizedEmitterDependentShaderOptions {
  initializeShader: (shaderResult: ParameterizedShaderGetterResult) => void;
}

export interface ShaderControlsOptions {
  legendShaderOptions?: LegendShaderOptions;
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
    let histogramIndex = 0;
    for (const [name, controlState] of this.state.state) {
      const {control} = controlState;
      const labelDiv = document.createElement('div');
      const label = document.createElement('label');
      label.textContent = name;
      labelDiv.appendChild(label);
      element.appendChild(labelDiv);
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
        case 'checkbox': {
          const widget = controlDisposer.registerDisposer(
              new TrackableBooleanCheckbox(controlState.trackable as TrackableBoolean));
          element.appendChild(widget.element);
          break;
        }
        case 'invlerp': {
          const {channelCoordinateSpaceCombiner} = this.state;
          if (channelCoordinateSpaceCombiner !== undefined &&
              control.default.channel.length !== 0) {
            const position = controlDisposer.registerDisposer(
                new Position(channelCoordinateSpaceCombiner.combined));
            const positionWidget = controlDisposer.registerDisposer(
              new PositionWidget(position, channelCoordinateSpaceCombiner, {copyButton: false}));
            const {trackable} = controlState;
            controlDisposer.registerDisposer(position.changed.add(() => {
              const value = position.value;
              const newChannel = Array.from(value, x => Math.floor(x));
              const oldParams = trackable.value;
              if (!arraysEqual(oldParams.channel, newChannel)) {
                trackable.value = {...trackable.value, channel: newChannel};
              }
            }));
            const updatePosition = () => {
              const value = position.value;
              const params = trackable.value;
              if (!arraysEqual(value, params.channel)) {
                value.set(params.channel);
                position.changed.dispatch();
              }
            };
            updatePosition();
            controlDisposer.registerDisposer(trackable.changed.add(updatePosition));
            labelDiv.appendChild(positionWidget.element);
          }
          const widget = controlDisposer.registerDisposer(new InvlerpWidget(
              this.visibility, this.display, control, controlState.trackable,
              this.state.histogramSpecifications, histogramIndex, this.options));
          element.appendChild(widget.element);
          ++histogramIndex;
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
