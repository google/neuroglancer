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
import throttle from 'lodash/throttle';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {columnSpecifications, getChunkSourceIdentifier, getFormattedNames} from 'neuroglancer/ui/statistics';
import {toBase64} from 'neuroglancer/util/base64';
import {RefCounted} from 'neuroglancer/util/disposable';
import {convertEndian32, Endianness,} from 'neuroglancer/util/endian';
import {verifyOptionalString} from 'neuroglancer/util/json';
import {Signal} from 'neuroglancer/util/signal';
import {getCachedJson} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';
import { numChunkStatistics } from '../chunk_manager/base';

export class ScreenshotHandler extends RefCounted {
  sendScreenshotRequested = new Signal<(state: any) => void>();
  sendStatisticsRequested = new Signal<(state: any) => void>();
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
  private statisticsRequested = false;
  private throttledSendStatistics = this.registerCancellable(throttle(async (requestId: string) => {
    if (this.requestState.value !== requestId || this.previousRequest === requestId) return;
    this.throttledSendStatistics(requestId);
    if (this.statisticsRequested) return;
    this.statisticsRequested = true;
    const map = await this.viewer.chunkQueueManager.getStatistics();
    this.statisticsRequested = false;
    if (this.wasDisposed) return;
    if (this.requestState.value !== requestId || this.previousRequest === requestId) return;
    const formattedNames = getFormattedNames(Array.from(map, x => getChunkSourceIdentifier(x[0])));
    let i = 0;
    const rows: any[] = [];
    let sumStatistics = new Float64Array(numChunkStatistics);
    for (const [source, statistics] of map) {
      for (let i = 0; i < numChunkStatistics; ++i) {
        sumStatistics[i] += statistics[i];
      }
      const row: any = {};
      row.id = getChunkSourceIdentifier(source);
      row.distinctId = formattedNames[i];
      for (const column of columnSpecifications) {
        row[column.key] = column.getter(statistics);
      }
      ++i;
      rows.push(row);
    }
    const total: any = {};
    for (const column of columnSpecifications) {
      total[column.key] = column.getter(sumStatistics);
    }
    const actionState = {
      viewerState: JSON.parse(JSON.stringify(getCachedJson(this.viewer.state).value)),
      selectedValues: JSON.parse(JSON.stringify(this.viewer.layerSelectedValues)),
      screenshotStatistics: {id: requestId, chunkSources: rows, total},
    };
    this.sendStatisticsRequested.dispatch(actionState);
  }, 1000, {leading: false, trailing: true}));

  constructor(public viewer: Viewer) {
    super();
    this.requestState.changed.add(this.debouncedMaybeSendScreenshot);
    this.registerDisposer(viewer.display.updateFinished.add(this.debouncedMaybeSendScreenshot));
  }

  private isReady() {
    const {viewer} = this;
    viewer.chunkQueueManager.flushPendingChunkUpdates();
    if (!viewer.display.isReady()) {
      return false;
    }
    for (const layer of viewer.layerManager.managedLayers) {
      if (!layer.isReady()) {
        return false;
      }
    }
    return true;
  }

  private async maybeSendScreenshot() {
    const requestState = this.requestState.value;
    const {previousRequest} = this;
    const {layerSelectedValues} = this.viewer;
    if (requestState === undefined || requestState === previousRequest) {
      this.wasAlreadyVisible = false;
      this.throttledSendStatistics.cancel();
      return;
    }
    const {viewer} = this;
    if (!this.isReady()) {
      this.wasAlreadyVisible = false;
      this.throttledSendStatistics(requestState);
      return;
    }
    if (!this.wasAlreadyVisible) {
      this.throttledSendStatistics(requestState);
      this.wasAlreadyVisible = true;
      this.debouncedMaybeSendScreenshot();
      return;
    }
    this.wasAlreadyVisible = false;
    this.previousRequest = requestState;
    this.throttledSendStatistics.cancel();
    viewer.display.draw();
    const screenshotData = viewer.display.canvas.toDataURL();
    const {width, height} = viewer.display.canvas;
    const prefix = 'data:image/png;base64,';
    let imageType: string;
    let image: string;
    let depthData: string|undefined = undefined;
    if (!screenshotData.startsWith(prefix)) {
      imageType = '';
      image = '';
    } else {
      imageType = 'image/png';
      image = screenshotData.substring(prefix.length);
      if (requestState.endsWith('_includeDepth')) {
        const depthArray = viewer.display.getDepthArray();
        convertEndian32(depthArray, Endianness.LITTLE);
        depthData = await toBase64(depthArray);
      }
    }
    const actionState = {
      viewerState: JSON.parse(JSON.stringify(getCachedJson(this.viewer.state).value)),
      selectedValues: JSON.parse(JSON.stringify(layerSelectedValues)),
      screenshot: {id: requestState, image, imageType, depthData, width, height},
    };

    this.sendScreenshotRequested.dispatch(actionState);
  }
}
