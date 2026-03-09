/**
 * @license
 * Copyright 2016 Google Inc.
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

import { schemePattern } from "#src/kvstore/url.js";
import type { UserLayer } from "#src/layer/index.js";
import { layerTypes } from "#src/layer/index.js";
import { StatusMessage } from "#src/status.js";
import {
  bindDefaultCopyHandler,
  bindDefaultPasteHandler,
} from "#src/ui/default_clipboard_handling.js";
import { setDefaultInputEventBindings } from "#src/ui/default_input_event_bindings.js";
import { makeDefaultViewer } from "#src/ui/default_viewer.js";
import { bindTitle } from "#src/ui/title.js";
import type { Tool } from "#src/ui/tool.js";
import { restoreTool } from "#src/ui/tool.js";
import { UrlHashBinding } from "#src/ui/url_hash_binding.js";
import type {
  ActionIdentifier,
  EventAction,
  EventActionMap,
  EventIdentifier,
} from "#src/util/event_action_map.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import type { Viewer } from "#src/viewer.js";

declare let NEUROGLANCER_DEFAULT_STATE_FRAGMENT: string | undefined;

type CustomToolBinding = {
  layerType: string;
  tool: unknown;
  provider?: string;
};

type CustomBinding = {
  action: EventAction | ActionIdentifier | CustomToolBinding | boolean;
  context?: "global" | "perspectiveView" | "sliceView";
};

type CustomBindings = {
  [identifier: EventIdentifier]: CustomBinding | CustomBinding[];
};

declare const NEUROGLANCER_CUSTOM_INPUT_BINDINGS: CustomBindings | undefined;

export const hasCustomBindings =
  typeof NEUROGLANCER_CUSTOM_INPUT_BINDINGS !== "undefined" &&
  Object.keys(NEUROGLANCER_CUSTOM_INPUT_BINDINGS).length > 0;

function setCustomInputEventBindings(viewer: Viewer, bindings: CustomBindings) {
  const bindNonLayerSpecificTool = (
    key: string,
    customBinding: CustomToolBinding,
  ) => {
    const { layerType, provider: desiredProvider } = customBinding;
    let toolJson = customBinding.tool;
    const desiredLayerConstructor = layerTypes.get(layerType);
    if (desiredLayerConstructor === undefined) {
      throw new Error(`Invalid layer type: ${layerType}`);
    }
    const toolKey = key.charAt(key.length - 1).toUpperCase();
    let previousTool: Tool<object> | undefined;
    let previousLayer: UserLayer | undefined;
    if (typeof toolJson === "string") {
      toolJson = { type: toolJson };
    }
    verifyObject(toolJson);
    const type = verifyObjectProperty(toolJson, "type", verifyString);
    const action = `tool-${type}`;
    viewer.bindAction(action, () => {
      const acceptableLayers = viewer.layerManager.managedLayers.filter(
        (managedLayer) => {
          const correctLayerType =
            managedLayer.layer instanceof desiredLayerConstructor;
          if (desiredProvider && correctLayerType) {
            for (const dataSource of managedLayer.layer?.dataSources || []) {
              const m = dataSource.spec.url.match(schemePattern)!;
              const scheme = m[1];
              if (scheme === desiredProvider) {
                return true;
              }
            }
            return false;
          } else {
            return correctLayerType;
          }
        },
      );
      if (acceptableLayers.length > 0) {
        const firstLayer = acceptableLayers[0].layer;
        if (firstLayer) {
          if (firstLayer !== previousLayer) {
            previousTool = restoreTool(firstLayer, toolJson);
            previousLayer = firstLayer;
          }
          if (previousTool) {
            viewer.activateTool(toolKey, previousTool);
          }
        }
      }
    });
    return action;
  };

  const deleteKey = (map: EventActionMap, key: string) => {
    map.delete(key);
    for (const pMap of map.parents) {
      deleteKey(pMap, key);
    }
  };

  for (const [key, val] of Object.entries(bindings)) {
    const bindings = Array.isArray(val) ? val : [val];
    for (const { action, context = "global" } of bindings) {
      const actionMap = viewer.inputEventBindings[context];
      if (actionMap === undefined) {
        throw new Error(`invalid action map context: ${context}`);
      }
      if (typeof action === "boolean") {
        if (action === false) {
          deleteKey(actionMap, key);
        }
      } else if (typeof action === "string" || "action" in action) {
        actionMap.set(key, action);
      } else {
        const toolAction = bindNonLayerSpecificTool(key, action);
        actionMap.set(key, toolAction);
      }
    }
  }
}

/**
 * Sets up the default neuroglancer viewer.
 */
export function setupDefaultViewer() {
  const viewer = ((<any>window).viewer = makeDefaultViewer());
  setDefaultInputEventBindings(viewer.inputEventBindings);
  if (hasCustomBindings) {
    setCustomInputEventBindings(viewer, NEUROGLANCER_CUSTOM_INPUT_BINDINGS!);
  }

  const hashBinding = viewer.registerDisposer(
    new UrlHashBinding(
      viewer.state,
      viewer.dataSourceProvider.sharedKvStoreContext,
      {
        defaultFragment:
          typeof NEUROGLANCER_DEFAULT_STATE_FRAGMENT !== "undefined"
            ? NEUROGLANCER_DEFAULT_STATE_FRAGMENT
            : undefined,
      },
    ),
  );
  viewer.registerDisposer(
    hashBinding.parseError.changed.add(() => {
      const { value } = hashBinding.parseError;
      if (value !== undefined) {
        const status = new StatusMessage();
        status.setErrorMessage(`Error parsing state: ${value.message}`);
        console.log("Error parsing state", value);
      }
      hashBinding.parseError;
    }),
  );
  hashBinding.updateFromUrlHash();
  viewer.registerDisposer(bindTitle(viewer.title));

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  return viewer;
}
