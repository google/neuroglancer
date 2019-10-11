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

import './image_user_layer.css';

import {CoordinateSpace, CoordinateSpaceCombiner, isChannelDimension, isLocalDimension, TrackableCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {ManagedUserLayer, registerLayerType, registerVolumeLayerType, UserLayer} from 'neuroglancer/layer';
import {LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {Overlay} from 'neuroglancer/overlay';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {DataType, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {getTrackableFragmentMain, ImageRenderLayer} from 'neuroglancer/sliceview/volume/image_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {trackableBlendModeValue} from 'neuroglancer/trackable_blend';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {Borrowed} from 'neuroglancer/util/disposable';
import {verifyOptionalObjectProperty} from 'neuroglancer/util/json';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {ChannelDimensionsWidget} from 'neuroglancer/widget/channel_dimensions_widget';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {makeHelpButton} from 'neuroglancer/widget/help_button';
import {makeMaximizeButton} from 'neuroglancer/widget/maximize_button';
import {RangeWidget} from 'neuroglancer/widget/range';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {ShaderControls} from 'neuroglancer/widget/shader_controls';
import {Tab} from 'neuroglancer/widget/tab_view';

const OPACITY_JSON_KEY = 'opacity';
const BLEND_JSON_KEY = 'blend';
const SHADER_JSON_KEY = 'shader';
const SHADER_CONTROLS_JSON_KEY = 'shaderControls';
const CROSS_SECTION_RENDER_SCALE_JSON_KEY = 'crossSectionRenderScale';

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class ImageUserLayer extends Base {
  opacity = trackableAlphaValue(0.5);
  blendMode = trackableBlendModeValue();
  fragmentMain = getTrackableFragmentMain();
  shaderError = makeWatchableShaderError();
  shaderControlState = new ShaderControlState(this.fragmentMain);
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
  channelCoordinateSpace = new TrackableCoordinateSpace();
  channelCoordinateSpaceCombiner =
      new CoordinateSpaceCombiner(this.channelCoordinateSpace, isChannelDimension);

  markLoading() {
    const baseDisposer = super.markLoading();
    const channelDisposer = this.channelCoordinateSpaceCombiner.retain();
    return () => {
      baseDisposer();
      channelDisposer();
    };
  }

  addCoordinateSpace(coordinateSpace: WatchableValueInterface<CoordinateSpace>) {
    const baseBinding = super.addCoordinateSpace(coordinateSpace);
    const channelBinding = this.channelCoordinateSpaceCombiner.bind(coordinateSpace);
    return () => {
      baseBinding();
      channelBinding();
    };
  }


  constructor(managedLayer: Borrowed<ManagedUserLayer>, specification: any) {
    super(managedLayer, specification);
    this.localCoordinateSpaceCombiner.includeDimensionPredicate = isLocalDimension;
    this.blendMode.changed.add(this.specificationChanged.dispatch);
    this.opacity.changed.add(this.specificationChanged.dispatch);
    this.fragmentMain.changed.add(this.specificationChanged.dispatch);
    this.shaderControlState.changed.add(this.specificationChanged.dispatch);
    this.sliceViewRenderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.tabs.add(
        'rendering',
        {label: 'Rendering', order: -100, getter: () => new RenderingOptionsTab(this)});
    this.tabs.default = 'rendering';
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    let dataType: DataType|undefined;
    for (const loadedSubsource of subsources) {
      if (this.addStaticAnnotations(loadedSubsource)) continue;
      const {subsourceEntry} = loadedSubsource;
      const {subsource} = subsourceEntry;
      const {volume} = subsource;
      if (!(volume instanceof MultiscaleVolumeChunkSource)) {
        loadedSubsource.deactivate('Not compatible with image layer');
        continue;
      }
      if (dataType && volume.dataType !== dataType) {
        loadedSubsource.deactivate(`Data type must be ${DataType[volume.dataType].toLowerCase()}`);
        continue;
      }
      dataType = volume.dataType;
      loadedSubsource.activate(() => {
        loadedSubsource.addRenderLayer(new ImageRenderLayer(volume, {
          opacity: this.opacity,
          blendMode: this.blendMode,
          shaderControlState: this.shaderControlState,
          shaderError: this.shaderError,
          transform: loadedSubsource.getRenderLayerTransform(this.channelCoordinateSpace),
          renderScaleTarget: this.sliceViewRenderScaleTarget,
          renderScaleHistogram: this.sliceViewRenderScaleHistogram,
          localPosition: this.localPosition,
          channelCoordinateSpace: this.channelCoordinateSpace,
        }));
        this.shaderError.changed.dispatch();
      });
    }
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.opacity.restoreState(specification[OPACITY_JSON_KEY]);
    verifyOptionalObjectProperty(
        specification, BLEND_JSON_KEY, blendValue => this.blendMode.restoreState(blendValue));
    this.fragmentMain.restoreState(specification[SHADER_JSON_KEY]);
    this.shaderControlState.restoreState(specification[SHADER_CONTROLS_JSON_KEY]);
    this.sliceViewRenderScaleTarget.restoreState(
        specification[CROSS_SECTION_RENDER_SCALE_JSON_KEY]);
  }
  toJSON() {
    const x = super.toJSON();
    x[OPACITY_JSON_KEY] = this.opacity.toJSON();
    x[BLEND_JSON_KEY] = this.blendMode.toJSON();
    x[SHADER_JSON_KEY] = this.fragmentMain.toJSON();
    x[SHADER_CONTROLS_JSON_KEY] = this.shaderControlState.toJSON();
    x[CROSS_SECTION_RENDER_SCALE_JSON_KEY] = this.sliceViewRenderScaleTarget.toJSON();
    return x;
  }

  static type = 'image';
}

function makeShaderCodeWidget(layer: ImageUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.shaderError,
    fragmentMain: layer.fragmentMain,
    shaderControlState: layer.shaderControlState,
  });
}

class RenderingOptionsTab extends Tab {
  opacityWidget = this.registerDisposer(new RangeWidget(this.layer.opacity));
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: ImageUserLayer) {
    super();
    const {element} = this;
    element.classList.add('image-dropdown');
    let {opacityWidget} = this;
    let topRow = document.createElement('div');
    topRow.className = 'image-dropdown-top-row';
    opacityWidget.promptElement.textContent = 'Opacity';

    {
      const renderScaleWidget = this.registerDisposer(new RenderScaleWidget(
          this.layer.sliceViewRenderScaleHistogram, this.layer.sliceViewRenderScaleTarget));
      renderScaleWidget.label.textContent = 'Resolution (slice)';
      element.appendChild(renderScaleWidget.element);
    }

    {
      const label = document.createElement('label');
      label.textContent = 'Blending';
      label.appendChild(this.registerDisposer(new EnumSelectWidget(layer.blendMode)).element);
      element.appendChild(label);
    }

    let spacer = document.createElement('div');
    spacer.style.flex = '1';

    topRow.appendChild(this.opacityWidget.element);
    topRow.appendChild(spacer);
    topRow.appendChild(makeMaximizeButton({
      title: 'Show larger editor view',
      onClick: () => {
        new ShaderCodeOverlay(this.layer);
      }
    }));
    topRow.appendChild(makeHelpButton({
      title: 'Documentation on image layer rendering',
      href:
          'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md',
    }));

    element.appendChild(topRow);
    element.appendChild(
        this.registerDisposer(new ChannelDimensionsWidget(layer.channelCoordinateSpaceCombiner))
            .element);
    element.appendChild(this.codeWidget.element);
    element.appendChild(
        this.registerDisposer(new ShaderControls(layer.shaderControlState)).element);
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: ImageUserLayer) {
    super();
    this.content.classList.add('image-layer-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType('image', ImageUserLayer);
registerVolumeLayerType(VolumeType.IMAGE, ImageUserLayer);
