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
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {getPoint, GetPointOptions} from 'neuroglancer/datasource/factory';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {Overlay} from 'neuroglancer/overlay';
// import {VolumeType} from 'neuroglancer/sliceview/base';
// import {FRAGMENT_MAIN_START, getTrackableFragmentMain, ImageRenderLayer} from
// 'neuroglancer/sliceview/image_renderlayer'; import {SliceViewPanelPointLayer, PointLayer} from
// 'neuroglancer/point/frontend';
import {MultiscalePointChunkSource, RenderLayer} from 'neuroglancer/point/frontend';
import {PointRenderLayer} from 'neuroglancer/point/point_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {mat4} from 'neuroglancer/util/geom';
import {verifyOptionalString} from 'neuroglancer/util/json';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {RangeWidget} from 'neuroglancer/widget/range';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';

require('./image_user_layer.css');
require('neuroglancer/help_button.css');
require('neuroglancer/maximize_button.css');

function getPointsWithStatusMessage(
    chunkManager: ChunkManager, x: string,
    options: GetPointOptions = {}): Promise<MultiscalePointChunkSource> {
  return StatusMessage.forPromise(
      new Promise(function(resolve) {
        resolve(getPoint(chunkManager, x, options));
      }),
      {
        initialMessage: `Retrieving metadata for point source ${x}.`,
        delay: true,
        errorPrefix: `Error retrieving metadata for point source ${x}: `,
      });
}

export class PointUserLayer extends UserLayer {
  pointsPath: string|undefined;
  opacity = trackableAlphaValue(0.5);
  //   fragmentMain = getTrackableFragmentMain();
  //   shaderError = makeWatchableShaderError();
  renderLayer: RenderLayer;
  constructor(manager: LayerListSpecification, x: any) {
    super();

    this.opacity.restoreState(x['opacity']);

    let pointsPath = this.pointsPath = verifyOptionalString(x['point']);
    if (pointsPath !== undefined) {
      getPointsWithStatusMessage(manager.chunkManager, pointsPath).then(points => {
        if (!this.wasDisposed) {
          let renderLayer = this.renderLayer =
              new PointRenderLayer(points, {opacity: this.opacity, sourceOptions: {}});
          this.addRenderLayer(renderLayer);
        }
      });
    }
  }
  toJSON() {
    let x: any = {'type': 'point'};
    x['point'] = this.pointsPath;
    x['opacity'] = this.opacity.toJSON();
    return x;
  }
  makeDropdown(element: HTMLDivElement) {
    return new PointDropDown(element, this);
  }
}

/*
function makeShaderCodeWidget(layer: ImageUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.shaderError,
    fragmentMain: layer.fragmentMain,
    fragmentMainStartLine: FRAGMENT_MAIN_START,
  });
}
*/

class PointDropDown extends UserLayerDropdown {
  opacityWidget = this.registerDisposer(new RangeWidget(this.layer.opacity));

  constructor(public element: HTMLDivElement, public layer: PointUserLayer) {
    super();
    element.classList.add('image-dropdown');
    let {opacityWidget} = this;
    let topRow = document.createElement('div');
    topRow.className = 'image-dropdown-top-row';
    opacityWidget.promptElement.textContent = 'Opacity';
    let spacer = document.createElement('div');
    spacer.style.flex = '1';
    let helpLink = document.createElement('a');
    let helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.textContent = '?';
    helpButton.className = 'help-link';
    helpLink.appendChild(helpButton);
    helpLink.title = 'Documentation on point layer rendering';
    helpLink.target = '_blank';
    helpLink.href = '#';

    topRow.appendChild(this.opacityWidget.element);
    topRow.appendChild(spacer);
    topRow.appendChild(helpLink);

    element.appendChild(topRow);
  }
}

registerLayerType('point', PointUserLayer);
