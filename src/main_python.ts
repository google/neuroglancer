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

import {getDefaultDataSourceProvider} from 'neuroglancer/datasource/default_provider';
import {TrackableBasedCredentialsManager} from 'neuroglancer/python_integration/credentials_provider';
import {TrackableBasedEventActionMap} from 'neuroglancer/python_integration/event_action_map';
import {RemoteActionHandler} from 'neuroglancer/python_integration/remote_actions';
import {TrackableBasedStatusMessages} from 'neuroglancer/python_integration/remote_status_messages';
import {ServerConnection} from 'neuroglancer/python_integration/server_connection';
import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {makeDefaultViewer} from 'neuroglancer/ui/default_viewer';
import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';
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

window.addEventListener('DOMContentLoaded', () => {

  const configState = new CompoundTrackable();
  const privateState = new CompoundTrackable();

  const credentialsManager = new TrackableBasedCredentialsManager();
  configState.add('credentials', credentialsManager.inputState);
  privateState.add('credentials', credentialsManager.outputState);

  let viewer = (<any>window)['viewer'] = makeDefaultViewer({
    showLayerDialog: false,
    resetStateWhenEmpty: false,
    dataSourceProvider: getDefaultDataSourceProvider({credentialsManager})
  });
  setDefaultInputEventBindings(viewer.inputEventBindings);
  configState.add(
      'inputEventBindings', makeTrackableBasedEventActionMaps(viewer.inputEventBindings));

  const remoteActionHandler = new RemoteActionHandler(viewer);
  (<any>window)['remoteActionHandler'] = remoteActionHandler;
  configState.add('actions', remoteActionHandler.actionSet);

  configState.add('statusMessages', new TrackableBasedStatusMessages());

  let sharedState: Trackable|undefined = viewer.state;

  if (window.location.hash) {
    const hashBinding = viewer.registerDisposer(new UrlHashBinding(viewer.state));
    hashBinding.updateFromUrlHash();
    sharedState = undefined;
  }

  const serverConnection = new ServerConnection(sharedState, privateState, configState);
  remoteActionHandler.sendActionRequested.add(
      (action, state) => serverConnection.sendActionNotification(action, state));

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);
});
