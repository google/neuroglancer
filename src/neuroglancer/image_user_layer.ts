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

import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import {ImageRenderLayer} from 'neuroglancer/sliceview/image_renderlayer';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';

export class ImageUserLayer extends UserLayer {
  volumePath: string;
  constructor (manager: LayerListSpecification, x: any) {
    let volumePath = x['source'];
    if (typeof volumePath !== 'string') {
      throw new Error('Invalid image layer specification');
    }
    super([]);
    this.volumePath = volumePath;
    this.addRenderLayer(
        new ImageRenderLayer(manager.chunkManager, getVolumeWithStatusMessage(volumePath)));
  }
  toJSON () {
    let x: any = {'type': 'image'};
    x['source'] = this.volumePath;
    return x;
  }
  makeDropdown(element: HTMLDivElement): null {
    return null;
  }
};

