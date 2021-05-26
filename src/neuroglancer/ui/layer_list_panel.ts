/**
 * @license
 * Copyright 2021 Google Inc.
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

import './layer_list_panel.css';

import svg_controls_alt from 'ikonate/icons/controls-alt.svg';
import svg_eye_crossed from 'ikonate/icons/eye-crossed.svg';
import svg_eye from 'ikonate/icons/eye.svg';
import {deleteLayer, LayerManager, ManagedUserLayer, TopLevelLayerListSpecification} from 'neuroglancer/layer';
import {TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {DropLayers, registerLayerBarDragLeaveHandler, registerLayerBarDropHandlers, registerLayerDragHandlers} from 'neuroglancer/ui/layer_drag_and_drop';
import {LayerNameWidget} from 'neuroglancer/ui/layer_side_panel';
import {SidePanel, SidePanelManager} from 'neuroglancer/ui/side_panel';
import {DEFAULT_SIDE_PANEL_LOCATION, SidePanelLocation, TrackableSidePanelLocation} from 'neuroglancer/ui/side_panel_location';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {RefCounted} from 'neuroglancer/util/disposable';
import {updateChildren} from 'neuroglancer/util/dom';
import {emptyToUndefined} from 'neuroglancer/util/json';
import {Trackable} from 'neuroglancer/util/trackable';
import {makeDeleteButton} from 'neuroglancer/widget/delete_button';
import {makeIcon} from 'neuroglancer/widget/icon';

import {CheckboxIcon} from '../widget/checkbox_icon';

const DEFAULT_LAYER_LIST_PANEL_LOCATION: SidePanelLocation = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: 'left',
  row: 0,
};

export class LayerListPanelState implements Trackable {
  location = new TrackableSidePanelLocation(DEFAULT_LAYER_LIST_PANEL_LOCATION);
  get changed() {
    return this.location.changed;
  }

  restoreState(obj: unknown) {
    if (obj === undefined) return;
    this.location.restoreState(obj);
  }
  reset() {
    this.location.reset();
  }
  toJSON() {
    return emptyToUndefined(this.location.toJSON());
  }
}

class LayerVisibilityWidget extends RefCounted {
  element = document.createElement('div');
  constructor(public layer: ManagedUserLayer) {
    super();
    const {element} = this;
    const hideIcon = makeIcon({
      svg: svg_eye,
      title: 'Hide layer',
      onClick: () => {
        this.layer.setVisible(false);
      }
    });
    const showIcon = makeIcon({
      svg: svg_eye_crossed,
      title: 'Show layer',
      onClick: () => {
        this.layer.setVisible(true);
      }
    });
    element.appendChild(showIcon);
    element.appendChild(hideIcon);
    const updateView = () => {
      const visible = this.layer.visible;
      hideIcon.style.display = visible ? '' : 'none';
      showIcon.style.display = !visible ? '' : 'none';
    };
    updateView();
    this.registerDisposer(layer.layerChanged.add(updateView));
  }
}

function makeSelectedLayerSidePanelCheckboxIcon(layer: ManagedUserLayer) {
  const {selectedLayer} = layer.manager.root;
  const icon = new CheckboxIcon(
      {
        get value() {
          return selectedLayer.layer === layer && selectedLayer.visible;
        },
        set value(value: boolean) {
          if (value) {
            selectedLayer.layer = layer;
            selectedLayer.visible = true;
          } else {
            selectedLayer.visible = false;
          }
        },
        changed: selectedLayer.changed,
      },
      {
        backgroundScheme: 'dark',
        enableTitle: 'Show layer side panel',
        disableTitle: 'Hide layer side panel',
        svg: svg_controls_alt,
      });
  icon.element.classList.add('neuroglancer-layer-list-panel-item-controls');
  return icon;
}

class LayerListItem extends RefCounted {
  element = document.createElement('div');
  numberElement = document.createElement('div');
  generation = -1;
  constructor(public panel: LayerListPanel, public layer: ManagedUserLayer) {
    super();
    const {element, numberElement} = this;
    element.classList.add('neuroglancer-layer-list-panel-item');
    numberElement.classList.add('neuroglancer-layer-list-panel-item-number');
    element.appendChild(
        this
            .registerDisposer(new TrackableBooleanCheckbox(
                {
                  get value() {
                    return !layer.archived;
                  },
                  set value(value: boolean) {
                    layer.setArchived(!value);
                  },
                  changed: layer.layerChanged,
                },
                {
                  enableTitle: 'Archive layer (disable and remove from layer groups)',
                  disableTitle: 'Unarchive layer (enable and add to all layer groups)'
                }))
            .element);
    element.appendChild(numberElement);
    element.appendChild(this.registerDisposer(new LayerVisibilityWidget(layer)).element);
    element.appendChild(this.registerDisposer(new LayerNameWidget(layer)).element);
    element.appendChild(
        this.registerDisposer(makeSelectedLayerSidePanelCheckboxIcon(layer)).element);
    const deleteButton = makeDeleteButton({
      title: 'Delete layer',
      onClick: () => {
        deleteLayer(this.layer);
      }
    });
    deleteButton.classList.add('neuroglancer-layer-list-panel-item-delete');
    element.appendChild(deleteButton);
    registerLayerDragHandlers(
        panel, element, layer, {isLayerListPanel: true, getLayoutSpec: () => undefined});
    registerLayerBarDropHandlers(panel, element, layer, /*allowArchived=*/ true);

    element.addEventListener('click', (event: MouseEvent) => {
      if (event.ctrlKey) {
        panel.selectedLayer.toggle(layer);
        event.preventDefault();
      } else if (event.altKey) {
        layer.pickEnabled = !layer.pickEnabled;
        event.preventDefault();
      }
    });

    element.addEventListener('contextmenu', (event: MouseEvent) => {
      panel.selectedLayer.toggle(layer);
      event.stopPropagation();
      event.preventDefault();
    });
  }
}

export class LayerListPanel extends SidePanel {
  private items = new Map<ManagedUserLayer, LayerListItem>();
  itemContainer = document.createElement('div');
  layerDropZone = document.createElement('div');
  titleElement: HTMLElement;
  get layerManager() {
    return this.manager.layerManager;
  }
  get selectedLayer() {
    return this.manager.selectedLayer;
  }
  dropLayers: DropLayers|undefined;
  dragEnterCount = 0;
  private generation = -1;
  constructor(
      sidePanelManager: SidePanelManager, public manager: TopLevelLayerListSpecification,
      public state: LayerListPanelState) {
    super(sidePanelManager, state.location);
    const {itemContainer, layerDropZone} = this;
    const {titleElement} = this.addTitleBar({title: ''});
    this.titleElement = titleElement!;
    itemContainer.classList.add('neuroglancer-layer-list-panel-items');
    this.addBody(itemContainer);
    layerDropZone.style.flex = '1';
    const debouncedUpdateView =
        this.registerCancellable(animationFrameDebounce(() => this.render()));
    this.visibility.changed.add(debouncedUpdateView);
    this.registerDisposer(this.layerManager.layersChanged.add(debouncedUpdateView));
    this.registerDisposer(this.selectedLayer.changed.add(debouncedUpdateView));
    registerLayerBarDragLeaveHandler(this);
    registerLayerBarDropHandlers(this, layerDropZone, undefined, /*allowArchived=*/ true);
    this.render();
  }

  render() {
    const self = this;
    const selectedLayer = this.selectedLayer.layer;
    const generation = ++this.generation;
    let numVisible = 0;
    let numHidden = 0;
    let numArchived = 0;
    this.layerManager.updateNonArchivedLayerIndices();
    function* getItems() {
      const {items} = self;
      let numNonArchivedLayers = 0;
      for (const layer of self.layerManager.managedLayers) {
        if (!layer.archived) ++numNonArchivedLayers;
      }
      const numberElementWidth = `${(numNonArchivedLayers + 1).toString().length}ch`;
      for (const layer of self.layerManager.managedLayers) {
        if (layer.visible) {
          ++numVisible;
        } else if (!layer.archived) {
          ++numHidden;
        } else {
          ++numArchived;
        }
        let item = items.get(layer);
        if (item === undefined) {
          item = self.registerDisposer(new LayerListItem(self, layer));
          items.set(layer, item);
          item.generation = generation;
        } else {
          item.generation = generation;
        }
        const {nonArchivedLayerIndex} = layer;
        item.numberElement.style.width = numberElementWidth;
        if (nonArchivedLayerIndex === -1) {
          item.numberElement.style.visibility = 'hidden';
        } else {
          item.numberElement.style.visibility = '';
          item.numberElement.textContent = `${nonArchivedLayerIndex+1}`;
        }
        item.element.dataset.selected = (layer === selectedLayer).toString();
        item.element.dataset.archived = (layer.archived).toString();
        yield item.element;
      }
      for (const [userLayer, item] of items) {
        if (generation !== item.generation) {
          items.delete(userLayer);
          self.unregisterDisposer(item);
          item.dispose();
        }
      }
      yield self.layerDropZone;
    }
    updateChildren(this.itemContainer, getItems());
    let title = 'Layers';
    if (numVisible || numHidden || numArchived) {
      title += ' (';
      let sep = '';
      if (numVisible + numHidden) {
        title += `${numVisible}/${numHidden + numVisible} visible`;
        sep = ', ';
      }
      if (numArchived) {
        title += `${sep}${numArchived} archived`;
      }
      title += ')';
    }
    this.titleElement.textContent = title;
  }
}

export class LayerArchiveCountWidget extends RefCounted {
  element = document.createElement('div');
  constructor(public layerManager: LayerManager) {
    super();
    const debouncedRender = this.registerCancellable(animationFrameDebounce(() => this.render()));
    this.registerDisposer(layerManager.layersChanged.add(debouncedRender));
    this.render();
  }

  private render() {
    let numArchived = 0;
    const {managedLayers} = this.layerManager;
    for (const layer of managedLayers) {
      if (layer.archived) ++numArchived;
    }
    const {element} = this;
    if (numArchived !== 0) {
      const numLayers = managedLayers.length;
      element.textContent = `${numLayers - numArchived}/${numLayers}`;
    } else {
      element.textContent = '';
    }
  }
}
