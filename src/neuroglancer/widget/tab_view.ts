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
 * @file Tabbed view widget.
 */

import 'neuroglancer/widget/tab_view.css';

import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {NullarySignal, Signal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';

export class Tab extends RefCounted {
  element = document.createElement('div');

  get visible() {
    return this.visibility.visible;
  }

  constructor(public visibility = new WatchableVisibilityPriority()) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-tab-content');
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}

export class OptionSpecification<T> extends RefCounted implements Trackable {
  changed = new NullarySignal();
  options = new Map<string, T>();
  optionsChanged = new NullarySignal();

  private selectedValue: string|undefined = undefined;
  private defaultValue: string|undefined = undefined;

  get value() {
    const {selectedValue} = this;
    if (selectedValue !== undefined) {
      return selectedValue;
    }
    return this.defaultValue;
  }

  set default(value: string|undefined) {
    if (this.defaultValue !== value) {
      this.defaultValue = value;
      this.changed.dispatch();
    }
  }

  get default() {
    return this.defaultValue;
  }

  set value(value: string|undefined) {
    if (value !== undefined && this.ready_ && !this.options.has(value)) {
      value = undefined;
    }
    const {selectedValue} = this;
    if (selectedValue !== value) {
      this.selectedValue = value;
      this.changed.dispatch();
    }
  }

  get validValue() {
    const value = this.selectedValue;
    if (value === undefined || !this.options.has(value)) {
      return this.defaultValue;
    }
    return value;
  }

  add(id: string, value: T) {
    const {options} = this;
    if (options.has(id)) {
      throw new Error(`Option already defined: ${JSON.stringify(id)}.`);
    }
    options.set(id, value);
    this.optionsChanged.dispatch();
    if (this.defaultValue === undefined) {
      this.default = id;
    }
  }

  toJSON() {
    const {value, defaultValue} = this;
    if (value === defaultValue) {
      return undefined;
    }
    return value;
  }

  reset() {
    this.value = undefined;
  }

  ready_ = true;

  /**
   * When `ready` is `false`, the selected `value` may be set to an unknown option.
   */
  get ready() {
    return this.ready_;
  }

  set ready(value: boolean) {
    if (value !== this.ready_) {
      this.ready_ = value;
      if (value) {
        this.value = this.value;
      }
      this.changed.dispatch();
    }
  }

  restoreState(obj: any) {
    if (typeof obj !== 'string') {
      obj = undefined;
    }
    this.value = obj;
  }
}

export class StackView<TabId, TabType extends Tab = Tab> extends RefCounted {
  element = document.createElement('div');
  tabs = new Map<TabId, Owned<TabType>>();
  tabVisibilityChanged = new Signal<(id: TabId, visible: boolean) => void>();

  private selectedTabValue: TabId|undefined;
  private displayedTab: TabId|undefined;

  get visible() {
    return this.visibility.visible;
  }

  get selected() {
    return this.selectedTabValue;
  }

  set selected(id: TabId|undefined) {
    this.selectedTabValue = id;
    this.updateSelectedTab();
  }

  constructor(
      public getter: (id: TabId) => Owned<TabType>,
      public visibility = new WatchableVisibilityPriority()) {
    super();

    const {element} = this;
    element.className = 'neuroglancer-stack-view';
    this.registerDisposer(visibility.changed.add(() => this.updateSelectedTab()));
    this.updateSelectedTab();
  }

  invalidate(id: TabId) {
    const {tabs} = this;
    const tab = tabs.get(id);
    if (tab === undefined) {
      return;
    }
    tab.dispose();
    tabs.delete(id);
    if (id === this.displayedTab) {
      this.displayedTab = undefined;
      this.updateSelectedTab();
    }
  }

  private hideTab(id: TabId) {
    const tab = this.tabs.get(id);
    if (tab !== undefined) {
      tab.visibility.value = WatchableVisibilityPriority.IGNORED;
      tab.element.style.display = 'none';
    }
    this.tabVisibilityChanged.dispatch(id, false);
  }

  private showTab(id: TabId) {
    const {tabs} = this;
    let tab = tabs.get(id);
    if (tab === undefined) {
      tab = this.getter(id);
      this.element.appendChild(tab.element);
      tabs.set(id, tab);
    }
    tab.element.style.display = null;
    tab.visibility.value = WatchableVisibilityPriority.VISIBLE;
    this.tabVisibilityChanged.dispatch(id, true);
  }

  private updateSelectedTab() {
    const {displayedTab} = this;
    const newTab = this.visible ? this.selectedTabValue : undefined;
    if (newTab === displayedTab) {
      return;
    }
    if (displayedTab !== undefined) {
      this.hideTab(displayedTab);
    }
    this.displayedTab = newTab;
    if (newTab === undefined) {
      return;
    }
    this.showTab(newTab);
  }

  invalidateAll() {
    const {tabs} = this;
    for (const tab of tabs.values()) {
      tab.dispose();
    }
    tabs.clear();
    this.updateSelectedTab();
  }

  disposed() {
    this.selectedTabValue = undefined;
    this.invalidateAll();
    removeFromParent(this.element);
    super.disposed();
  }
}

export class TabSpecification extends
    OptionSpecification<{label: string, order?: number, getter: () => Owned<Tab>}> {}

export class TabView extends RefCounted {
  element = document.createElement('div');
  tabBar = document.createElement('div');

  private stack: StackView<string>;
  private tabLabels = new Map<string, HTMLElement>();

  private tabsGeneration = -1;

  get visible() {
    return this.visibility.visible;
  }

  constructor(
      public state: TabSpecification, public visibility = new WatchableVisibilityPriority()) {
    super();

    const {element, tabBar} = this;
    element.className = 'neuroglancer-tab-view';
    tabBar.className = 'neuroglancer-tab-view-bar';
    element.appendChild(tabBar);
    // It is important to register our visibility changed handler before the StackView registers its
    // visibility changed handler, so that tab labels are created before tabVisibilityChanged
    // signals are received.
    this.registerDisposer(visibility.changed.add(() => {
      this.updateTabs();
    }));
    const stack = this.stack = this.registerDisposer(
        new StackView<string>(id => this.state.options.get(id)!.getter(), this.visibility));
    element.appendChild(stack.element);

    this.registerDisposer(this.state.changed.add(() => this.updateSelectedTab()));
    this.registerDisposer(this.state.optionsChanged.add(() => this.updateTabs()));
    this.stack.tabVisibilityChanged.add((id, visible) => {
      const labelElement = this.tabLabels.get(id)!;
      const className = 'neuroglancer-selected-tab-label';
      if (visible) {
        labelElement.classList.add(className);
      } else {
        labelElement.classList.remove(className);
      }
    });
    this.updateTabs();
  }

  private updateTabs() {
    if (this.tabsGeneration !== this.state.optionsChanged.count) {
      this.destroyTabs();
      if (this.visible) {
        this.makeTabs();
      }
      this.updateSelectedTab();
    }
  }

  private updateSelectedTab() {
    this.stack.selected = this.state.value;
  }

  private destroyTabs() {
    if (this.tabsGeneration === -1) {
      return;
    }
    this.stack.selected = undefined;
    this.tabLabels.clear();
    removeChildren(this.tabBar);
    this.tabsGeneration = -1;
    this.stack.invalidateAll();
  }

  private makeTabs() {
    const {tabBar, tabLabels} = this;
    const optionsArray = Array.from(this.state.options);
    optionsArray.sort(([, {order: aOrder = 0}], [, {order: bOrder = 0}]) => {
      return aOrder - bOrder;
    });
    for (const [id, {label}] of optionsArray) {
      const labelElement = document.createElement('div');
      labelElement.classList.add('neuroglancer-tab-label');
      labelElement.textContent = label;
      labelElement.addEventListener('click', () => {
        this.state.value = id;
      });
      tabLabels.set(id, labelElement);
      tabBar.appendChild(labelElement);
    }
    this.tabsGeneration = this.state.optionsChanged.count;
  }

  disposed() {
    removeChildren(this.tabBar);
    this.tabLabels.clear();
    removeFromParent(this.element);
    super.disposed();
  }
}
