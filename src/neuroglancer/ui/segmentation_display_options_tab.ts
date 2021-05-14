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

import svg_rotate from 'ikonate/icons/rotate.svg';
import type {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {Overlay} from 'neuroglancer/overlay';
import {ViewSpecificSkeletonRenderingOptions} from 'neuroglancer/skeleton/frontend';
import {TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {makeHelpButton} from 'neuroglancer/widget/help_button';
import {makeIcon} from 'neuroglancer/widget/icon';
import {LinkedLayerGroupWidget} from 'neuroglancer/widget/linked_layer';
import {makeMaximizeButton} from 'neuroglancer/widget/maximize_button';
import {RangeWidget} from 'neuroglancer/widget/range';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {ShaderControls} from 'neuroglancer/widget/shader_controls';
import {Tab} from 'neuroglancer/widget/tab_view';
import {TextInputWidget} from 'neuroglancer/widget/text_input';
import {vec3} from 'neuroglancer/util/geom';
import {observeWatchable} from 'neuroglancer/trackable_value';
import {parseRGBColorSpecification, serializeColor} from 'neuroglancer/util/color';

const maxSilhouettePower = 10;

function makeSkeletonShaderCodeWidget(layer: SegmentationUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.skeletonRenderingOptions.shader,
    shaderError: layer.displayState.shaderError,
    shaderControlState: layer.displayState.skeletonRenderingOptions.shaderControlState,
  });
}

export class DisplayOptionsTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-segmentation-rendering-tab');

    // Linked segmentation control
    {
      const widget = this.registerDisposer(
          new LinkedLayerGroupWidget(layer.displayState.linkedSegmentationGroup));
      widget.label.textContent = 'Linked to: ';
      element.appendChild(widget.element);
    }

    // Linked segmentation control
    {
      const widget = this.registerDisposer(
          new LinkedLayerGroupWidget(layer.displayState.linkedSegmentationColorGroup));
      widget.label.textContent = 'Colors linked to: ';
      element.appendChild(widget.element);
    }

    {
      const label = document.createElement('label');
      label.title = 'Use a fixed color for all segments without an explicitly-specified color';
      label.style.display = 'flex';
      label.style.flexDirection = 'row';
      const {segmentDefaultColor} = layer.displayState;
      const checkbox = document.createElement('input');
      checkbox.type = 'radio';
      label.appendChild(checkbox);
      const labelText = document.createElement('span');
      labelText.textContent = 'Fixed color';
      labelText.style.marginRight = '1em';
      label.appendChild(labelText);
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      label.appendChild(colorInput);
      const updateFromView = (useDefaultColor: boolean) => {
        if (!useDefaultColor) {
          segmentDefaultColor.value = undefined;
        } else {
          segmentDefaultColor.value = vec3.fromValues(1, 0, 0);
          colorInput.click();
        }
      };
      checkbox.addEventListener('change', () => {
        updateFromView(checkbox.checked);
      });
      colorInput.addEventListener('change', () => {
        segmentDefaultColor.value = parseRGBColorSpecification(colorInput.value);
      });
      colorInput.addEventListener('input', () => {
        segmentDefaultColor.value = parseRGBColorSpecification(colorInput.value);
      });
      const seedLabel = document.createElement('label');
      seedLabel.title = 'Color segments based on a hash of their id';
      const seedCheckbox = document.createElement('input');
      seedCheckbox.type = 'radio';
      seedCheckbox.addEventListener('change', () => {
        updateFromView(!seedCheckbox.checked);
      });
      seedLabel.appendChild(seedCheckbox);
      const seedLabelText = document.createElement('span');
      seedLabelText.textContent = 'Color seed';
      seedLabelText.style.marginRight = '1em';
      seedLabel.appendChild(seedLabelText);
      seedLabel.style.display = 'flex';
      seedLabel.style.flexDirection = 'row';
      const widget =
        this.registerDisposer(new TextInputWidget(layer.displayState.segmentColorHash));
      widget.element.style.flex = '1';
      seedLabel.appendChild(widget.element);
      const randomize = makeIcon({
        svg: svg_rotate,
        title: 'Randomize',
        onClick: () => {
          layer.displayState.segmentationColorGroupState.value.segmentColorHash.randomize();
        },
      });
      seedLabel.appendChild(randomize);
      element.appendChild(seedLabel);
      element.appendChild(label);

      this.registerDisposer(observeWatchable(value => {
        if (value === undefined) {
          colorInput.style.visibility = 'hidden';
          checkbox.checked = false;
          seedCheckbox.checked = true;
          randomize.style.visibility = '';
          widget.element.style.visibility = '';
        } else {
          colorInput.style.visibility = '';
          colorInput.value = serializeColor(value);
          checkbox.checked = true;
          seedCheckbox.checked = false;
          randomize.style.visibility = 'hidden';
          widget.element.style.visibility = 'hidden';
        }
      }, segmentDefaultColor));
    }

    {
      const saturationWidget =
          this.registerDisposer(new RangeWidget(this.layer.displayState.saturation));
      saturationWidget.promptElement.textContent = 'Saturation';
      element.appendChild(saturationWidget.element);
    }

    // 2-d only controls
    const controls2d = this.registerDisposer(
        new DependentViewWidget(layer.has2dLayer, (has2dLayer, parent, refCounted) => {
          if (!has2dLayer) return;
          const selectedAlphaWidget =
              refCounted.registerDisposer(new RangeWidget(this.layer.displayState.selectedAlpha));
          selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
          parent.appendChild(selectedAlphaWidget.element);
          const notSelectedAlphaWidget = refCounted.registerDisposer(
              new RangeWidget(this.layer.displayState.notSelectedAlpha));
          notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';
          parent.appendChild(notSelectedAlphaWidget.element);
          {
            const renderScaleWidget = refCounted.registerDisposer(new RenderScaleWidget(
                this.layer.sliceViewRenderScaleHistogram, this.layer.sliceViewRenderScaleTarget));
            renderScaleWidget.label.textContent = 'Resolution (slice)';
            parent.appendChild(renderScaleWidget.element);
          }
        }, this.visibility));
    element.appendChild(controls2d.element);

    const controls3d = this.registerDisposer(
        new DependentViewWidget(layer.has3dLayer, (has3dLayer, parent, refCounted) => {
          if (!has3dLayer) return;
          {
            const renderScaleWidget = refCounted.registerDisposer(new RenderScaleWidget(
                this.layer.displayState.renderScaleHistogram,
                this.layer.displayState.renderScaleTarget));
            renderScaleWidget.label.textContent = 'Resolution (mesh)';
            parent.appendChild(renderScaleWidget.element);
          }
          const objectAlphaWidget =
              refCounted.registerDisposer(new RangeWidget(this.layer.displayState.objectAlpha));
          objectAlphaWidget.promptElement.textContent = 'Opacity (3d)';
          parent.appendChild(objectAlphaWidget.element);
          const silhouetteWidget = refCounted.registerDisposer(new RangeWidget(
              this.layer.displayState.silhouetteRendering,
              {min: 0, max: maxSilhouettePower, step: 0.1}));
          silhouetteWidget.promptElement.textContent = 'Silhouette (3d)';
          silhouetteWidget.element.title =
              'Set to a non-zero value to increase transparency of object faces perpendicular to view direction';
          parent.appendChild(silhouetteWidget.element);
        }, this.visibility));
    element.appendChild(controls3d.element);

    {
      const checkbox = this.registerDisposer(
          new TrackableBooleanCheckbox(this.layer.displayState.hideSegmentZero));
      checkbox.element.className =
          'neuroglancer-segmentation-dropdown-hide-segment-zero neuroglancer-noselect';
      const label = document.createElement('label');
      label.className =
          'neuroglancer-segmentation-dropdown-hide-segment-zero neuroglancer-noselect';
      label.appendChild(document.createTextNode('Hide segment ID 0'));
      label.appendChild(checkbox.element);
      element.appendChild(label);
    }

    {
      const checkbox = this.registerDisposer(
          new TrackableBooleanCheckbox(layer.displayState.ignoreNullVisibleSet));
      checkbox.element.className = 'neuroglancer-noselect';
      const label = document.createElement('label');
      label.className = 'neuroglancer-noselect';
      label.appendChild(document.createTextNode('Show all segments if none selected'));
      label.appendChild(checkbox.element);
      element.appendChild(label);
    }

    const skeletonControls = this.registerDisposer(new DependentViewWidget(
        layer.hasSkeletonsLayer, (hasSkeletonsLayer, parent, refCounted) => {
          if (!hasSkeletonsLayer) return;
          const addViewSpecificSkeletonRenderingControls =
              (options: ViewSpecificSkeletonRenderingOptions, viewName: string) => {
                {
                  const widget = refCounted.registerDisposer(new EnumSelectWidget(options.mode));
                  const label = document.createElement('label');
                  label.className =
                      'neuroglancer-segmentation-dropdown-skeleton-render-mode neuroglancer-noselect';
                  label.appendChild(document.createTextNode(`Skeleton mode (${viewName})`));
                  label.appendChild(widget.element);
                  parent.appendChild(label);
                }
                {
                  const widget = this.registerDisposer(
                      new RangeWidget(options.lineWidth, {min: 1, max: 40, step: 1}));
                  widget.promptElement.textContent = `Skeleton line width (${viewName})`;
                  parent.appendChild(widget.element);
                }
              };
          addViewSpecificSkeletonRenderingControls(
              layer.displayState.skeletonRenderingOptions.params2d, '2d');
          addViewSpecificSkeletonRenderingControls(
              layer.displayState.skeletonRenderingOptions.params3d, '3d');
          let topRow = document.createElement('div');
          topRow.className = 'neuroglancer-segmentation-dropdown-skeleton-shader-header';
          let label = document.createElement('div');
          label.style.flex = '1';
          label.textContent = 'Skeleton shader:';
          topRow.appendChild(label);
          topRow.appendChild(makeMaximizeButton({
            title: 'Show larger editor view',
            onClick: () => {
              new ShaderCodeOverlay(this.layer);
            }
          }));
          topRow.appendChild(makeHelpButton({
            title: 'Documentation on skeleton rendering',
            href:
                'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md',
          }));
          parent.appendChild(topRow);

          const codeWidget = refCounted.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
          parent.appendChild(codeWidget.element);
          parent.appendChild(refCounted
                                 .registerDisposer(new ShaderControls(
                                     layer.displayState.skeletonRenderingOptions.shaderControlState,
                                     this.layer.manager.root.display, {
                                       visibility: this.visibility,
                                     }))
                                 .element);
          codeWidget.textEditor.refresh();
        }, this.visibility));
    element.appendChild(skeletonControls.element);
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
  constructor(public layer: SegmentationUserLayer) {
    super();
    this.content.classList.add('neuroglancer-segmentation-layer-skeleton-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}
