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
  /**
   * To reduce the risk of taking a screenshot while deferred code is still registering layers,
   * require that the viewer be in a ready state once, and still remain ready while all pending
   * events are handled, before a screenshot is taken.
   */
  private wasAlreadyVisible = false;
  private previousRequest: string|undefined = undefined;
  private debouncedMaybeSendScreenshot =
      this.registerCancellable(debounce(() => this.maybeSendScreenshot(), 0));

  constructor(public viewer: Viewer) {
    super();
    this.requestState.changed.add(this.debouncedMaybeSendScreenshot);
    this.registerDisposer(viewer.display.updateFinished.add(this.debouncedMaybeSendScreenshot));
  }

  private maybeSendScreenshot() {
    const requestState = this.requestState.value;
    const {previousRequest} = this;
    const {layerSelectedValues} = this.viewer;
    if (requestState === undefined || requestState === previousRequest) {
      this.wasAlreadyVisible = false;
      return;
    }
    const {viewer} = this;
    if (!viewer.display.isReady()) {
      this.wasAlreadyVisible = false;
      return;
    }
    for (const layer of viewer.layerManager.managedLayers) {
      if (!layer.isReady()) {
        this.wasAlreadyVisible = false;
        return;
      }
    }
    if (!this.wasAlreadyVisible) {
      this.wasAlreadyVisible = true;
      this.debouncedMaybeSendScreenshot();
      return;
    }
    this.wasAlreadyVisible = false;
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
