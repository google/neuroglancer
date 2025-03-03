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

import "#src/help/input_event_bindings.css";
import type { LayerManager } from "#src/layer/index.js";
import { UserLayer } from "#src/layer/index.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";
import type { SidePanelLocation } from "#src/ui/side_panel_location.js";
import {
  DEFAULT_SIDE_PANEL_LOCATION,
  TrackableSidePanelLocation,
} from "#src/ui/side_panel_location.js";
import type { GlobalToolBinder } from "#src/ui/tool.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { removeChildren } from "#src/util/dom.js";
import {
  friendlyEventIdentifier,
  type EventActionMap,
} from "#src/util/event_action_map.js";
import { emptyToUndefined } from "#src/util/json.js";

declare let NEUROGLANCER_BUILD_INFO:
  | { tag: string; url?: string; timestamp?: string }
  | undefined;

export function formatKeyName(name: string) {
  if (name.startsWith("key")) {
    return name.substring(3);
  }
  if (name.startsWith("digit")) {
    return name.substring(5);
  }
  if (name.startsWith("arrow")) {
    return name.substring(5);
  }
  return name;
}

export function formatKeyStroke(stroke: string) {
  const parts = stroke.split("+");
  return parts.map(formatKeyName).join("+");
}

const DEFAULT_HELP_PANEL_LOCATION: SidePanelLocation = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: "left",
  row: 1,
};

export class HelpPanelState {
  location = new TrackableSidePanelLocation(DEFAULT_HELP_PANEL_LOCATION);
  get changed() {
    return this.location.changed;
  }
  toJSON() {
    return emptyToUndefined(this.location.toJSON());
  }
  reset() {
    this.location.reset();
  }
  restoreState(obj: unknown) {
    this.location.restoreState(obj);
  }
}

interface BindingList {
  label: string;
  entries: Map<string, string>;
}

function collectBindings(
  bindings: Iterable<[string, EventActionMap]>,
): Map<EventActionMap, BindingList> {
  const uniqueMaps = new Map<EventActionMap, BindingList>();
  function addEntries(eventMap: EventActionMap, entries: Map<string, string>) {
    for (const parent of eventMap.parents) {
      if (parent.label !== undefined) {
        addMap(parent.label, parent);
      } else {
        addEntries(parent, entries);
      }
    }
    for (const [event, eventAction] of eventMap.bindings.entries()) {
      entries.set(
        friendlyEventIdentifier(eventAction.originalEventIdentifier ?? event),
        eventAction.action,
      );
    }
  }

  function simplifyEntries(entries: Map<string, string>) {
    const identifierMap = new Map<string, [string, string]>();

    function increment(x: string, i: number) {
      return (
        x.slice(0, -1) + String.fromCharCode(x.charCodeAt(x.length - 1) + i)
      );
    }

    function makeRange(x: string, count: number) {
      const start = x.slice(-1);
      const end = increment(start, count - 1);
      return x.slice(0, -1) + "[" + start + "-" + end + "]";
    }

    for (const [identifier, action] of entries) {
      // Check for a-z
      if (
        (identifier.endsWith("a") && action.toLowerCase().endsWith("a")) ||
        (identifier.endsWith("1") && action.endsWith("1"))
      ) {
        for (let i = 1; ; ++i) {
          const otherIdentifier = increment(identifier, i);
          const otherAction = increment(action, i);
          if (entries.get(otherIdentifier) === otherAction) {
            entries.delete(otherIdentifier);
            continue;
          }

          if (i !== 1) {
            identifierMap.set(identifier, [
              makeRange(identifier, i),
              makeRange(action, i),
            ]);
          }
          break;
        }
      }
    }

    const newEntries = new Map<string, string>();
    for (let [identifier, action] of entries) {
      const remapped = identifierMap.get(identifier);
      [identifier, action] = remapped ?? [identifier, action];
      newEntries.set(identifier, action);
    }
    return newEntries;
  }

  function addMap(label: string, map: EventActionMap) {
    if (uniqueMaps.has(map)) {
      return;
    }
    const list: BindingList = {
      label,
      entries: new Map(),
    };
    addEntries(map, list.entries);
    list.entries = simplifyEntries(list.entries);
    uniqueMaps.set(map, list);
  }
  for (const [label, eventMap] of bindings) {
    addMap(label, eventMap);
  }

  return uniqueMaps;
}

export class InputEventBindingHelpDialog extends SidePanel {
  scroll = document.createElement("div");

  constructor(
    sidePanelManager: SidePanelManager,
    state: HelpPanelState,
    private bindings: Iterable<[string, EventActionMap]>,
    layerManager: LayerManager,
    private toolBinder: GlobalToolBinder,
  ) {
    super(sidePanelManager, state.location);

    this.addTitleBar({ title: "Help" });
    const body = document.createElement("div");
    body.classList.add("neuroglancer-help-body");

    const { scroll } = this;
    scroll.classList.add("neuroglancer-help-scroll-container");
    body.appendChild(scroll);
    this.addBody(body);
    const debouncedUpdateView = this.registerCancellable(
      animationFrameDebounce(() => this.updateView()),
    );
    this.registerDisposer(toolBinder.changed.add(debouncedUpdateView));
    this.registerDisposer(layerManager.layersChanged.add(debouncedUpdateView));
    this.updateView();
  }
  private updateView() {
    const { scroll, bindings, toolBinder } = this;
    removeChildren(scroll);

    if (typeof NEUROGLANCER_BUILD_INFO !== "undefined") {
      const header = document.createElement("h2");
      header.textContent = "Build info";
      const buildInfoElement = document.createElement("div");
      buildInfoElement.classList.add("neuroglancer-build-info");
      const tagElement = document.createElement("a");
      const { tag, url, timestamp } = NEUROGLANCER_BUILD_INFO;
      tagElement.textContent = tag;
      tagElement.target = "_blank";
      if (url !== undefined) {
        tagElement.href = url;
      }
      scroll.appendChild(header);
      buildInfoElement.appendChild(tagElement);
      if (timestamp !== undefined) {
        const timestampElement = document.createElement("div");
        timestampElement.classList.add("neuroglancer-build-timestamp");
        const timestampString = Intl.DateTimeFormat("en", {
          hour12: false,
          dateStyle: "medium",
          timeStyle: "long",
        }).format(new Date(timestamp));
        timestampElement.textContent = `Built at ${timestampString}`;
        buildInfoElement.append(timestampElement);
      }
      scroll.appendChild(buildInfoElement);
    }

    const uniqueMaps = collectBindings(bindings);

    const addGroup = (title: string, entries: Iterable<[string, string]>) => {
      const header = document.createElement("h2");
      header.textContent = title;
      scroll.appendChild(header);
      for (const [event, action] of entries) {
        const dt = document.createElement("div");
        dt.className = "dt";
        dt.textContent = formatKeyStroke(event);
        const dd = document.createElement("div");
        dd.className = "dd";
        dd.textContent = action;
        scroll.appendChild(dt);
        scroll.appendChild(dd);
      }
    };

    const layerToolBindingsMap = new Map<UserLayer, [string, string][]>();
    for (const [key, tool] of toolBinder.bindings) {
      if (tool.context instanceof UserLayer) {
        let layerBindings = layerToolBindingsMap.get(tool.context);
        if (layerBindings === undefined) {
          layerBindings = [];
          layerToolBindingsMap.set(tool.context, layerBindings);
        }
        layerBindings.push([`shift+key${key.toLowerCase()}`, tool.description]);
      }
    }
    const layerToolBindings = Array.from(layerToolBindingsMap.entries());
    if (layerToolBindings.length > 0) {
      layerToolBindings[0][0].manager.root.layerManager.updateNonArchivedLayerIndices();
      layerToolBindings.sort(
        (a, b) =>
          a[0].managedLayer.nonArchivedLayerIndex -
          b[0].managedLayer.nonArchivedLayerIndex,
      );
    }

    for (const [layer, bindings] of layerToolBindings) {
      bindings.sort();
      addGroup(
        `Tool bindings for layer ${
          layer.managedLayer.nonArchivedLayerIndex + 1
        }: ${layer.managedLayer.name}`,
        bindings,
      );
    }

    for (const list of uniqueMaps.values()) {
      addGroup(list.label, list.entries);
    }
  }
}
