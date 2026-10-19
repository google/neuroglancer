/**
 * @license
 * Copyright 2026 Google Inc.
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

import { afterEach, describe, expect, it } from "vitest";
import {
  CoordinateSpaceCombiner,
  isGlobalDimension,
  TrackableCoordinateSpace,
} from "#src/coordinate_transform.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  LayerListSpecification,
  ManagedUserLayer,
} from "#src/layer/index.js";
import { AutoUserLayer, makeLayer } from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { VolumeType } from "#src/sliceview/volume/base.js";
import { BLEND_MODES } from "#src/trackable_blend.js";
import { GlobalToolBinder } from "#src/ui/tool.js";
import { NullarySignal } from "#src/util/signal.js";

// Provides the parts of the layer list that a single layer uses, without a
// viewer.
function makeFakeLayerListSpecification(): LayerListSpecification {
  const coordinateSpace = new TrackableCoordinateSpace();
  const root = {
    display: {
      updateStarted: new NullarySignal(),
      scheduleRedraw: () => {},
      multiChannelSetupFinished: new NullarySignal(),
    },
    toolBinder: new GlobalToolBinder(undefined as any, undefined as any),
    coordinateSpace,
    coordinateSpaceCombiner: new CoordinateSpaceCombiner(
      coordinateSpace,
      isGlobalDimension,
    ),
    globalPosition: { coordinateSpace },
    layerManager: { getUniqueLayerName: (name: string) => name },
  };
  const layerSelectedValues = {
    mouseState: { changed: new NullarySignal() },
  };
  return { root, layerSelectedValues } as unknown as LayerListSpecification;
}

// Stands in for a loaded data source that provides `subsource`.
function makeLoadedSubsource(subsource: any): LoadedDataSubsource {
  return { subsourceEntry: { subsource } } as unknown as LoadedDataSubsource;
}

// Type detection selects an image layer for this subsource, as for an
// OME-Zarr source.
function makeImageSubsource() {
  return makeLoadedSubsource({ volume: { volumeType: VolumeType.IMAGE } });
}

const managedLayers: ManagedUserLayer[] = [];

afterEach(() => {
  while (managedLayers.length > 0) managedLayers.pop()!.dispose();
});

function makeAutoLayer(spec: any) {
  const manager = makeFakeLayerListSpecification();
  const managedLayer = makeLayer(manager, "layer", spec);
  managedLayers.push(managedLayer);
  expect(managedLayer.layer).toBeInstanceOf(AutoUserLayer);
  return { manager, managedLayer };
}

function makeAutoDetectedImageLayer(spec: any) {
  const { managedLayer } = makeAutoLayer(spec);
  managedLayer.layer!.activateDataSubsources([makeImageSubsource()]);
  expect(managedLayer.layer).toBeInstanceOf(ImageUserLayer);
  return managedLayer;
}

describe("AutoUserLayer", () => {
  it("keeps settings for the detected layer type", () => {
    const managedLayer = makeAutoDetectedImageLayer({
      opacity: 0.25,
      crossSectionRenderScale: 2,
    });
    const layer = managedLayer.layer as ImageUserLayer;
    expect(layer.opacity.value).toBe(0.25);
    expect(layer.sliceViewRenderScaleTarget.value).toBe(2);
    expect(managedLayer.toJSON()).toMatchObject({
      type: "image",
      opacity: 0.25,
      crossSectionRenderScale: 2,
    });
  });

  it("keeps settings for a detected annotation layer", () => {
    const { managedLayer } = makeAutoLayer({ annotationColor: "#ff0000" });
    managedLayer.layer!.activateDataSubsources([
      makeLoadedSubsource({ annotation: {} }),
    ]);
    expect(managedLayer.layer).toBeInstanceOf(AnnotationUserLayer);
    expect(managedLayer.toJSON()).toMatchObject({
      type: "annotation",
      annotationColor: "#ff0000",
    });
  });

  it("stays an auto layer if the detected layer type rejects a setting", () => {
    const { manager, managedLayer } = makeAutoLayer({ blend: "bogus" });
    const { localBinders } = manager.root.toolBinder;
    const numLocalBinders = localBinders.size;
    expect(() =>
      managedLayer.layer!.activateDataSubsources([makeImageSubsource()]),
    ).toThrow('Error parsing "blend" property');
    expect(managedLayer.layer).toBeInstanceOf(AutoUserLayer);
    // The image layer created for the failed type change is disposed.
    expect(localBinders.size).toBe(numLocalBinders);
  });

  it("keeps specified settings after the multi-channel setup", () => {
    const managedLayer = makeAutoDetectedImageLayer({
      opacity: 0.25,
      blend: "default",
      volumeRenderingDepthSamples: 64,
    });
    // The multi-channel setup runs once the detected layer is ready.
    managedLayer.readyStateChanged.dispatch();
    const layer = managedLayer.layer as ImageUserLayer;
    expect(layer.opacity.value).toBe(0.25);
    expect(layer.blendMode.value).toBe(BLEND_MODES.DEFAULT);
    expect(layer.volumeRenderingDepthSamplesTarget.value).toBe(64);
  });

  it("uses the multi-channel defaults for settings that are not specified", () => {
    const managedLayer = makeAutoDetectedImageLayer({});
    managedLayer.readyStateChanged.dispatch();
    const layer = managedLayer.layer as ImageUserLayer;
    expect(layer.opacity.value).toBe(1);
    expect(layer.blendMode.value).toBe(BLEND_MODES.ADDITIVE);
    expect(layer.volumeRenderingDepthSamplesTarget.value).toBe(256);
  });
});
