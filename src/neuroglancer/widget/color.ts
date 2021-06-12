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

import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {parseRGBColorSpecification, serializeColor} from 'neuroglancer/util/color';
import {hsvToRgb, rgbToHsv} from 'neuroglancer/util/colorspace';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';

export class ColorWidget<Color extends vec3|undefined = vec3> extends RefCounted {
  element = document.createElement('input');

  constructor(
      public model: WatchableValueInterface<Color>,
      public getDefaultColor: (() => vec3) = () => vec3.fromValues(1, 0, 0)) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-color-widget');
    element.type = 'color';
    element.addEventListener('change', () => this.updateModel());
    element.addEventListener('input', () => this.updateModel());
    element.addEventListener('wheel', event => {
      event.stopPropagation();
      event.preventDefault();
      this.adjustHueViaWheel(event);
    });
    this.registerDisposer(model.changed.add(() => this.updateView()));
    this.updateView();
  }
  private getRGB() {
    return this.model.value ?? this.getDefaultColor();
  }
  private updateView() {
    this.element.value = serializeColor(this.getRGB());
  }
  private updateModel() {
    this.model.value = parseRGBColorSpecification(this.element.value) as Color;
  }

  adjustHueViaWheel(event: WheelEvent) {
    const rgb = this.getRGB();
    const temp = vec3.create();
    rgbToHsv(temp, rgb[0], rgb[1], rgb[2]);
    const {deltaY} = event;
    let hue = Math.round(temp[0] * 256);
    hue += (deltaY > 0 ? 1 : deltaY < 0 ? -1 : 0);
    hue = (hue + 256) % 256;
    temp[0] = hue / 256;
    hsvToRgb(temp, temp[0], temp[1], temp[2]);
    this.model.value = temp as Color;
  }
}
