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
import {
  TopLevelLayerListSpecification,
  type LayerListSpecification,
  type ManagedUserLayer,
  type UserLayer,
} from "#src/layer/index.js";
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

function postLayerCreationActions(
  addedLayer: any,
  i: number,
  debouncedSetupFunctions: any[],
) {
  addedLayer.layer.fragmentMain.value = NEW_FRAGMENT_MAIN;
  // Set the color based on the index
  // console.log(addedLayer.layer.shaderControlState.controls['contrast'])
  // addedLayer.layer.shaderControlState.controls.controls.get('contrast').autoRangeFinder.autoComputeRange(0.05, 0.95);
  // TODO (skm) wait until finished processing and then update some defaults
  const debouncedSetDefaults = debounce(() => {
    addedLayer.layer.shaderControlState.value.get("color").trackable.value =
      arrayColors.get(i % 3);
    // TODO (SKM) correct the watchable - Fake update for now
    const trackableContrast =
      addedLayer.layer.shaderControlState.value.get("contrast").trackable.value;
    // addedLayer.layer.shaderControlState.value.get(
    //   "contrast",
    // ).trackable.value = {
    //   ...trackableContrast,
    //   range: [0, 2],
    // };
    addedLayer.layer.shaderControlState.value.get("contrast").trackable.value =
      {
        ...trackableContrast,
        autoCompute: true,
      };
    addedLayer.layer.shaderControlState.value
      .get("contrast")
      .trackable.changed.dispatch();
  }, 1000);
  debouncedSetupFunctions.push(debouncedSetDefaults);
}

export function createImageLayerAsMultiChannel(
  managedLayer: Borrowed<ManagedUserLayer>,
  makeLayer: MakeLayerFn,
) {
  // remapTransformInputSpace is a possiblity
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
    const arr = new Array(localPosition.length);
    for (let i = 0; i < localPosition.length; ++i) {
      arr[i] = localPosition[i] + 0.5;
    }
    return arr;
  }

  const spec = managedLayer.layer?.toJSON();
  const startingName = managedLayer.name;
  managedLayer.name = `${managedLayer.name} chan0`;
  const debouncedSetupFunctions: Array<() => void> = [];
  for (let i = 0; i < totalLocalChannels; i++) {
    // if i is 0 we already have the layer, this one
    // Otherwise we need to create a new layer
    const localPosition = calculateLocalPosition(i);
    let addedLayer: any = managedLayer;
    if (i == 0) {
      // Just change the channel
      managedLayer.localPosition.value = new Float32Array(localPosition);
    }
    if (i !== 0) {
      // Create a new layer
      const thisSpec = { ...spec, localPosition };
      const newLayer = makeLayer(
        managedLayer.manager,
        `${startingName} chan${i}`,
        thisSpec,
      );
      managedLayer.manager.add(newLayer);
      addedLayer = newLayer;
    }
    postLayerCreationActions(addedLayer, i, debouncedSetupFunctions);
  }
  if (managedLayer.manager instanceof TopLevelLayerListSpecification) {
    managedLayer.manager.display.multiChannelSetupFinished.dispatch();
  }
  debouncedSetupFunctions.forEach((fn) => fn());
}
