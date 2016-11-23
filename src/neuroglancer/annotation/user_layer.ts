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

import {AnnotationPointList, AnnotationPointListLayer, PerspectiveViewAnnotationPointListLayer, SliceViewAnnotationPointListLayer} from 'neuroglancer/annotation/frontend';
import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType} from 'neuroglancer/layer_specification';
import {vec3} from 'neuroglancer/util/geom';

const LAYER_TYPE = 'pointAnnotation';

export class AnnotationPointListUserLayer extends UserLayer {
  layer = new AnnotationPointListLayer(
      this.manager.chunkManager, new AnnotationPointList(), this.manager.voxelSize);
  constructor(public manager: LayerListSpecification, x: any) {
    super([]);
    this.layer.pointList.restoreState(x['points']);
    this.registerSignalBinding(
        this.layer.pointList.changed.add(() => { this.specificationChanged.dispatch(); }));
    this.addRenderLayer(new PerspectiveViewAnnotationPointListLayer(this.layer));
    this.addRenderLayer(new SliceViewAnnotationPointListLayer(this.layer));
  }
  toJSON() {
    let x: any = {'type': LAYER_TYPE};
    x['points'] = this.layer.pointList.toJSON();
    return x;
  }

  handleAction(action: string) {
    switch (action) {
      case 'annotate': {
        let selectedValue = this.manager.layerSelectedValues.get(this);
        if (selectedValue !== undefined) {
          this.layer.pointList.delete(selectedValue);
        } else if (this.manager.layerSelectedValues.mouseState.active) {
          this.layer.pointList.append(this.manager.voxelSize.voxelFromSpatial(
              vec3.create(), this.manager.layerSelectedValues.mouseState.position));
        }
        break;
      }
    }
  }
}

registerLayerType(LAYER_TYPE, AnnotationPointListUserLayer);
