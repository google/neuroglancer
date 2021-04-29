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

import {UserLayer} from 'neuroglancer/layer';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {DEFAULT_SIDE_PANEL_LOCATION, SidePanelLocation, TrackableSidePanelLocation} from 'neuroglancer/ui/side_panel_location';
import {arraysEqual} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {parseArray, verifyObject, verifyOptionalObjectProperty, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';

const TAB_JSON_KEY = 'tab';
const TABS_JSON_KEY = 'tabs';
const PANELS_JSON_KEY = 'panels';

export const SELECTED_LAYER_SIDE_PANEL_DEFAULT_LOCATION = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  row: 0,
};
export const LAYER_SIDE_PANEL_DEFAULT_LOCATION = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  visible: true,
  row: 0,
};

export class UserLayerSidePanelState extends RefCounted {
  layer = this.panels.layer;
  location = new TrackableSidePanelLocation(LAYER_SIDE_PANEL_DEFAULT_LOCATION);
  constructor(public panels: UserLayerSidePanelsState) {
    super();
  }

  initialize() {
    const {panels} = this;
    this.tabsChanged.add(panels.specificationChanged.dispatch);
    this.selectedTab.changed.add(panels.specificationChanged.dispatch);
    this.location.changed.add(() => {
      panels.specificationChanged.dispatch();
      const {layer} = this;
      const {selectedLayer} = layer.manager.root;
      if (selectedLayer.layer?.layer !== layer) return;
      if (this !== layer.panels.panels[0]) return;
      const curLocation = this.location.value;
      if (selectedLayer.location.value !== curLocation) {
        selectedLayer.location.value = curLocation;
        selectedLayer.location.locationChanged.dispatch();
      }
    });
    this.location.locationChanged.add(() => {
      if (this.location.visible) return;
      if (this === this.panels.panels[0]) return;
      this.panels.removePanel(this);
    });
  }
  tabsChanged = new Signal();
  selectedTab = new WatchableValue<string|undefined>(undefined);
  explicitTabs: Set<string>|undefined;
  tabs: string[] = [];

  normalizeTabs() {
    const {tabs} = this;
    if (tabs.length === 0) {
      this.selectedTab.value = undefined;
      return;
    }
    const layerTabs = this.layer.tabs.options;
    const getOrder = (tab: string) => layerTabs.get(tab)!.order ?? 0;
    tabs.sort((a, b) => getOrder(a) - getOrder(b));
    const {selectedTab} = this;
    const selectedTabValue = selectedTab.value;
    if (selectedTabValue === undefined || !tabs.includes(selectedTabValue)) {
      selectedTab.value = tabs[0];
    }
  }

  pin() {
    // "Pin" this panel, which means converting it from the selected layer panel to an extra panel.
    const {layer} = this;
    const {selectedLayer} = layer.manager.root;
    // Check that this is the selected layer panel.
    if (selectedLayer.layer?.layer !== layer) return;
    if (this !== layer.panels.panels[0]) return;
    if (this.tabs.length === 0) return;
    const {panels} = this;
    const newPanel = layer.registerDisposer(new UserLayerSidePanelState(panels));
    panels.panels.splice(0, 1, newPanel);
    panels.panels.push(this);
    panels.updateTabs();
    newPanel.initialize();
    selectedLayer.layerManager.layersChanged.dispatch();
    this.panels.specificationChanged.dispatch();
  }

  unpin() {
    // "Unpin" this panel, which means pinning the current selected layer panel, if any, and making
    // this panel the selected layer panel.
    const {panels} = this;
    const panelIndex = panels.panels.indexOf(this);
    if (panelIndex === -1 || panelIndex === 0) return;
    const {layer} = this;
    const {selectedLayer} = layer.manager.root;
    const selectedUserLayer = selectedLayer.layer?.layer;
    if (selectedLayer.visible && selectedUserLayer != null && selectedUserLayer != layer) {
      const prevSelectedLayerPanel = selectedUserLayer.panels.panels[0];
      prevSelectedLayerPanel.pin();
    }
    panels.panels.splice(panelIndex, 1);
    const [origSelectedPanel] = panels.panels.splice(0, 1, this);
    if (this.explicitTabs === undefined) {
      // This layer will contain all remaining tabs.  The old selected layer panel should be
      // removed, as otherwise `updateTabs` will incorrectly assign it all tabs.
      layer.unregisterDisposer(origSelectedPanel);
    } else {
      panels.panels.push(origSelectedPanel);
      // This layer will contain only the explicit tabs.  All other extra layers must be set to have
      // explicit tabs as well, as otherwise `updateTabs` will assign all tabs to them.
      for (let i = 1, length = panels.panels.length; i < length; ++i) {
        const panel = panels.panels[i];
        if (panel.explicitTabs === undefined) {
          panel.explicitTabs = new Set(panel.tabs);
        }
      }
    }
    this.explicitTabs = undefined;
    panels.updateTabs();
    selectedLayer.layer = layer.managedLayer;
    selectedLayer.location.value = this.location.value;
    selectedLayer.location.locationChanged.dispatch();
    selectedLayer.layerManager.layersChanged.dispatch();
    this.panels.specificationChanged.dispatch();
  }

  splitOffTab(tab: string, location: SidePanelLocation) {
    // Move the specified tab to a new panel.
    if (!this.tabs.includes(tab)) return;
    const {panels} = this;
    {
      const {explicitTabs} = this;
      if (explicitTabs !== undefined) {
        explicitTabs.delete(tab);
      }
    }
    const {layer} = this;
    const newPanel = layer.registerDisposer(new UserLayerSidePanelState(panels));
    newPanel.location.value = location;
    newPanel.explicitTabs = new Set([tab]);
    panels.panels.splice(1, 0, newPanel);
    panels.updateTabs();
    newPanel.initialize();
    layer.manager.root.layerManager.layersChanged.dispatch();
    panels.specificationChanged.dispatch();
  }

  moveTabTo(tab: string, target: UserLayerSidePanelState) {
    if (!this.tabs.includes(tab)) return;
    {
      const {explicitTabs} = this;
      if (explicitTabs !== undefined) {
        explicitTabs.delete(tab);
      }
    }
    {
      const {explicitTabs} = target;
      if (explicitTabs !== undefined) {
        explicitTabs.add(tab);
      }
    }
    const {panels} = this;
    panels.updateTabs();
    target.selectedTab.value = tab;
    panels.specificationChanged.dispatch();
  }

  mergeInto(target: UserLayerSidePanelState) {
    const {explicitTabs} = target;
    if (explicitTabs !== undefined) {
      for (const tab of this.tabs) {
        explicitTabs.add(tab);
      }
    }
    const {panels} = this;
    panels.removePanel(this);
  }
}

export class UserLayerSidePanelsState {
  panels: UserLayerSidePanelState[];
  specificationChanged = new Signal();
  updating = false;
  constructor(public layer: UserLayer) {
    this.panels = [layer.registerDisposer(new UserLayerSidePanelState(this))];
  }

  restoreState(obj: unknown) {
    const {panels} = this;
    panels[0].selectedTab.value = verifyOptionalObjectProperty(obj, TAB_JSON_KEY, verifyString);
    const {layer} = this;
    const {tabs} = layer;
    const availableTabs = new Set<string>(tabs.options.keys());
    verifyOptionalObjectProperty(
        obj, PANELS_JSON_KEY,
        panelsObj => parseArray(panelsObj, panelObj => {
          verifyObject(panelObj);
          const panel = new UserLayerSidePanelState(this);
          panel.location.restoreState(panelObj);
          if (!panel.location.visible) return;
          panel.selectedTab.value =
              verifyOptionalObjectProperty(panelObj, TAB_JSON_KEY, verifyString);
          panel.explicitTabs = verifyOptionalObjectProperty(panelObj, TABS_JSON_KEY, tabsObj => {
            const curTabs = new Set<string>();
            for (const tab of verifyStringArray(tabsObj)) {
              if (!availableTabs.has(tab)) continue;
              availableTabs.delete(tab);
              curTabs.add(tab);
            }
            return curTabs;
          });
          if (panel.explicitTabs === undefined) {
            panel.tabs = Array.from(availableTabs);
            availableTabs.clear();
          } else {
            panel.tabs = Array.from(panel.explicitTabs);
          }
          if (panel.tabs.length === 0) return;
          panel.normalizeTabs();
          layer.registerDisposer(panel);
          panel.initialize();
          panels.push(panel);
        }));
    panels[0].tabs = Array.from(availableTabs);
    panels[0].normalizeTabs();
    this.panels[0].initialize();
  }

  removePanel(panel: UserLayerSidePanelState) {
    if (this.updating) return;
    const i = this.panels.indexOf(panel);
    this.panels.splice(i, 1);
    this.layer.unregisterDisposer(panel);
    this.updateTabs();
  }

  updateTabs() {
    const {layer} = this;
    const {tabs} = layer;
    const availableTabs = new Set<string>(tabs.options.keys());
    const {panels} = this;
    this.updating = true;
    const updatePanelTabs = (panel: UserLayerSidePanelState) => {
      const oldTabs = panel.tabs;
      if (panel.explicitTabs === undefined) {
        panel.tabs = Array.from(availableTabs);
        availableTabs.clear();
      } else {
        panel.tabs = Array.from(panel.explicitTabs);
        for (const tab of panel.tabs) {
          availableTabs.delete(tab);
        }
      }
      if (!arraysEqual(oldTabs, panel.tabs)) {
        panel.normalizeTabs();
        panel.tabsChanged.dispatch();
      }
    };
    for (let i = 1; i < panels.length;) {
      const panel = panels[i];
      if (panel.location.visible) {
        updatePanelTabs(panel);
        if (panel.tabs.length !== 0) {
          ++i;
          continue;
        }
      }
      panels.splice(i, 1);
      layer.unregisterDisposer(panel);
    }
    updatePanelTabs(panels[0]);
    if (panels[0].tabs.length === 0) {
      const {selectedLayer} = this.layer.manager.root;
      if (selectedLayer.layer?.layer === this.layer) {
        selectedLayer.location.visible = false;
      }
    }
    this.updating = false;
  }

  toJSON() {
    const {panels} = this;
    const obj: any = {};
    obj[TAB_JSON_KEY] = panels[0].selectedTab.value;
    if (panels.length > 1) {
      const panelsObj: any[] = [];
      for (let i = 1, numPanels = panels.length; i < numPanels; ++i) {
        const panel = panels[i];
        const panelObj = panel.location.toJSON() ?? {};
        panelObj[TAB_JSON_KEY] = panel.selectedTab.value;
        const {explicitTabs} = panel;
        if (explicitTabs !== undefined) {
          panelObj[TABS_JSON_KEY] = Array.from(explicitTabs);
        }
        panelsObj.push(panelObj);
      }
      obj[PANELS_JSON_KEY] = panelsObj;
    }
    return obj;
  }
}
