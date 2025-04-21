/**
 * @license
 * Copyright 2025 Google Inc.
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

import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import { SingleChannelMetadata } from "#src/datasource/index.js";
import type { ImageUserLayer } from "#src/layer/image/index.js";
import {
  changeLayerName,
  TopLevelLayerListSpecification,
  type LayerListSpecification,
  type ManagedUserLayer,
  type UserLayer,
} from "#src/layer/index.js";
import { arraysEqual } from "#src/util/array.js";
import { Borrowed } from "#src/util/disposable.js";
import { debounce } from "lodash-es";

type MakeLayerFn = (
  manager: LayerListSpecification,
  name: string,
  spec: any,
) => ManagedUserLayer;

const NEW_FRAGMENT_MAIN = `#uicontrol invlerp contrast
#uicontrol vec3 color color
void main() {
  float contrast_value = contrast();
  if (VOLUME_RENDERING) {
    emitRGBA(vec4(color * contrast_value, contrast_value));
  }
  else {
    emitRGB(color * contrast_value);
  }
}
`;

function renameChannelDimensions(layer: UserLayer) {
  // rename each output dim with ^ to be ' instead
  for (const dataSource of layer.dataSources) {
    const { loadState } = dataSource;
    if (loadState === undefined) return;
    if (loadState.error !== undefined) return;
    const transformOutputSpace = loadState.transform.value;
    const names = transformOutputSpace.outputSpace.names;
    const newNames = [];
    for (const name of names) {
      newNames.push(name.replace("^", "'"));
    }
    const outputSpace = transformOutputSpace.outputSpace;
    // see L721 of widget/coordinate_transform.ts
    // There might be something that makes this a little cleaner
    // may also need to change modelTransform - depends a little
    const newOutputSpace = makeCoordinateSpace({
      ...outputSpace,
      names: newNames,
    });
    loadState.transform.value = {
      ...loadState.transform.value,
      outputSpace: newOutputSpace,
    };
  }
}

function calculateLocalDimensions(managedLayer: ManagedUserLayer) {
  const { localCoordinateSpace } = managedLayer;
  const localDimensionRank = localCoordinateSpace.value.rank;
  const { lowerBounds, upperBounds } = localCoordinateSpace.value.bounds;
  const numLocalsInEachDimension = [];
  for (let i = 0; i < localDimensionRank; i++) {
    numLocalsInEachDimension.push(upperBounds[i] - lowerBounds[i]);
  }

  let totalLocalChannels =
    numLocalsInEachDimension.length > 0
      ? numLocalsInEachDimension.reduce((acc, val) => acc * val, 1)
      : 0;
  totalLocalChannels = Number.isFinite(totalLocalChannels)
    ? totalLocalChannels
    : 0;
  return {
    totalLocalChannels,
    lowerBounds,
    upperBounds,
    localDimensionRank,
  };
}

function cartesianProductOfRanges(ranges: number[][]): number[][] {
  return ranges.reduce(
    (acc, range) => acc.flatMap((a) => range.map((b) => [...a, b])),
    [[]],
  );
}

function rangeFromBounds(lower: number, upper: number) {
  return Array.from({ length: upper - lower }, (_, i) => i + lower);
}

const arrayColors = new Map([
  [0, new Float32Array([1, 0, 0])],
  [1, new Float32Array([0, 1, 0])],
  [2, new Float32Array([0, 0, 1])],
]);

function getLayerChannelMetadata(
  layer: ManagedUserLayer,
  channelIndex: number,
): SingleChannelMetadata | undefined {
  if (!layer.layer) return undefined;
  const loadState = layer.layer.dataSources[0].loadState;
  if (loadState?.error || loadState === undefined) return undefined;
  const channels = loadState.dataSource.channelMetadata;
  if (channels !== undefined) {
    const channel = channels.channels[channelIndex];
    if (channel !== undefined) {
      return channel;
    }
  }
  return undefined;
}

function checkLayerInputMetadataForErrors(layer: ManagedUserLayer): boolean {
  if (!layer.layer) return true;
  const loadState = layer.layer.dataSources[0].loadState;
  if (loadState?.error || loadState === undefined) return true;
  const channels = loadState.dataSource.channelMetadata;
  if (channels === undefined) return true;
  // If all the ranges are the same and the colors are black, then we can
  // assume that the input metadata is not set up correctly
  const firstRange = channels.channels[0].range;
  let sameRanges = true;
  for (let i = 1; i < channels.channels.length; i++) {
    const channel = channels.channels[i];
    if (channel.range === undefined || firstRange === undefined) {
      continue;
    }
    if (!arraysEqual(channel.range, firstRange)) {
      sameRanges = false;
      break;
    }
  }
  let colorsAllBlack = true;
  for (let i = 0; i < channels.channels.length; i++) {
    const channel = channels.channels[i];
    if (channel.color === undefined) {
      continue;
    }
    const colorSum = channel.color.reduce((acc, val) => acc + val, 0);
    if (colorSum > 0.05) {
      colorsAllBlack = false;
      break;
    }
  }
  return sameRanges && colorsAllBlack;
}

function postLayerCreationActions(
  addedLayer: ManagedUserLayer,
  channelIndex: number,
  debouncedSetupFunctions: any[],
  channel?: SingleChannelMetadata,
  ignoreInputMetadata = false,
) {
  if (!addedLayer.layer) return;
  const userImageLayer = addedLayer.layer as ImageUserLayer;
  userImageLayer.fragmentMain.value = NEW_FRAGMENT_MAIN;

  const active = channel?.active ?? channelIndex <= 3;
  addedLayer.setArchived(!active);

  const setupWidgetsFunction = () => {
    const shaderControlState = userImageLayer.shaderControlState.value;
    let color = arrayColors.get(channelIndex % 3);
    if (channel?.color !== undefined && !ignoreInputMetadata) {
      color = channel.color;
    }
    shaderControlState.get("color")!.trackable.value = color;
    const contrast = shaderControlState.get("contrast")!;
    const trackableContrast = contrast.trackable;
    if (
      channel?.range !== undefined &&
      channel?.window !== undefined &&
      !ignoreInputMetadata
    ) {
      trackableContrast.value = {
        ...trackableContrast.value,
        range: channel.range,
        window: channel.window,
      };
    } else if (active) {
      trackableContrast.value = {
        ...trackableContrast.value,
        autoCompute: true,
      };
    }
  };

  const maxWait = 2000;
  const startTime = Date.now();
  function debouncedSetDefaults() {
    const checkReady = debounce(() => {
      const shaderControlState = userImageLayer.shaderControlState.value;
      const contrast = shaderControlState.get("contrast");
      if (contrast !== undefined || Date.now() - startTime > maxWait) {
        checkReady.cancel();
        if (contrast !== undefined) {
          // Set up the widgets
          setupWidgetsFunction();
        }
      } else {
        // Continue polling
        checkReady();
      }
    }, 100);

    checkReady();
  }

  debouncedSetupFunctions.push(debouncedSetDefaults);
}

export function createImageLayerAsMultiChannel(
  managedLayer: Borrowed<ManagedUserLayer>,
  makeLayer: MakeLayerFn,
) {
  if (managedLayer.layer?.type !== "image") return;

  renameChannelDimensions(managedLayer.layer);
  const { totalLocalChannels, lowerBounds, upperBounds, localDimensionRank } =
    calculateLocalDimensions(managedLayer);

  const ranges = [];
  for (let i = 0; i < localDimensionRank; i++) {
    ranges.push(rangeFromBounds(lowerBounds[i], upperBounds[i]));
  }
  const rangeProduct = cartesianProductOfRanges(ranges);

  function calculateLocalPosition(index: number) {
    const localPosition = rangeProduct[index];
    const arr = localPosition.map((pos) => pos + 0.5);
    const chanName = localPosition.join(",");
    return { localPosition: arr, chanName };
  }

  const spec = managedLayer.layer?.toJSON();
  const startingName = managedLayer.name;
  changeLayerName(managedLayer, `${startingName} chan0`);
  const debouncedSetupFunctions: Array<() => void> = [];
  const ignoreInputMetadata = checkLayerInputMetadataForErrors(managedLayer);
  if (ignoreInputMetadata) {
    console.warn(
      "Input omera metadata is not set up correctly. Colors are either missing or all close to black, and all ranges are the same or missing. Using default values for display purposes.",
    );
  }
  for (let i = 0; i < totalLocalChannels; i++) {
    const channelMetadata = getLayerChannelMetadata(managedLayer, i);
    const { localPosition, chanName } = calculateLocalPosition(i);
    const name = channelMetadata?.label ?? `${startingName} c${chanName}`;
    let addedLayer: any = managedLayer;
    if (i == 0) {
      changeLayerName(managedLayer, name);
      managedLayer.localPosition.value = new Float32Array(localPosition);
    }
    if (i !== 0) {
      const thisSpec = { ...spec, localPosition };
      const newLayer = makeLayer(managedLayer.manager, name, thisSpec);
      managedLayer.manager.add(newLayer);
      addedLayer = newLayer;
    }
    postLayerCreationActions(
      addedLayer,
      i,
      debouncedSetupFunctions,
      channelMetadata,
      ignoreInputMetadata,
    );
  }
  if (managedLayer.manager instanceof TopLevelLayerListSpecification) {
    managedLayer.manager.display.multiChannelSetupFinished.dispatch();
  }
  debouncedSetupFunctions.forEach((fn) => fn());
}
