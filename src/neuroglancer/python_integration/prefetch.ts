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
 * @file
 * Python-initiated prefetch support.
 */

import debounce from 'lodash/debounce';
import {DataSourceProviderRegistry} from 'neuroglancer/datasource';
import {DisplayContext} from 'neuroglancer/display_context';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {parseArray, verifyInt, verifyObject, verifyObjectProperty} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {DataManagementContext, Viewer, ViewerUIConfiguration} from 'neuroglancer/viewer';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';

export class PrefetchManager extends RefCounted {
  prefetchStates = new Map<string, Viewer>();
  changed = new NullarySignal();

  private specification: {state: any, priority: number}[] = [];

  constructor(
      public display: Borrowed<DisplayContext>, public dataSourceProvider: DataSourceProviderRegistry,
      public dataContext: Owned<DataManagementContext>,
      public uiConfiguration: ViewerUIConfiguration) {
    super();
    this.registerDisposer(dataContext);
  }

  private updatePrefetchStates = this.registerCancellable(debounce(() => {
    const {specification, prefetchStates} = this;
    const newStates = new Set<string>();
    for (const {state, priority} of specification) {
      const key = JSON.stringify(state);
      newStates.add(key);
      let viewer = prefetchStates.get(key);
      if (viewer === undefined) {
        viewer = this.makePrefetchState(state, priority);
        prefetchStates.set(key, viewer);
      } else {
        viewer.visibility.value = priority;
      }
    }
    for (const [key, viewer] of prefetchStates) {
      if (!newStates.has(key)) {
        prefetchStates.delete(key);
        viewer.dispose();
      }
    }
  }, 0));

  private makePrefetchState(state: any, priority: number) {
    const viewer = new Viewer(this.display, {
      showLayerDialog: false,
      resetStateWhenEmpty: false,
      dataSourceProvider: this.dataSourceProvider,
      dataContext: this.dataContext.addRef(),
      visibility: new WatchableVisibilityPriority(priority),
      uiConfiguration: this.uiConfiguration,
    });
    try {
      viewer.state.restoreState(state);
    } catch (restoreError) {
      console.log(`Error setting prefetch state: ${restoreError.message}`);
    }
    return viewer;
  }

  reset() {
    this.specification = [];
    this.changed.dispatch();
    this.updatePrefetchStates();
  }

  restoreState(obj: any) {
    this.specification = parseArray(obj, x => {
      verifyObject(x);
      const state = verifyObjectProperty(x, 'state', verifyObject);
      const priority = verifyObjectProperty(x, 'priority', y => y === undefined ? 0 : verifyInt(y));
      return {state, priority};
    });
    this.changed.dispatch();
    this.updatePrefetchStates();
  }

  toJSON() {
    const {specification} = this;
    return specification.length === 0 ? undefined : this.specification;
  }
}
