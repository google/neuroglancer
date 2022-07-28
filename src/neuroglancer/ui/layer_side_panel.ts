/**
 * @license
 * Copyright 2018 Google Inc.
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

/**
 * @file Side panel for displaying/editing layer details.
 */

import 'neuroglancer/ui/layer_side_panel.css';

import svg_cursor from 'ikonate/icons/cursor.svg';
import {changeLayerName, changeLayerType, deleteLayer, layerTypes, ManagedUserLayer, SelectedLayerState, UserLayer} from 'neuroglancer/layer';
import {ElementVisibilityFromTrackableBoolean} from 'neuroglancer/trackable_boolean';
import {CachedWatchableValue, observeWatchable} from 'neuroglancer/trackable_value';
import {LAYER_SIDE_PANEL_DEFAULT_LOCATION, UserLayerSidePanelState} from 'neuroglancer/ui//layer_side_panel_state';
import {popDragStatus, pushDragStatus} from 'neuroglancer/ui/drag_and_drop';
import {DRAG_OVER_CLASSNAME, DragSource, SidePanel, SidePanelManager} from 'neuroglancer/ui/side_panel';
import {RefCounted} from 'neuroglancer/util/disposable';
import {KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {EventActionMap} from 'neuroglancer/util/mouse_bindings';
import {CheckboxIcon} from 'neuroglancer/widget/checkbox_icon';
import {makeDeleteButton} from 'neuroglancer/widget/delete_button';
import {TabView} from 'neuroglancer/widget/tab_view';

const layerNameInputEventMap = EventActionMap.fromObject({
  'escape': {action: 'cancel'},
});

export class LayerNameWidget extends RefCounted {
  element = document.createElement('input');
  constructor(public layer: ManagedUserLayer) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-layer-side-panel-name');
    element.spellcheck = false;
    element.autocomplete = 'off';
    const keyboardHandler =
        this.registerDisposer(new KeyboardEventBinder(element, layerNameInputEventMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    registerActionListener(element, 'cancel', event => {
      this.updateView();
      element.blur();
      event.stopPropagation();
      event.preventDefault();
    });
    element.title = 'Rename layer';
    this.registerDisposer(layer.layerChanged.add(() => this.updateView()));
    element.addEventListener('change', () => this.updateModel());
    element.addEventListener('blur', () => this.updateModel());
    this.updateView();
  }

  private updateView() {
    this.element.value = this.layer.name;
  }

  private updateModel() {
    changeLayerName(this.layer, this.element.value);
  }
}

export class LayerTypeWidget extends RefCounted {
  element = document.createElement('select');
  private measureElement = document.createElement('div');
  constructor(public layer: UserLayer) {
    super();
    const {element, measureElement} = this;
    element.classList.add('neuroglancer-layer-side-panel-type');
    measureElement.classList.add('neuroglancer-layer-side-panel-type-measure');
    element.title = 'Change layer type';
    document.body.appendChild(measureElement);
    for (const [layerType, layerConstructor] of layerTypes) {
      if (layerConstructor.type !== layerType) continue;
      const option = document.createElement('option');
      option.textContent = layerConstructor.typeAbbreviation;
      option.value = layerType;
      element.appendChild(option);
    }
    element.addEventListener('change', () => {
      const newType = element.value;
      const layerConstructor = layerTypes.get(newType)!;
      changeLayerType(this.layer.managedLayer, layerConstructor);
    });
    this.updateView();
  }

  private updateView() {
    const selectedName = this.layer.type;
    const {element, measureElement} = this;
    measureElement.textContent = (this.layer.constructor as typeof UserLayer).typeAbbreviation;
    element.value = selectedName;
    element.style.width = `${measureElement.offsetWidth}px`;
  }

  disposed() {
    this.measureElement.remove();
  }
}

class LayerSidePanel extends SidePanel {
  tabView: TabView;
  layer: UserLayer;
  constructor(sidePanelManager: SidePanelManager, public panelState: UserLayerSidePanelState) {
    super(sidePanelManager, panelState.location);
    const layer = this.layer = panelState.layer;
    const {element} = this;
    const {titleBar} = this.addTitleBar({});
    titleBar.classList.add('neuroglancer-layer-side-panel-title');
    titleBar.appendChild(this.registerDisposer(new LayerTypeWidget(layer)).element);
    titleBar.appendChild(this.registerDisposer(new LayerNameWidget(layer.managedLayer)).element);
    this.registerDisposer(observeWatchable(visible => {
      element.dataset.neuroglancerLayerVisible = visible.toString();
    }, {
      get value() {
        return layer.managedLayer.visible;
      },
      changed: layer.managedLayer.layerChanged,
    }));
    const pickButton = this.registerDisposer(new CheckboxIcon(
        {
          get value() {
            return layer.managedLayer.pickEnabled;
          },
          set value(value: boolean) {
            layer.managedLayer.pickEnabled = value;
          },
          changed: layer.managedLayer.layerChanged,
        },
        {
          svg: svg_cursor,
          enableTitle: 'Spatial object selection: disabled',
          disableTitle: 'Spatial object selection: enabled'
        }));
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        {
          get value() {
            return layer.managedLayer.supportsPickOption;
          },
          changed: layer.managedLayer.layerChanged,
        },
        pickButton.element));
    titleBar.appendChild(pickButton.element);
    const pinWatchable = {
      get value() {
        return panelState !== layer.panels.panels[0];
      },
      set value(value: boolean) {
        if (value) {
          panelState.pin();
        } else {
          panelState.unpin();
        }
      },
      changed: layer.manager.root.layerManager.layersChanged,
    };
    titleBar.appendChild(this.registerDisposer(new CheckboxIcon(pinWatchable, {
                               // Note: \ufe0e forces text display, as otherwise the pin icon
                               // may as an emoji with color.
                               text: '📌\ufe0e',
                               enableTitle: 'Pin panel to this layer',
                               disableTitle: 'Unpin panel to this layer',
                             }))
                             .element);
    this.registerDisposer(observeWatchable(pinned => {
      element.dataset.neuroglancerLayerPanelPinned = pinned.toString();
    }, pinWatchable));
    titleBar.appendChild(makeDeleteButton({
      title: 'Delete layer',
      onClick: () => {
        deleteLayer(this.layer.managedLayer);
      }
    }));
    this.tabView = new TabView(
        {
          makeTab: id => layer.tabs.options.get(id)!.getter(),
          selectedTab: panelState.selectedTab,
          tabs: this.registerDisposer(new CachedWatchableValue({
            get value() {
              return panelState.tabs.map(id => {
                const {label, hidden} = layer.tabs.options.get(id)!;
                return {
                  id,
                  label,
                  hidden: hidden?.value || false,
                }});
            },
            changed: panelState.tabsChanged,
          })),
          handleTabElement: (id: string, element: HTMLElement) => {
            element.draggable = true;
            element.addEventListener('dragstart', (event: DragEvent) => {
              event.stopPropagation();
              event.dataTransfer!.setData('neuroglancer-side-panel', '');
              let message =
                  'Drag tab to dock as new panel to the left/right/top/bottom of another panel';
              const hasOtherPanel =
                  panelState.panels.panels.find(p => p !== panelState && p.location.visible);
              if (hasOtherPanel) {
                message +=
                    `, or move tab to other ${JSON.stringify(layer.managedLayer.name)} panel`;
              }
              pushDragStatus(element, 'drag', message);
              this.sidePanelManager.startDrag(
                  {
                    dropAsNewPanel: location => {
                      this.panelState.splitOffTab(
                          id, {...LAYER_SIDE_PANEL_DEFAULT_LOCATION, ...location});
                    },
                    canDropAsTabs: target => {
                      if ((target instanceof LayerSidePanel) && target.layer === this.layer &&
                          target !== this) {
                        return 1;
                      }
                      return 0;
                    },
                    dropAsTab: target => {
                      this.panelState.moveTabTo(id, (target as LayerSidePanel).panelState);
                    },
                  },
                  event);
            });
            element.addEventListener('dragend', (event: DragEvent) => {
              event;
              popDragStatus(element, 'drag');
              this.sidePanelManager.endDrag();
            });
          },
        },
        this.visibility);
    this.tabView.element.style.flex = '1';
    this.tabView.element.classList.add('neuroglancer-layer-side-panel-tab-view');
    this.tabView.element.style.position = 'relative';
    this.tabView.element.appendChild(this.makeTabDropZone());
    this.addBody(this.tabView.element);

    // Hide panel automatically if there are no tabs to display (because they have all been moved to
    // another panel).
    this.registerDisposer(panelState.tabsChanged.add(() => {
      if (panelState.tabs.length === 0) {
        this.location.visible = false;
      }
    }));
  }

  makeDragSource(): DragSource {
    return {
      ...super.makeDragSource(),
      canDropAsTabs: target => {
        if ((target instanceof LayerSidePanel) && target.layer === this.layer && target !== this) {
          return this.panelState.tabs.length;
        }
        return 0;
      },
      dropAsTab: target => {
        this.panelState.mergeInto((target as LayerSidePanel).panelState);
      },
    };
  }

  private makeTabDropZone() {
    const element = document.createElement('div');
    element.className = 'neuroglancer-side-panel-drop-zone';
    element.style.position = 'absolute';
    element.style.left = '20px';
    element.style.right = '20px';
    element.style.bottom = '20px';
    element.style.top = '20px';
    element.addEventListener('dragenter', event => {
      const {dragSource} = this.sidePanelManager;
      const numTabs = dragSource?.canDropAsTabs?.(this);
      if (!numTabs) return;
      element.classList.add(DRAG_OVER_CLASSNAME);
      pushDragStatus(
          element, 'drop', `Move ${numTabs} ${numTabs === 1 ? 'tab' : 'tabs'} to this panel`);
      event.preventDefault();
    });
    element.addEventListener('dragleave', () => {
      popDragStatus(element, 'drop');
      element.classList.remove(DRAG_OVER_CLASSNAME);
    });
    element.addEventListener('dragover', event => {
      const {dragSource} = this.sidePanelManager;
      if (!dragSource?.canDropAsTabs?.(this)) return;
      event.preventDefault();
    });
    element.addEventListener('drop', event => {
      popDragStatus(element, 'drop');
      const {dragSource} = this.sidePanelManager;
      if (!dragSource?.canDropAsTabs?.(this)) return;
      element.classList.remove(DRAG_OVER_CLASSNAME);
      dragSource.dropAsTab!(this);
      event.preventDefault();
      event.stopPropagation();
    });
    return element;
  }
}

export class LayerSidePanelManager extends RefCounted {
  placeholderSelectedLayerPanel: (() => void)|undefined;
  layerSidePanels =
      new Map<UserLayerSidePanelState, {generation: number, unregister: (() => void)}>();
  private generation = 0;
  private layersNeedUpdate = true;
  constructor(
      public sidePanelManager: SidePanelManager, public selectedLayerState: SelectedLayerState) {
    super();
    const handleUpdate = () => {
      this.layersNeedUpdate = true;
      this.sidePanelManager.display.scheduleRedraw();
    };
    this.registerDisposer(selectedLayerState.changed.add(handleUpdate));
    this.registerDisposer(selectedLayerState.layerManager.layersChanged.add(handleUpdate));
    this.registerDisposer(sidePanelManager.beforeRender.add(() => this.update()));
  }

  private getSelectedUserLayer() {
    return this.selectedLayerState.layer?.layer ?? undefined;
  }

  private update() {
    if (!this.layersNeedUpdate) return;
    const {layerManager} = this.selectedLayerState;
    let generation = ++this.generation;
    this.layersNeedUpdate = false;
    const {layerSidePanels} = this;

    const ensurePanel = (panelState: UserLayerSidePanelState) => {
      let existing = layerSidePanels.get(panelState);
      if (existing === undefined) {
        existing = {
          generation,
          unregister: this.sidePanelManager.registerPanel({
            location: panelState.location,
            makePanel: () => new LayerSidePanel(this.sidePanelManager, panelState)
          })
        };
        layerSidePanels.set(panelState, existing);
      } else {
        existing.generation = generation;
      }
    };
    // Add selected layer panel
    {
      const layer = this.getSelectedUserLayer();
      const {location} = this.selectedLayerState;
      if (layer === undefined || !location.visible) {
        if (this.placeholderSelectedLayerPanel === undefined) {
          this.placeholderSelectedLayerPanel = this.sidePanelManager.registerPanel(
              {location, makePanel: () => new SidePanel(this.sidePanelManager, location)});
        }
      } else {
        this.placeholderSelectedLayerPanel?.();
        this.placeholderSelectedLayerPanel = undefined;
        const panelState = layer.panels.panels[0];
        panelState.location.value = location.value;
        ensurePanel(panelState);
      }
    }

    // Add extra layer panels
    for (const layer of layerManager.managedLayers) {
      const userLayer = layer.layer;
      if (userLayer === null) continue;
      const {panels} = userLayer.panels;
      for (let i = 1, length = panels.length; i < length; ++i) {
        ensurePanel(panels[i]);
      }
    }
    for (const [panelState, existing] of layerSidePanels) {
      if (existing.generation === generation) continue;
      existing.unregister();
      layerSidePanels.delete(panelState);
    }
  }

  disposed() {
    this.placeholderSelectedLayerPanel?.();
    for (const {unregister} of this.layerSidePanels.values()) {
      unregister();
    }
  }
}
