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
import {ManagedUserLayer, registerLayerType, registerLayerTypeDetector, registerVolumeLayerType, UserLayer, UserLayerSelectionState} from 'neuroglancer/layer';
import {LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {Overlay} from 'neuroglancer/overlay';
import {getChannelSpace} from 'neuroglancer/render_coordinate_transform';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {DataType, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {defineImageLayerShader, getTrackableFragmentMain, ImageRenderLayer} from 'neuroglancer/sliceview/volume/image_renderlayer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {trackableBlendModeValue} from 'neuroglancer/trackable_blend';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {makeCachedDerivedWatchableValue, makeCachedLazyDerivedWatchableValue, registerNested, WatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {UserLayerWithAnnotationsMixin} from 'neuroglancer/ui/annotations';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {Borrowed} from 'neuroglancer/util/disposable';
import {makeValueOrError} from 'neuroglancer/util/error';
import {verifyOptionalObjectProperty} from 'neuroglancer/util/json';
import {VolumeRenderingRenderLayer} from 'neuroglancer/volume_rendering/volume_render_layer';
import {makeWatchableShaderError, ParameterizedShaderGetterResult} from 'neuroglancer/webgl/dynamic_shader';
import {setControlsInShader, ShaderControlsBuilderState, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {ChannelDimensionsWidget} from 'neuroglancer/widget/channel_dimensions_widget';
import {makeCopyButton} from 'neuroglancer/widget/copy_button';
import {DependentViewContext} from 'neuroglancer/widget/dependent_view_widget';
import {makeHelpButton} from 'neuroglancer/widget/help_button';
import {addLayerControlToOptionsTab, LayerControlDefinition, registerLayerControl} from 'neuroglancer/widget/layer_control';
import {checkboxLayerControl} from 'neuroglancer/widget/layer_control_checkbox';
import {enumLayerControl} from 'neuroglancer/widget/layer_control_enum';
import {rangeLayerControl} from 'neuroglancer/widget/layer_control_range';
import {makeMaximizeButton} from 'neuroglancer/widget/maximize_button';
import {renderScaleLayerControl} from 'neuroglancer/widget/render_scale_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {LegendShaderOptions, registerLayerShaderControlsTool, ShaderControls} from 'neuroglancer/widget/shader_controls';
import {Tab} from 'neuroglancer/widget/tab_view';

const OPACITY_JSON_KEY = 'opacity';
const BLEND_JSON_KEY = 'blend';
const SHADER_JSON_KEY = 'shader';
const SHADER_CONTROLS_JSON_KEY = 'shaderControls';
const CROSS_SECTION_RENDER_SCALE_JSON_KEY = 'crossSectionRenderScale';
const CHANNEL_DIMENSIONS_JSON_KEY = 'channelDimensions';
const VOLUME_RENDERING_JSON_KEY = 'volumeRendering';
const VOLUME_RENDER_SCALE_JSON_KEY = 'volumeRenderScale';

export interface ImageLayerSelectionState extends UserLayerSelectionState {
  value: any;
}

const Base = UserLayerWithAnnotationsMixin(UserLayer);
export class ImageUserLayer extends Base {
  opacity = trackableAlphaValue(0.5);
  blendMode = trackableBlendModeValue();
  fragmentMain = getTrackableFragmentMain();
  shaderError = makeWatchableShaderError();
  dataType = new WatchableValue<DataType|undefined>(undefined);
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
  volumeRenderingRenderScaleHistogram = new RenderScaleHistogram();
  // unused
  volumeRenderingRenderScaleTarget = trackableRenderScaleTarget(1);

  channelCoordinateSpace = new TrackableCoordinateSpace();
  channelCoordinateSpaceCombiner =
      new CoordinateSpaceCombiner(this.channelCoordinateSpace, isChannelDimension);
  channelSpace = this.registerDisposer(makeCachedLazyDerivedWatchableValue(
      channelCoordinateSpace => makeValueOrError(() => getChannelSpace(channelCoordinateSpace)),
      this.channelCoordinateSpace));
  volumeRendering = new TrackableBoolean(false, false);

  shaderControlState = this.registerDisposer(new ShaderControlState(
      this.fragmentMain,
      this.registerDisposer(makeCachedDerivedWatchableValue(
          (dataType: DataType|undefined, channelCoordinateSpace: CoordinateSpace) => {
            if (dataType === undefined) return null;
            return {imageData: {dataType, channelRank: channelCoordinateSpace.rank}};
          },
          [this.dataType, this.channelCoordinateSpace],
          (a, b) => JSON.stringify(a) === JSON.stringify(b))),
      this.channelCoordinateSpaceCombiner));

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

  selectionState: ImageLayerSelectionState;

  constructor(managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.localCoordinateSpaceCombiner.includeDimensionPredicate = isLocalDimension;
    this.blendMode.changed.add(this.specificationChanged.dispatch);
    this.opacity.changed.add(this.specificationChanged.dispatch);
    this.fragmentMain.changed.add(this.specificationChanged.dispatch);
    this.shaderControlState.changed.add(this.specificationChanged.dispatch);
    this.sliceViewRenderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.volumeRendering.changed.add(this.specificationChanged.dispatch);
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
      loadedSubsource.activate(context => {
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
        const volumeRenderLayer = context.registerDisposer(new VolumeRenderingRenderLayer({
          multiscaleSource: volume,
          shaderControlState: this.shaderControlState,
          shaderError: this.shaderError,
          transform: loadedSubsource.getRenderLayerTransform(this.channelCoordinateSpace),
          renderScaleTarget: this.volumeRenderingRenderScaleTarget,
          renderScaleHistogram: this.volumeRenderingRenderScaleHistogram,
          localPosition: this.localPosition,
          channelCoordinateSpace: this.channelCoordinateSpace,
        }));
        context.registerDisposer(loadedSubsource.messages.addChild(volumeRenderLayer.messages));
        context.registerDisposer(registerNested((context, volumeRendering) => {
          if (!volumeRendering) return;
          context.registerDisposer(this.addRenderLayer(volumeRenderLayer.addRef()));
        }, this.volumeRendering));
        this.shaderError.changed.dispatch();
      });
    }
    this.dataType.value = dataType;
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
    this.channelCoordinateSpace.restoreState(specification[CHANNEL_DIMENSIONS_JSON_KEY]);
    this.volumeRendering.restoreState(specification[VOLUME_RENDERING_JSON_KEY]);
  }
  toJSON() {
    const x = super.toJSON();
    x[OPACITY_JSON_KEY] = this.opacity.toJSON();
    x[BLEND_JSON_KEY] = this.blendMode.toJSON();
    x[SHADER_JSON_KEY] = this.fragmentMain.toJSON();
    x[SHADER_CONTROLS_JSON_KEY] = this.shaderControlState.toJSON();
    x[CROSS_SECTION_RENDER_SCALE_JSON_KEY] = this.sliceViewRenderScaleTarget.toJSON();
    x[CHANNEL_DIMENSIONS_JSON_KEY] = this.channelCoordinateSpace.toJSON();
    x[VOLUME_RENDERING_JSON_KEY] = this.volumeRendering.toJSON();
    return x;
  }

  displayImageSelectionState(state: this['selectionState'], parent: HTMLElement): boolean {
    const {value} = state;
    if (value == null) return false;
    const channelSpace = this.channelSpace.value;
    if (channelSpace.error !== undefined) return false;
    const {numChannels, coordinates, channelCoordinateSpace: {names, rank}} = channelSpace;
    const grid = document.createElement('div');
    grid.classList.add('neuroglancer-selection-details-value-grid');
    let gridTemplateColumns = '[copy] 0fr ';
    if (rank !== 0) {
      gridTemplateColumns += `repeat(${rank}, [dim] 0fr [coord] 0fr) `;
    }
    gridTemplateColumns += `[value] 1fr`;
    grid.style.gridTemplateColumns = gridTemplateColumns;
    for (let channelIndex = 0; channelIndex < numChannels; ++channelIndex) {
      const x = rank === 0 ? value : value[channelIndex];
      // TODO(jbms): do data type-specific formatting
      const valueString = x == null ? '' : x.toString();
      const copyButton = makeCopyButton({
        title: `Copy value`,
        onClick: () => {
          setClipboard(valueString);
        },
      });
      grid.appendChild(copyButton);
      for (let channelDim = 0; channelDim < rank; ++channelDim) {
        const dimElement = document.createElement('div');
        dimElement.classList.add('neuroglancer-selection-details-value-grid-dim');
        dimElement.textContent = names[channelDim];
        grid.appendChild(dimElement);
        const coordElement = document.createElement('div');
        coordElement.classList.add('neuroglancer-selection-details-value-grid-coord');
        coordElement.textContent = coordinates[channelIndex * rank + channelDim].toString();
        grid.appendChild(coordElement);
      }
      const valueElement = document.createElement('div');
      valueElement.classList.add('neuroglancer-selection-details-value-grid-value');
      valueElement.textContent = valueString;
      grid.appendChild(valueElement);
    }
    parent.appendChild(grid);
    return true;
  }

  displaySelectionState(
      state: this['selectionState'], parent: HTMLElement, context: DependentViewContext): boolean {
    let displayed = this.displayImageSelectionState(state, parent);
    if (super.displaySelectionState(state, parent, context)) displayed = true;
    return displayed;
  }

  getLegendShaderOptions(): LegendShaderOptions {
    return {
      memoizeKey: `ImageUserLayer`,
      parameters: this.shaderControlState.builderState,
      // fixme: support fallback
      encodeParameters: p => p.key,
      defineShader: (builder, shaderBuilderState: ShaderControlsBuilderState) => {
        builder.addFragmentCode(`
#define uOpacity 1.0
`);
        defineImageLayerShader(builder, shaderBuilderState);
      },
      initializeShader:
          (shaderResult: ParameterizedShaderGetterResult<ShaderControlsBuilderState>) => {
            const shader = shaderResult.shader!;
            setControlsInShader(
                this.manager.root.display.gl, shader, this.shaderControlState,
                shaderResult.parameters.parseResult.controls);
          },
    };
  }

  static type = 'image';
  static typeAbbreviation = 'img';
}

function makeShaderCodeWidget(layer: ImageUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.shaderError,
    fragmentMain: layer.fragmentMain,
    shaderControlState: layer.shaderControlState,
  });
}

const LAYER_CONTROLS: LayerControlDefinition<ImageUserLayer>[] = [
  {
    label: 'Resolution (slice)',
    toolJson: CROSS_SECTION_RENDER_SCALE_JSON_KEY,
    ...renderScaleLayerControl(layer => ({
                                 histogram: layer.sliceViewRenderScaleHistogram,
                                 target: layer.sliceViewRenderScaleTarget
                               })),
  },
  {
    label: 'Blending',
    toolJson: BLEND_JSON_KEY,
    ...enumLayerControl(layer => layer.blendMode),
  },
  {
    label: 'Volume rendering (experimental)',
    toolJson: VOLUME_RENDERING_JSON_KEY,
    ...checkboxLayerControl(layer => layer.volumeRendering),
  },
  {
    label: 'Resolution (3d)',
    toolJson: VOLUME_RENDER_SCALE_JSON_KEY,
    isValid: layer => layer.volumeRendering,
    ...renderScaleLayerControl(layer => ({
                                 histogram: layer.volumeRenderingRenderScaleHistogram,
                                 target: layer.volumeRenderingRenderScaleTarget
                               })),
  },
  {
    label: 'Opacity',
    toolJson: OPACITY_JSON_KEY,
    ...rangeLayerControl(layer => ({value: layer.opacity})),
  },
];

for (const control of LAYER_CONTROLS) {
  registerLayerControl(ImageUserLayer, control);
}

class RenderingOptionsTab extends Tab {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: ImageUserLayer) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-image-dropdown');

    for (const control of LAYER_CONTROLS) {
      element.appendChild(addLayerControlToOptionsTab(this, layer, this.visibility, control));
    }

    let spacer = document.createElement('div');
    spacer.style.flex = '1';

    let topRow = document.createElement('div');
    topRow.className = 'neuroglancer-image-dropdown-top-row';
    topRow.appendChild(document.createTextNode('Shader'));
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
        this
            .registerDisposer(new ShaderControls(
                layer.shaderControlState, this.layer.manager.root.display, this.layer, {
                  visibility: this.visibility,
                  legendShaderOptions: this.layer.getLegendShaderOptions(),
                }))
            .element);
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: ImageUserLayer) {
    super();
    this.content.classList.add('neuroglancer-image-layer-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType(ImageUserLayer);
registerVolumeLayerType(VolumeType.IMAGE, ImageUserLayer);
// Use ImageUserLayer as a fallback layer type if there is a `volume` subsource.
registerLayerTypeDetector(subsource => {
  const {volume} = subsource;
  if (volume === undefined) return undefined;
  if (volume.volumeType !== VolumeType.UNKNOWN) return undefined;
  return {layerConstructor: ImageUserLayer, priority: -100};
});

registerLayerShaderControlsTool(
    ImageUserLayer, layer => ({
                      shaderControlState: layer.shaderControlState,
                      legendShaderOptions: layer.getLegendShaderOptions()
                    }));
