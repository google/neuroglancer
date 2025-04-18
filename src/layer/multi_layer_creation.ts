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

import {
  CoordinateSpace,
  makeCoordinateSpace,
} from "#src/coordinate_transform.js";
import type {
  LayerListSpecification,
  ManagedUserLayer,
} from "#src/layer/index.js";
import { WatchableValueInterface } from "#src/trackable_value.js";
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

export function createImageLayerAsMultiChannel(
  managedLayer: Borrowed<ManagedUserLayer>,
  makeLayer: MakeLayerFn,
) {
  // remapTransformInputSpace is a possiblity
  if (managedLayer.layer?.type !== "image") return;

  // For each datasource, change the transform to be a local transform
  for (const dataSource of managedLayer.layer.dataSources) {
    console.log(dataSource);
    // rename each output dim with ^ to be ' instead
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
    console.log(dataSource);
  }

  // const coordSpace = this.managedLayer.layer.channelCoordinateSpace!;
  // console.log(coordSpace);
  // console.log(this.managedLayer.layer.localCoordinateSpaceCombiner);
  // console.log(
  //   this.managedLayer.layer.localCoordinateSpaceCombiner
  //     .includeDimensionPredicate,
  // );
  // Iterate over the dimensions and check if they are local or channel
  // const { localCoordinateSpaceCombiner } = this.managedLayer.layer;
  // const channelMap = localCoordinateSpaceCombiner.dimensionRefCounts;

  // Grab all local dimensions (' or =) TODO this might also capture the local ones
  const { localCoordinateSpace } = managedLayer;
  const localDimensionRank = localCoordinateSpace.value.rank;
  const { lowerBounds, upperBounds } = localCoordinateSpace.value.bounds;
  const numLocalsInEachDimension = [];
  // console.log(localDimensionRank, localCoordinateSpace.value);
  for (let i = 0; i < localDimensionRank; i++) {
    numLocalsInEachDimension.push(upperBounds[i] - lowerBounds[i]);
  }

  // Grab all channel dimensions (^)
  const { channelCoordinateSpace } = managedLayer.layer as unknown as {
    channelCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  };
  const channelDimensionRank = channelCoordinateSpace.value.rank;
  const channelBounds = channelCoordinateSpace.value.bounds;
  const numChannelsInEachChannelDimension = [];
  const { lowerBounds: chanLowerBounds, upperBounds: chanUpperBounds } =
    channelBounds;
  for (let i = 0; i < channelDimensionRank; i++) {
    numChannelsInEachChannelDimension.push(
      chanUpperBounds[i] - chanLowerBounds[i],
    );
  }

  let totalLocalChannels =
    numLocalsInEachDimension.length > 0
      ? numLocalsInEachDimension.reduce((acc, val) => acc * val, 1)
      : 0;
  totalLocalChannels = Number.isFinite(totalLocalChannels)
    ? totalLocalChannels
    : 0;

  // TODO (skm) if the changing is working properly this can be removed
  // as everything will be a local channel
  // TODO this doesn't work if the channels are grouped - e.g. one data source has multiple ranks
  let totalChannelChannels =
    numChannelsInEachChannelDimension.length > 0
      ? numChannelsInEachChannelDimension.reduce((acc, val) => acc * val, 1)
      : 0;
  totalChannelChannels = Number.isFinite(totalChannelChannels)
    ? totalChannelChannels
    : 0;
  console.log(numLocalsInEachDimension, numChannelsInEachChannelDimension);
  console.log(totalLocalChannels, totalChannelChannels);
  const totalChannels = totalLocalChannels + totalChannelChannels;

  // TODO Loop over these and make a new layer for each one with the appropriate channel
  const spec = managedLayer.layer?.toJSON();
  const startingName = managedLayer.name;
  managedLayer.name = `${managedLayer.name} chan0`;
  // TODO probably needs two loops, one for local and one for channel
  // otherwise hard to pull the right pieces

  // TODO pull out to somewhere else
  function cartesianProductOfRanges(ranges: number[][]): number[][] {
    // Start with an array of one empty array
    // Iteratively capture the cartesian product of the ranges
    // For the first range, map each value to an array containing that value
    // For the second range, append each value in that array
    // to the arrays containing the values from the first range
    // And so on
    return ranges.reduce(
      (acc, range) => acc.flatMap((a) => range.map((b) => [...a, b])),
      [[]],
    );
  }

  function rangeFromBounds(lower: number, upper: number) {
    return Array.from({ length: upper - lower }, (_, i) => i + lower);
  }

  const ranges = [];
  for (let i = 0; i < localDimensionRank; i++) {
    ranges.push(rangeFromBounds(lowerBounds[i], upperBounds[i]));
  }
  const rangeProduct = cartesianProductOfRanges(ranges);

  function calculateLocalPosition(index: number) {
    return rangeProduct[index];
  }

  // const colors = new Map([
  //   [0, "#ff0000"],
  //   [1, "#00ff00"],
  //   [2, "#0000ff"],
  // ]);

  const arrayColors = new Map([
    [0, new Float32Array([1, 0, 0])],
    [1, new Float32Array([0, 1, 0])],
    [2, new Float32Array([0, 0, 1])],
  ]);

  const debouncedSetupFunctions = [];
  for (let i = 0; i < totalChannels; i++) {
    // if i is 0 we already have the layer, this one
    // Otherwise we need to create a new layer
    const localPosition = calculateLocalPosition(i);
    let addedLayer: any = managedLayer;
    if (i == 0) {
      // Just change the channel
      // managedLayer.layer.restoreState(thisSpec);
      // managedLayer.layer.initializationDone();
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
    addedLayer.layer.fragmentMain.value = NEW_FRAGMENT_MAIN;
    // Set the color based on the index
    // console.log(addedLayer.layer.shaderControlState.controls['contrast'])
    // addedLayer.layer.shaderControlState.controls.controls.get('contrast').autoRangeFinder.autoComputeRange(0.05, 0.95);
    // TODO (skm) wait until finished processing and then update some defaults
    const debouncedSetDefaults = debounce(() => {
      // TODO (SKM) either works
      // addedLayer.layer.shaderControlState.restoreState({
      //   color: colors.get(i % 3),
      // })
      addedLayer.layer.shaderControlState.value.get("color").trackable.value =
        arrayColors.get(i % 3);
      // TODO (SKM) correct the watchable - Fake update for now
      const trackableContrast =
        addedLayer.layer.shaderControlState.value.get("contrast").trackable
          .value;
      // addedLayer.layer.shaderControlState.value.get(
      //   "contrast",
      // ).trackable.value = {
      //   ...trackableContrast,
      //   range: [0, 2],
      // };
      addedLayer.layer.shaderControlState.value.get(
        "contrast",
      ).trackable.value = {
        ...trackableContrast,
        autoCompute: true,
      };
      addedLayer.layer.shaderControlState.value
        .get("contrast")
        .trackable.changed.dispatch();
    }, 1000);
    debouncedSetupFunctions.push(debouncedSetDefaults);
  }
  debouncedSetupFunctions.forEach((fn) => {
    fn();
  });
  // TODO (SKM) not really needed used for debugging
  // debouncedSetupFunctions.forEach((fn, index) => {
  //   setTimeout(fn, index * 1000); // Calls each function 1 second apart
  // });
}
