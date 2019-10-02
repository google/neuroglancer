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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {DataSourceProvider, GetVectorGraphicsOptions} from 'neuroglancer/datasource';
import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType} from 'neuroglancer/layer_specification';
import {VectorGraphicsType} from 'neuroglancer/sliceview/vector_graphics/base';
import {MultiscaleVectorGraphicsChunkSource, RenderLayer} from 'neuroglancer/sliceview/vector_graphics/frontend';
import {VectorGraphicsLineRenderLayer} from 'neuroglancer/sliceview/vector_graphics/vector_graphics_line_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {trackableFiniteFloat} from 'neuroglancer/trackable_finite_float';
import {trackableVec3, TrackableVec3} from 'neuroglancer/trackable_vec3';
import {vec3} from 'neuroglancer/util/geom';
import {verifyEnumString, verifyFiniteFloat, verifyOptionalString} from 'neuroglancer/util/json';
import {RangeWidget} from 'neuroglancer/widget/range';
import {Tab} from 'neuroglancer/widget/tab_view';
import {Vec3Widget} from 'neuroglancer/widget/vec3_entry_widget';

import './image_user_layer.css';
import 'neuroglancer/maximize_button.css';

function getVectorGraphicsWithStatusMessage(
    dataSourceProvider: DataSourceProvider, chunkManager: ChunkManager, x: string,
    options: GetVectorGraphicsOptions = {}): Promise<MultiscaleVectorGraphicsChunkSource> {
  return StatusMessage.forPromise(
      new Promise(function(resolve) {
        resolve(dataSourceProvider.getVectorGraphicsSource(chunkManager, x, options));
      }),
      {
        initialMessage: `Retrieving metadata for vector graphics source ${x}.`,
        delay: true,
        errorPrefix: `Error retrieving metadata for vector graphics source ${x}: `,
      });
}

export class VectorGraphicsUserLayer extends UserLayer {
  vectorGraphicsPath: string|undefined;
  vectorGraphicsLayerType: VectorGraphicsType;
  opacity = trackableAlphaValue(0.5);
  lineWidth = trackableFiniteFloat(10.0);
  color = trackableVec3(vec3.fromValues(1.0, 1.0, 1.0));
  renderLayer: RenderLayer;
  constructor(manager: LayerListSpecification, x: any) {
    super(manager, x);

    this.opacity.restoreState(x['opacity']);
    this.lineWidth.restoreState(x['linewidth']);
    this.color.restoreState(x['color']);

    this.lineWidth.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.color.changed.add(() => {
      this.specificationChanged.dispatch();
    });

    this.vectorGraphicsLayerType = verifyEnumString(x['type'], VectorGraphicsType);

    let vectorGraphicsPath = this.vectorGraphicsPath = verifyOptionalString(x['source']);
    let remaining = 0;
    if (vectorGraphicsPath !== undefined) {
      ++remaining;
      if (this.vectorGraphicsLayerType === VectorGraphicsType.LINE) {
        getVectorGraphicsWithStatusMessage(
            manager.dataSourceProvider, manager.chunkManager, vectorGraphicsPath)
            .then(vectorGraphics => {
              if (!this.wasDisposed) {
                let renderLayer = this.renderLayer =
                    new VectorGraphicsLineRenderLayer(vectorGraphics, {
                      opacity: this.opacity,
                      lineWidth: this.lineWidth,
                      color: this.color,
                      sourceOptions: {}
                    });
                this.addRenderLayer(renderLayer);
                if (--remaining === 0) {
                  this.isReady = true;
                }
              }
            });
      }
    }
    this.tabs.add(
        'rendering', {label: 'Rendering', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.default = 'rendering';
  }

  toJSON() {
    const x = super.toJSON();
    x['type'] = this.getLayerType();
    x['source'] = this.vectorGraphicsPath;
    x['opacity'] = this.opacity.toJSON();
    x['linewidth'] = this.lineWidth.toJSON();
    x['color'] = this.color.toJSON();
    return x;
  }

  getLayerType() {
    let typeStr = VectorGraphicsType[this.vectorGraphicsLayerType];
    return typeStr.toLowerCase();
  }
}

class DisplayOptionsTab extends Tab {
  opacityWidget = this.registerDisposer(new RangeWidget(this.layer.opacity));
  lineWidthWidget =
      this.registerDisposer(new RangeWidget(this.layer.lineWidth, {min: 0, max: 50, step: 1}));
  colorWidget = this.registerDisposer(new VectorGraphicsColorWidget(this.layer.color));

  constructor(public layer: VectorGraphicsUserLayer) {
    super();
    const {element} = this;
    element.classList.add('image-dropdown');
    let {opacityWidget, lineWidthWidget, colorWidget} = this;
    let topRow = document.createElement('div');
    topRow.className = 'image-dropdown-top-row';
    opacityWidget.promptElement.textContent = 'Opacity';
    lineWidthWidget.promptElement.textContent = 'Line Width';
    colorWidget.promptElement.textContent = 'Color';

    let spacer = document.createElement('div');
    spacer.style.flex = '1';
    let helpLink = document.createElement('a');
    let helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.textContent = '?';
    helpButton.className = 'help-link';
    helpLink.appendChild(helpButton);
    helpLink.title = 'Documentation on vector graphics layer rendering';
    helpLink.target = '_blank';
    helpLink.href =
        'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/vectorgraphics_layer_rendering.md';

    topRow.appendChild(spacer);
    topRow.appendChild(helpLink);

    element.appendChild(topRow);
    element.appendChild(this.opacityWidget.element);
    element.appendChild(this.lineWidthWidget.element);
    element.appendChild(this.colorWidget.element);
  }
}


class VectorGraphicsColorWidget extends Vec3Widget {
  constructor(model: TrackableVec3) {
    super(model);
  }

  verifyValue(value: any) {
    let num = verifyFiniteFloat(value);
    // Scale from [0,255] to [0,1]
    num = num / 255.0;

    if (num < 0.) {
      return 0.;
    }
    if (num > 1.) {
      return 1.;
    }
    return num;
  }

  updateInput() {
    this.inputx.valueAsNumber = Math.round(this.model.value[0] * 255.);
    this.inputy.valueAsNumber = Math.round(this.model.value[1] * 255.);
    this.inputz.valueAsNumber = Math.round(this.model.value[2] * 255.);
  }
}


registerLayerType('line', VectorGraphicsUserLayer);
// registerLayerType('point', VectorGraphicsUserLayer);
