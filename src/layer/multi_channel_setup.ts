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

import { debounce } from "lodash-es";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type { SingleChannelMetadata } from "#src/datasource/index.js";
import type { ImageUserLayer } from "#src/layer/image/index.js";
import {
  changeLayerName,
  TopLevelLayerListSpecification,
  type LayerListSpecification,
  type ManagedUserLayer,
  type UserLayer,
} from "#src/layer/index.js";
import { BLEND_MODES } from "#src/trackable_blend.js";
import { arraysEqual } from "#src/util/array.js";
import type { Borrowed } from "#src/util/disposable.js";
import type { vec3 } from "#src/util/geom.js";

type MakeLayerFn = (
  manager: LayerListSpecification,
  name: string,
  spec: any,
) => ManagedUserLayer;

const MULTICHANNEL_FRAGMENT_MAIN = `#uicontrol invlerp contrast
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

const DEFAULT_ARRAY_COLORS = new Map([
  [0, new Float32Array([1, 0, 0])],
  [1, new Float32Array([0, 1, 0])],
  [2, new Float32Array([0, 0, 1])],
  [3, new Float32Array([1, 1, 1])],
]);

const DEFAULT_VOLUME_RENDERING_SAMPLES = 256;

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

function getLoadState(layer: ManagedUserLayer) {
  if (layer.layer === null) return null;
  return layer.layer.dataSources[0]?.loadState;
}

function getChannelMetadata(layer: ManagedUserLayer) {
  const loadState = getLoadState(layer);
  if (!loadState || loadState.error) return null;
  return loadState.dataSource.channelMetadata?.channels;
}

function getLayerChannelMetadata(
  layer: ManagedUserLayer,
  channelIndex: number,
): SingleChannelMetadata | undefined {
  const channels = getChannelMetadata(layer);
  return channels?.[channelIndex];
}

function checkLayerInputMetadataForErrors(layer: ManagedUserLayer): boolean {
  // If all the ranges are the same and the colors are black, then we can
  // assume that the input metadata is not set up correctly
  const channels = getChannelMetadata(layer);
  if (!channels || channels.length === 0) return true;

  // Check if all ranges that are defined are the same
  const definedRanges = channels
    .map((channel) => channel.range)
    .filter((range): range is [number, number] => range !== undefined);
  const sameRanges =
    definedRanges.length > 0 &&
    definedRanges.every((range) => arraysEqual(range, definedRanges[0]));

  // Check if all defined colors are close to black (sum of RGB ≤ 0.05)
  const definedColors = channels
    .map((channel) => channel.color)
    .filter((color): color is vec3 => color !== undefined);
  const colorsAllBlack = definedColors.every((color) => {
    const colorSum = color.reduce((acc, val) => acc + val, 0);
    return colorSum <= 0.05;
  });
  return sameRanges && colorsAllBlack;
}

function setupLayerPostCreation(
  addedLayer: ManagedUserLayer,
  channelIndex: number,
  postCreationSetupFunctions: (() => void)[],
  totalLocalChannels: number,
  channel?: SingleChannelMetadata,
  ignoreInputMetadata = false,
) {
  if (!addedLayer.layer) return;
  const userImageLayer = addedLayer.layer as ImageUserLayer;
  userImageLayer.fragmentMain.value = MULTICHANNEL_FRAGMENT_MAIN;

  const active = channel?.active ?? channelIndex <= 3;
  addedLayer.setArchived(!active);

  const setupWidgetsFunction = () => {
    const shaderControlState = userImageLayer.shaderControlState.value;
    let color = DEFAULT_ARRAY_COLORS.get(
      channelIndex % DEFAULT_ARRAY_COLORS.size,
    );
    if (totalLocalChannels === 1) {
      color = new Float32Array([1, 1, 1]);
    }
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
      // Wait for some data to be loaded before setting the contrast
      const debouncedSetContrast = debounce(() => {
        trackableContrast.value = {
          ...trackableContrast.value,
          autoCompute: true,
        };
      }, 2000);
      debouncedSetContrast();
    }
  };

  const setDefaultsWhenReady = () => {
    const maxWait = 2000;
    const startTime = Date.now();
    const waitForShaderWidgetsReady = debounce(() => {
      const shaderControlState = userImageLayer.shaderControlState.value;
      const contrast = shaderControlState.get("contrast");
      if (contrast !== undefined || Date.now() - startTime > maxWait) {
        waitForShaderWidgetsReady.cancel();
        if (contrast !== undefined) {
          // Set up the widgets
          setupWidgetsFunction();
        }
      } else {
        // Continue polling
        waitForShaderWidgetsReady();
      }
    }, 100);

    waitForShaderWidgetsReady();
  };

  const setVolumeRenderingSamples = () => {
    userImageLayer.volumeRenderingDepthSamplesTarget.value =
      DEFAULT_VOLUME_RENDERING_SAMPLES;
  };

  const set2DBlending = () => {
    userImageLayer.blendMode.value = BLEND_MODES.ADDITIVE;
    userImageLayer.opacity.value = 1.0;
  };

  postCreationSetupFunctions.push(setVolumeRenderingSamples);
  postCreationSetupFunctions.push(set2DBlending);
  postCreationSetupFunctions.push(setDefaultsWhenReady);
}

export function createImageLayerAsMultiChannel(
  managedLayer: Borrowed<ManagedUserLayer>,
  makeLayer: MakeLayerFn,
  checkForMultipleChannels: boolean = false,
) {
  if (managedLayer.layer?.type !== "image") return;

  renameChannelDimensions(managedLayer.layer);
  const { totalLocalChannels, lowerBounds, upperBounds, localDimensionRank } =
    calculateLocalDimensions(managedLayer);

  if (totalLocalChannels <= 1 && checkForMultipleChannels) return;

  const ranges = [];
  for (let i = 0; i < localDimensionRank; i++) {
    ranges.push(rangeFromBounds(lowerBounds[i], upperBounds[i]));
  }
  const rangeProduct = cartesianProductOfRanges(ranges);

  function getAdjustedLocalPositionAndName(index: number) {
    const localPosition = rangeProduct[index];
    const arr = localPosition.map((pos) => pos + 0.5);
    const chanName = localPosition.join(",");
    return { localPosition: arr, chanName };
  }

  const spec = managedLayer.layer?.toJSON();
  const startingName = managedLayer.name;
  changeLayerName(managedLayer, `${startingName} chan0`);
  const postCreationSetupFunctions: Array<() => void> = [];
  const ignoreInputMetadata = checkLayerInputMetadataForErrors(managedLayer);
  if (ignoreInputMetadata) {
    console.warn(
      "Input omera metadata is not set up correctly. Colors are either missing or all close to black, and all ranges are the same or missing. Using default values for display purposes.",
    );
  }
  for (let i = 0; i < totalLocalChannels; i++) {
    const channelMetadata = getLayerChannelMetadata(managedLayer, i);
    const { localPosition, chanName } = getAdjustedLocalPositionAndName(i);
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
    setupLayerPostCreation(
      addedLayer,
      i,
      postCreationSetupFunctions,
      totalLocalChannels,
      channelMetadata,
      ignoreInputMetadata,
    );
  }
  if (managedLayer.manager instanceof TopLevelLayerListSpecification) {
    managedLayer.manager.display.multiChannelSetupFinished.dispatch();
  }
  postCreationSetupFunctions.forEach((fn) => fn());
}
