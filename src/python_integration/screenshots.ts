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

import { debounce, throttle } from "lodash-es";
import { numChunkStatistics } from "#src/chunk_manager/base.js";
import { TrackableValue } from "#src/trackable_value.js";
import {
  columnSpecifications,
  getChunkSourceIdentifier,
  getFormattedNames,
} from "#src/ui/statistics.js";
import { toBase64 } from "#src/util/base64.js";
import { RefCounted } from "#src/util/disposable.js";
import { convertEndian32, Endianness } from "#src/util/endian.js";
import {
  bigintToStringJsonReplacer,
  verifyOptionalString,
} from "#src/util/json.js";
import { Signal } from "#src/util/signal.js";
import { getCachedJson } from "#src/util/trackable.js";
import { ScreenshotMode } from "#src/util/trackable_screenshot_mode.js";
import type { ResolutionMetadata } from "#src/util/viewer_resolution_stats.js";
import { getViewerResolutionMetadata } from "#src/util/viewer_resolution_stats.js";
import type { Viewer } from "#src/viewer.js";

export interface ScreenshotResult {
  id: string;
  image: string;
  imageType: string;
  depthData: string | undefined;
  width: number;
  height: number;
  resolutionMetadata: ResolutionMetadata;
}

export interface ScreenshotActionState {
  viewerState: any;
  selectedValues: any;
  screenshot: ScreenshotResult;
}

export interface ScreenshotChunkStatistics {
  downloadLatency: number;
  visibleChunksDownloading: number;
  visibleChunksFailed: number;
  visibleChunksGpuMemory: number;
  visibleChunksSystemMemory: number;
  visibleChunksTotal: number;
  visibleGpuMemory: number;
}

export interface StatisticsActionState {
  viewerState: any;
  selectedValues: any;
  screenshotStatistics: {
    id: string;
    chunkSources: any[];
    total: ScreenshotChunkStatistics;
  };
}

export class ScreenshotHandler extends RefCounted {
  sendScreenshotRequested = new Signal<
    (state: ScreenshotActionState) => void
  >();
  sendStatisticsRequested = new Signal<
    (state: StatisticsActionState) => void
  >();
  requestState = new TrackableValue<string | undefined>(
    undefined,
    verifyOptionalString,
  );
  /**
   * To reduce the risk of taking a screenshot while deferred code is still registering layers,
   * require that the viewer be in a ready state once, and still remain ready while all pending
   * events are handled, before a screenshot is taken.
   */
  private wasAlreadyVisible = false;
  private previousRequest: string | undefined = undefined;
  private debouncedMaybeSendScreenshot = this.registerCancellable(
    debounce(() => this.maybeSendScreenshot(), 0),
  );
  private statisticsRequested = false;
  private throttledSendStatistics = this.registerCancellable(
    throttle(
      async (requestId: string) => {
        if (
          this.requestState.value !== requestId ||
          this.previousRequest === requestId
        )
          return;
        this.throttledSendStatistics(requestId);
        if (this.statisticsRequested) return;
        this.statisticsRequested = true;
        const map = await this.viewer.chunkQueueManager.getStatistics();
        this.statisticsRequested = false;
        if (this.wasDisposed) return;
        if (
          this.requestState.value !== requestId ||
          this.previousRequest === requestId
        )
          return;
        const formattedNames = getFormattedNames(
          Array.from(map, (x) => getChunkSourceIdentifier(x[0])),
        );
        let i = 0;
        const rows: any[] = [];
        const sumStatistics = new Float64Array(numChunkStatistics);
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
          viewerState: JSON.parse(
            JSON.stringify(getCachedJson(this.viewer.state).value),
          ),
          selectedValues: JSON.parse(
            JSON.stringify(
              this.viewer.layerSelectedValues,
              bigintToStringJsonReplacer,
            ),
          ),
          screenshotStatistics: { id: requestId, chunkSources: rows, total },
        };
        this.sendStatisticsRequested.dispatch(actionState);
      },
      1000,
      { leading: false, trailing: true },
    ),
  );

  constructor(public viewer: Viewer) {
    super();
    this.requestState.changed.add(this.debouncedMaybeSendScreenshot);
    this.registerDisposer(
      viewer.display.updateFinished.add(this.debouncedMaybeSendScreenshot),
    );
  }

  private async maybeSendScreenshot() {
    const requestState = this.requestState.value;
    const { previousRequest } = this;
    const { layerSelectedValues } = this.viewer;
    if (requestState === undefined || requestState === previousRequest) {
      this.wasAlreadyVisible = false;
      this.throttledSendStatistics.cancel();
      return;
    }
    const { viewer } = this;
    const shouldForceScreenshot =
      this.viewer.display.screenshotMode.value === ScreenshotMode.FORCE;
    if (!viewer.isReady() && !shouldForceScreenshot) {
      this.wasAlreadyVisible = false;
      this.throttledSendStatistics(requestState);
      return;
    }
    if (!this.wasAlreadyVisible && !shouldForceScreenshot) {
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
    const resolutionMetadata = getViewerResolutionMetadata(viewer);
    const { width, height } = viewer.display.canvas;
    const prefix = "data:image/png;base64,";
    let imageType: string;
    let image: string;
    let depthData: string | undefined = undefined;
    if (!screenshotData.startsWith(prefix)) {
      imageType = "";
      image = "";
    } else {
      imageType = "image/png";
      image = screenshotData.substring(prefix.length);
      if (requestState.endsWith("_includeDepth")) {
        const depthArray = viewer.display.getDepthArray();
        convertEndian32(depthArray, Endianness.LITTLE);
        depthData = await toBase64(depthArray);
      }
    }
    const actionState = {
      viewerState: JSON.parse(
        JSON.stringify(getCachedJson(this.viewer.state).value),
      ),
      selectedValues: JSON.parse(
        JSON.stringify(layerSelectedValues, bigintToStringJsonReplacer),
      ),
      screenshot: {
        id: requestState,
        image,
        imageType,
        depthData,
        width,
        height,
        resolutionMetadata,
      },
    };

    this.sendScreenshotRequested.dispatch(actionState);
  }
}
