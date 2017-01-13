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

import {AnnotationPointListLayer, PerspectiveViewAnnotationPointListLayer, SliceViewAnnotationPointListLayer} from 'neuroglancer/annotation/frontend';
import {AnnotationPointList} from 'neuroglancer/annotation/point_list';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType} from 'neuroglancer/layer_specification';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {vec3} from 'neuroglancer/util/geom';
import {PointListWidget} from 'neuroglancer/widget/point_list_widget';

require('./user_layer.css');

const LAYER_TYPE = 'pointAnnotation';

export class AnnotationPointListUserLayer extends UserLayer {
  selectedIndex = new WatchableValue<number|null>(null);
  layer = new AnnotationPointListLayer(
      this.manager.chunkManager, new AnnotationPointList(), this.manager.voxelSize,
      this.selectedIndex);
  constructor(public manager: LayerListSpecification, x: any) {
    super([]);
    this.layer.pointList.restoreState(x['points']);
    this.registerDisposer(
        this.layer.pointList.changed.add(() => { this.specificationChanged.dispatch(); }));
    this.addRenderLayer(new PerspectiveViewAnnotationPointListLayer(this.layer));
    this.addRenderLayer(new SliceViewAnnotationPointListLayer(this.layer));
    const {layerSelectedValues} = manager;
    this.registerDisposer(layerSelectedValues.changed.add(() => {
      let value = layerSelectedValues.get(this);
      this.selectedIndex.value = typeof value === 'number' ? value : null;
    }));
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

  makeDropdown(element: HTMLDivElement) { return new Dropdown(element, this); }
}

class Dropdown extends UserLayerDropdown {
  pointListWidget = this.registerDisposer(
      new PointListWidget(this.layer.layer.pointList, this.layer.selectedIndex));
  constructor(public element: HTMLDivElement, public layer: AnnotationPointListUserLayer) {
    super();
    element.classList.add('neuroglancer-annotation-point-list-dropdown');
    element.appendChild(this.pointListWidget.element);
    this.registerDisposer(this.pointListWidget.pointSelected.add((index: number) => {
      this.layer.manager.setVoxelCoordinates(this.layer.layer.pointList.get(index));
    }));
  }
  onShow() {
    super.onShow();
    this.pointListWidget.visible = true;
  }
  onHide() {
    super.onHide();
    this.pointListWidget.visible = false;
  }
}

registerLayerType(LAYER_TYPE, AnnotationPointListUserLayer);
