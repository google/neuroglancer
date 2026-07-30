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

import { describe, expect, it } from "vitest";
import type { LayerListSpecification, UserLayer } from "#src/layer/index.js";
import { LayerManager, ManagedUserLayer } from "#src/layer/index.js";
import { NullarySignal } from "#src/util/signal.js";

// The sweep that removes unreferenced layers is debounced with a zero delay, so
// it runs on the next macrotask.
function flushRemoveLayers() {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

// `ManagedUserLayer` needs only a display to drive playback, and the set of
// layer group subsets to move itself out of when it is archived.
function makeFixture() {
  const layerManager = new LayerManager();
  const rootLayers = {
    layersChanged: new NullarySignal(),
    specificationChanged: new NullarySignal(),
  };
  const manager = {
    root: {
      display: { updateStarted: new NullarySignal(), scheduleRedraw() {} },
      subsets: new Set(),
    },
    rootLayers,
  } as unknown as LayerListSpecification;
  return { layerManager, manager };
}

// A layer whose user layer has been loaded.  Only the signals the setter binds
// to, plus disposal, are exercised here.
function makeUserLayer(): UserLayer {
  return {
    layersChanged: new NullarySignal(),
    readyStateChanged: new NullarySignal(),
    specificationChanged: new NullarySignal(),
    dispose() {},
  } as unknown as UserLayer;
}

function addLayer(
  layerManager: LayerManager,
  manager: LayerListSpecification,
  name: string,
  { loaded = true } = {},
) {
  const layer = new ManagedUserLayer(name, manager);
  if (loaded) {
    layer.layer = makeUserLayer();
  }
  layerManager.addManagedLayer(layer);
  return layer;
}

describe("LayerManager", () => {
  it("archives a layer that no layer group references", async () => {
    // A state may define a layer while using a custom layout that does not
    // display it.  The layer ends up referenced only by the root layer manager,
    // and must be archived rather than silently dropped.
    const { layerManager, manager } = makeFixture();
    const layer = addLayer(layerManager, manager, "image");

    await flushRemoveLayers();

    expect(layerManager.managedLayers).toContain(layer);
    expect(layer.archived).toBe(true);
    expect(layer.visible).toBe(false);
  });

  it("archives a layer when its last layer group reference is released", async () => {
    // A displayed layer is referenced by the root layer manager and by a layer
    // group, and must be left alone; once the group's reference is released,
    // the sweep archives it rather than deleting it.
    const { layerManager, manager } = makeFixture();
    const layer = addLayer(layerManager, manager, "image");
    const groupRef = layer.addRef();

    await flushRemoveLayers();

    expect(layer.archived).toBe(false);
    expect(layer.visible).toBe(true);

    groupRef.dispose();
    // Releasing a layer notifies the root layer manager, as
    // `unbindManagedLayer` does in production.
    layerManager.layersChanged.dispatch();
    await flushRemoveLayers();

    expect(layerManager.managedLayers).toContain(layer);
    expect(layer.archived).toBe(true);
    expect(layer.visible).toBe(false);
  });

  it("leaves an already archived layer alone", async () => {
    const { layerManager, manager } = makeFixture();
    const layer = addLayer(layerManager, manager, "image");
    layer.setArchived(true);

    await flushRemoveLayers();

    expect(layerManager.managedLayers).toContain(layer);
    expect(layer.archived).toBe(true);
  });

  it("removes a transient drag target rather than archiving it", async () => {
    // A layer with no user layer is a drag target, not something the user asked
    // for, so it must still be discarded.
    const { layerManager, manager } = makeFixture();
    const dragTarget = addLayer(layerManager, manager, "drag", {
      loaded: false,
    });

    await flushRemoveLayers();

    expect(layerManager.managedLayers).not.toContain(dragTarget);
  });

  it("leaves layers alone while the manager is in direct use", async () => {
    // A layer group viewer pins its own layer manager, and layers displayed
    // there must keep their visibility.
    const { layerManager, manager } = makeFixture();
    const release = layerManager.useDirectly();
    const layer = addLayer(layerManager, manager, "image");

    await flushRemoveLayers();

    expect(layerManager.managedLayers).toContain(layer);
    expect(layer.archived).toBe(false);
    expect(layer.visible).toBe(true);
    release();
  });
});
