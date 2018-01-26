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

import debounce from 'lodash/debounce';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {verifyOptionalString} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';
import {getCachedJson} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

export class ScreenshotHandler extends RefCounted {
  sendScreenshotRequested = new Signal<(state: any) => void>();
  requestState = new TrackableValue<string|undefined>(undefined, verifyOptionalString);
  private previousRequest: string|undefined = undefined;
  constructor(public viewer: Viewer) {
    super();

    const debouncedMaybeSendScreenshot =
        this.registerCancellable(debounce(() => this.maybeSendScreenshot(), 0));
    this.requestState.changed.add(debouncedMaybeSendScreenshot);
    this.registerDisposer(viewer.display.updateFinished.add(debouncedMaybeSendScreenshot));
  }

  private maybeSendScreenshot() {
    const requestState = this.requestState.value;
    const {previousRequest} = this;
    const {layerSelectedValues} = this.viewer;
    if (requestState === undefined || requestState === previousRequest) {
      return;
    }
    const {viewer} = this;
    if (!viewer.display.isReady()) {
      return;
    }
    for (const layer of viewer.layerManager.managedLayers) {
      if (!layer.isReady()) {
        return;
      }
    }
    this.previousRequest = requestState;
    viewer.display.draw();
    const screenshotData = viewer.display.canvas.toDataURL();
    const prefix = 'data:image/png;base64,';
    let imageType: string;
    let image: string;
    if (!screenshotData.startsWith(prefix)) {
      imageType = '';
      image = '';
    } else {
      imageType = 'image/png';
      image = screenshotData.substring(prefix.length);
    }
    const actionState = {
      viewerState: JSON.parse(JSON.stringify(getCachedJson(this.viewer.state).value)),
      selectedValues: JSON.parse(JSON.stringify(layerSelectedValues)),
      screenshot: {id: requestState, image, imageType},
    };

    this.sendScreenshotRequested.dispatch(actionState);
  }
}
