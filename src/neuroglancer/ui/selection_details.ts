/**
 * @license
 * Copyright 2020 Google Inc.
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

import './selection_details.css';

import svg_arrowLeft from 'ikonate/icons/arrow-left.svg';
import svg_arrowRight from 'ikonate/icons/arrow-right.svg';
import {SelectedLayerState, TopLevelLayerListSpecification, TrackableDataSelectionState} from 'neuroglancer/layer';
import {getDefaultSelectBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {SidePanel, SidePanelManager} from 'neuroglancer/ui/side_panel';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {Borrowed} from 'neuroglancer/util/disposable';
import {MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {CheckboxIcon} from 'neuroglancer/widget/checkbox_icon';
import {makeCopyButton} from 'neuroglancer/widget/copy_button';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';
import {makeIcon} from 'neuroglancer/widget/icon';
import {makeMoveToButton} from 'neuroglancer/widget/move_to_button';

export function isWithinSelectionPanel(element: HTMLElement) {
  return element.closest('.neuroglancer-selection-details');
}

export class SelectionDetailsPanel extends SidePanel {
  body = document.createElement('div');

  constructor(
      public sidePanelManager: SidePanelManager,
      public state: Borrowed<TrackableDataSelectionState>,
      public manager: Borrowed<TopLevelLayerListSpecification>,
      public selectedLayer: Borrowed<SelectedLayerState>) {
    super(sidePanelManager, state.location);
    const {element, body} = this;
    element.classList.add('neuroglancer-selection-details');
    this.registerDisposer(new MouseEventBinder(this.element, getDefaultSelectBindings()));

    const {titleBar} = this.addTitleBar({title: 'Selection'});
    const backButton = makeIcon({
      svg: svg_arrowLeft,
      title: 'Previous selection',
      onClick: () => {
        this.state.goBack();
      },
    });
    const forwardButton = makeIcon({
      svg: svg_arrowRight,
      title: 'Next selection',
      onClick: () => {
        this.state.goForward();
      },
    });
    titleBar.appendChild(backButton);
    titleBar.appendChild(forwardButton);
    titleBar.appendChild(
        this.registerDisposer(new CheckboxIcon(state.pin, {
              // Note: \ufe0e forces text display, as otherwise the pin icon may as an emoji with
              // color.
              text: '📌\ufe0e',
              enableTitle: 'Pin selection',
              disableTitle: 'Unpin selection',
            }))
            .element);
    body.classList.add('neuroglancer-selection-details-body');
    this.addBody(body);
    body.appendChild(
        this.registerDisposer(new DependentViewWidget(state, (stateValue, parent, context) => {
              if (!state.location.visible) return;
              backButton.style.visibility = state.canGoBack() ? 'visible' : 'hidden';
              forwardButton.style.visibility = state.canGoForward() ? 'visible' : 'hidden';
              if (stateValue === undefined) return;

              // Add position
              const {position} = stateValue;
              if (position !== undefined) {
                const positionElement = document.createElement('div');
                positionElement.classList.add('neuroglancer-selection-details-position');
                const copyButton = makeCopyButton({
                  title: 'Copy position',
                  onClick: () => {
                    setClipboard(position!.map(x => Math.floor(x)).join(', '));
                  },
                });
                positionElement.appendChild(copyButton);
                const {coordinateSpace: {rank, names}, position} = stateValue;
                for (let i = 0; i < rank; ++i) {
                  const dimElement = document.createElement('span');
                  dimElement.classList.add('neuroglancer-selection-details-position-dimension');
                  const nameElement = document.createElement('span');
                  nameElement.classList.add(
                      'neuroglancer-selection-details-position-dimension-name');
                  nameElement.textContent = names[i];
                  const coordinateElement = document.createElement('span');
                  coordinateElement.classList.add(
                      'neuroglancer-selection-details-position-dimension-coordinate');
                  coordinateElement.textContent = Math.floor(position![i]).toString();
                  dimElement.appendChild(nameElement);
                  dimElement.appendChild(coordinateElement);
                  positionElement.appendChild(dimElement);
                }
                const moveToButton = makeMoveToButton({
                  title: 'Move to position',
                  onClick: () => {
                    this.manager.globalPosition.value = position!;
                  },
                });
                positionElement.appendChild(moveToButton);
                parent.appendChild(positionElement);
              }

              for (const layerData of stateValue.layers) {
                const {layer} = layerData;
                parent.appendChild(
                    context
                        .registerDisposer(new DependentViewWidget(
                            {
                              value: undefined,
                              changed: layer.managedLayer.layerChanged,
                            },
                            (_, parent, context) => {
                              if (layer.wasDisposed) return;
                              if (!layer.isReady) {
                                return;
                              }
                              const layerBody = document.createElement('div');
                              layerBody.classList.add('neuroglancer-selection-details-layer-body');
                              if (!layer.displaySelectionState(
                                      layerData.state, layerBody, context)) {
                                return;
                              }
                              const layerElement = document.createElement('div');
                              parent.appendChild(layerElement);
                              layerElement.classList.add('neuroglancer-selection-details-layer');
                              const layerTitle = document.createElement('div');
                              layerTitle.classList.add(
                                  'neuroglancer-selection-details-layer-title');
                              layerTitle.textContent = layer.managedLayer.name;
                              layerTitle.addEventListener('click', () => {
                                this.selectedLayer.layer = layer.managedLayer;
                                this.selectedLayer.visible = true;
                              });
                              layerTitle.title = 'Click to show layer side panel';
                              layerElement.appendChild(layerTitle);
                              layerElement.appendChild(layerBody);
                            }))
                        .element);
              }
            })).element);
  }

  close() {
    super.close();
    this.state.value = undefined;
    this.state.pin.value = true;
  }
}
