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

/**
 * @file
 * Sets up the Python-integrated neuroglancer viewer.
 */

import debounce from 'lodash/debounce';
import {CachingCredentialsManager} from 'neuroglancer/credentials_provider';
import {getDefaultDataSourceProvider} from 'neuroglancer/datasource/default_provider';
import {PythonDataSource} from 'neuroglancer/datasource/python/frontend';
import {TrackableBasedCredentialsManager} from 'neuroglancer/python_integration/credentials_provider';
import {TrackableBasedEventActionMap} from 'neuroglancer/python_integration/event_action_map';
import {PrefetchManager} from 'neuroglancer/python_integration/prefetch';
import {RemoteActionHandler} from 'neuroglancer/python_integration/remote_actions';
import {TrackableBasedStatusMessages} from 'neuroglancer/python_integration/remote_status_messages';
import {ScreenshotHandler} from 'neuroglancer/python_integration/screenshots';
import {ServerConnection} from 'neuroglancer/python_integration/server_connection';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {makeDefaultViewer} from 'neuroglancer/ui/default_viewer';
import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';
import {parseFixedLengthArray, verifyInt} from 'neuroglancer/util/json';
import {CompoundTrackable, Trackable} from 'neuroglancer/util/trackable';
import {InputEventBindings} from 'neuroglancer/viewer';

function makeTrackableBasedEventActionMaps(inputEventBindings: InputEventBindings) {
  const config = new CompoundTrackable();
  const globalMap = new TrackableBasedEventActionMap();
  config.add('viewer', globalMap);
  inputEventBindings.global.addParent(globalMap.eventActionMap, 1000);

  const sliceViewMap = new TrackableBasedEventActionMap();
  config.add('sliceView', sliceViewMap);
  inputEventBindings.sliceView.addParent(sliceViewMap.eventActionMap, 1000);

  const perspectiveViewMap = new TrackableBasedEventActionMap();
  config.add('perspectiveView', perspectiveViewMap);
  inputEventBindings.perspectiveView.addParent(perspectiveViewMap.eventActionMap, 1000);

  const dataViewMap = new TrackableBasedEventActionMap();
  config.add('dataView', dataViewMap);
  inputEventBindings.perspectiveView.addParent(dataViewMap.eventActionMap, 999);
  inputEventBindings.sliceView.addParent(dataViewMap.eventActionMap, 999);

  return config;
}

function makeTrackableBasedSourceGenerationHandler(pythonDataSource: PythonDataSource) {
  const state = new TrackableValue<{[key: string]: number}>({}, x => {
    for (const key of Object.keys(x)) {
      const value = x[key];
      if (typeof value !== 'number') {
        throw new Error(`Expected key ${
            JSON.stringify(key)} to have a numeric value, but received: ${JSON.stringify(value)}.`);
      }
    }
    return x;
  });
  state.changed.add(debounce(() => {
    const generations = state.value;
    for (const key of Object.keys(generations)) {
      pythonDataSource.setSourceGeneration(key, generations[key]);
    }
    for (const key of pythonDataSource.sourceGenerations.keys()) {
      if (!generations.hasOwnProperty(key)) {
        pythonDataSource.deleteSourceGeneration(key);
      }
    }
  }, 0));
  return state;
}

window.addEventListener('DOMContentLoaded', () => {
  const configState = new CompoundTrackable();
  const privateState = new CompoundTrackable();

  const credentialsManager = new TrackableBasedCredentialsManager();
  configState.add('credentials', credentialsManager.inputState);
  privateState.add('credentials', credentialsManager.outputState);

  const dataSourceProvider = getDefaultDataSourceProvider(
      {credentialsManager: new CachingCredentialsManager(credentialsManager)});
  const pythonDataSource = new PythonDataSource();
  dataSourceProvider.register('python', pythonDataSource);
  configState.add('sourceGenerations', makeTrackableBasedSourceGenerationHandler(pythonDataSource));

  let viewer = (<any>window)['viewer'] = makeDefaultViewer({
    showLayerDialog: false,
    resetStateWhenEmpty: false,
    dataSourceProvider,
  });
  setDefaultInputEventBindings(viewer.inputEventBindings);
  configState.add(
      'inputEventBindings', makeTrackableBasedEventActionMaps(viewer.inputEventBindings));

  const remoteActionHandler = new RemoteActionHandler(viewer);
  (<any>window)['remoteActionHandler'] = remoteActionHandler;
  configState.add('actions', remoteActionHandler.actionSet);

  configState.add('statusMessages', new TrackableBasedStatusMessages());

  const screenshotHandler = new ScreenshotHandler(viewer);
  configState.add('screenshot', screenshotHandler.requestState);

  let sharedState: Trackable|undefined = viewer.state;

  if (window.location.hash) {
    const hashBinding = viewer.registerDisposer(new UrlHashBinding(viewer.state));
    hashBinding.updateFromUrlHash();
    sharedState = undefined;
  }

  const prefetchManager = new PrefetchManager(
      viewer.display, dataSourceProvider, viewer.dataContext.addRef(), viewer.uiConfiguration);
  configState.add('prefetch', prefetchManager);

  configState.add('showUIControls', viewer.uiConfiguration.showUIControls);
  configState.add('showLayerPanel', viewer.uiConfiguration.showLayerPanel);
  configState.add('showHelpButton', viewer.uiConfiguration.showHelpButton);
  configState.add('showLocation', viewer.uiConfiguration.showLocation);
  configState.add('showPanelBorders', viewer.uiConfiguration.showPanelBorders);
  configState.add('scaleBarOptions', viewer.scaleBarOptions);

  const size = new TrackableValue<[number, number]|undefined>(
      undefined,
      x => x == null ? undefined : parseFixedLengthArray(<[number, number]>[0, 0], x, verifyInt));
  configState.add('viewerSize', size);

  const updateSize = () => {
    const element = viewer.display.container;
    const value = size.value;
    if (value === undefined) {
      element.style.position = 'relative';
      element.style.width = null;
      element.style.height = null;
      element.style.transform = null;
      element.style.transformOrigin = null;
    } else {
      element.style.position = 'absolute';
      element.style.width = `${value[0]}px`;
      element.style.height = `${value[1]}px`;
      const screenWidth = document.documentElement!.clientWidth;
      const screenHeight = document.documentElement!.clientHeight;
      const scaleX = screenWidth/value[0];
      const scaleY = screenHeight/value[1];
      const scale = Math.min(scaleX, scaleY);
      element.style.transform = `scale(${scale})`;
      element.style.transformOrigin = 'top left';
    }
  };
  updateSize();
  window.addEventListener('resize', updateSize);
  size.changed.add(debounce(() => updateSize(), 0));

  const serverConnection = new ServerConnection(sharedState, privateState, configState);
  remoteActionHandler.sendActionRequested.add(
      (action, state) => serverConnection.sendActionNotification(action, state));
  screenshotHandler.sendScreenshotRequested.add(
      state => serverConnection.sendActionNotification('screenshot', state));

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);
});
