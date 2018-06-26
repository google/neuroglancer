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

import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {UserLayer} from 'neuroglancer/layer';
import {CoordinateTransformTab} from 'neuroglancer/widget/coordinate_transform';

const TRANSFORM_JSON_KEY = 'transform';

export interface UserLayerWithCoordinateTransform extends UserLayer {
  transform: CoordinateTransform;
}

/**
 * Mixin that adds a `transform` property to a user layer.
 */
export function UserLayerWithCoordinateTransformMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  class C extends Base implements UserLayerWithCoordinateTransform {
    transform = new CoordinateTransform();

    constructor(...args: any[]) {
      super(...args);
      this.transform.changed.add(this.specificationChanged.dispatch);
      this.tabs.add('transform', {
        label: 'Transform',
        order: 100,
        getter: () => new CoordinateTransformTab(this.transform)
      });
      const specification = args[1];
      this.transform.restoreState(specification[TRANSFORM_JSON_KEY]);
    }

    toJSON(): any {
      const x = super.toJSON();
      x[TRANSFORM_JSON_KEY] = this.transform.toJSON();
      return x;
    }
  }
  return C;
}
