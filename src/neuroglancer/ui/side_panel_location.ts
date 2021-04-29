/**
 * @license
 * Copyright 2021 Google Inc.
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

import {verifyBoolean, verifyFiniteFloat, verifyObject, verifyOptionalObjectProperty, verifyPositiveInt} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import { WatchableValueInterface } from '../trackable_value';

export type Side = 'left'|'right'|'top'|'bottom';

export const DEFAULT_SIDE_PANEL_WIDTH = 300;
export const DEFAULT_MIN_SIDE_PANEL_WIDTH = 100;

export interface SidePanelLocation {
  // Side on which the panel is located.
  side: Side;

  // Horizontal position as ordinal.
  col: number;

  // Vertical position as ordinal.
  row: number;

  // Fraction of full size along flex direction.
  flex: number;

  // Cross-direction size in pixels.
  size: number;

  // Minimum width in pixels.
  minSize: number;

  // Whether the panel is visible.
  visible: boolean;
}

export const DEFAULT_SIDE_PANEL_LOCATION: SidePanelLocation = {
  side: 'right',
  col: 0,
  row: Infinity,
  flex: 1,
  size: DEFAULT_SIDE_PANEL_WIDTH,
  minSize: DEFAULT_MIN_SIDE_PANEL_WIDTH,
  visible: false,
};

export class TrackableSidePanelLocation implements Trackable {
  // Indicates that the JSON representation changed.  Note that some changes are just due to
  // normalization and don't affect the actual layout.
  changed = new Signal();

  // Indicates that the layout actually changed.
  locationChanged = new Signal();

  readonly watchableVisible: WatchableValueInterface<boolean>;

  constructor(
      public defaultValue: SidePanelLocation = DEFAULT_SIDE_PANEL_LOCATION,
      public value = defaultValue) {
    this.locationChanged.add(this.changed.dispatch);
    const self = this;
    this.watchableVisible = {
      get value() { return self.visible; },
      set value(value: boolean) { self.visible = value; },
      changed: self.locationChanged,
    };
  }

  toJSON(defaultValue = this.defaultValue) {
    const obj: any = {};
    const {value} = this;
    for (const key in value) {
      if (value[key as keyof SidePanelLocation] === defaultValue[key as keyof SidePanelLocation]) {
        continue;
      }
      obj[key] = value[key as keyof SidePanelLocation];
    }
    return obj;
  }

  get visible() {
    return this.value.visible;
  }

  set visible(visible: boolean) {
    const {value} = this;
    if (value.visible !== visible) {
      this.value = {...value, visible};
      this.locationChanged.dispatch();
    }
  }

  reset() {
    if (this.value !== this.defaultValue) {
      this.value = this.defaultValue;
      this.locationChanged.dispatch();
    }
  }

  restoreState(obj: unknown, defaultLocation = this.defaultValue) {
    if (obj === undefined) return;
    verifyObject(obj);
    const location: SidePanelLocation = {
      side: verifyOptionalObjectProperty(
          obj, 'side',
          x => {
            if (x !== 'left' && x !== 'right' && x !== 'top' && x !== 'bottom') {
              throw new Error(`Expected "left", "right", "top", or "bottom", but received: ${
                  JSON.stringify(x)}`);
            }
            return x;
          },
          defaultLocation.side),
      col: verifyOptionalObjectProperty(obj, 'col', verifyFiniteFloat, defaultLocation.col),
      row: verifyOptionalObjectProperty(obj, 'row', verifyFiniteFloat, defaultLocation.row),
      flex: verifyOptionalObjectProperty(obj, 'flex', verifyFiniteFloat, defaultLocation.flex),
      size: verifyOptionalObjectProperty(obj, 'size', verifyPositiveInt, defaultLocation.size),
      visible: verifyOptionalObjectProperty(obj, 'visible', verifyBoolean, defaultLocation.visible),
      // minSize cannot be modified.
      minSize: defaultLocation.minSize,
    };
    this.value = location;
    this.locationChanged.dispatch();
  }
}
