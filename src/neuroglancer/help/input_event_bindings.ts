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

import './input_event_bindings.css';

import {SidePanel, SidePanelManager} from 'neuroglancer/ui/side_panel';
import {DEFAULT_SIDE_PANEL_LOCATION, SidePanelLocation, TrackableSidePanelLocation} from 'neuroglancer/ui/side_panel_location';
import {EventActionMap} from 'neuroglancer/util/event_action_map';
import {emptyToUndefined} from 'neuroglancer/util/json';

export function formatKeyName(name: string) {
  if (name.startsWith('key')) {
    return name.substring(3);
  }
  if (name.startsWith('digit')) {
    return name.substring(5);
  }
  if (name.startsWith('arrow')) {
    return name.substring(5);
  }
  return name;
}

export function formatKeyStroke(stroke: string) {
  let parts = stroke.split('+');
  return parts.map(formatKeyName).join('+');
}

const DEFAULT_HELP_PANEL_LOCATION: SidePanelLocation = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: 'left',
  row: 1,
};

export class HelpPanelState {
  location = new TrackableSidePanelLocation(DEFAULT_HELP_PANEL_LOCATION);
  get changed() { return this.location.changed; }
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

export class InputEventBindingHelpDialog extends SidePanel {
  constructor(sidePanelManager: SidePanelManager, state: HelpPanelState, bindings: Iterable<[string, EventActionMap]>) {
    super(sidePanelManager, state.location);

    this.addTitleBar({title: 'Help'});
    const body = document.createElement('div');
    body.classList.add('neuroglancer-help-body');

    let scroll = document.createElement('div');
    scroll.classList.add('neuroglancer-help-scroll-container');
    body.appendChild(scroll);
    this.addBody(body);
    interface BindingList {
      label: string;
      entries: Map<string, string>;
    }

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
        const firstColon = event.indexOf(':');
        const suffix = event.substring(firstColon + 1);
        entries.set(suffix, eventAction.action);
      }
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
      uniqueMaps.set(map, list);
    }

    for (const [label, eventMap] of bindings) {
      addMap(label, eventMap);
    }

    for (const list of uniqueMaps.values()) {
      let header = document.createElement('h2');
      header.textContent = list.label;
      scroll.appendChild(header);
      for (const [event, action] of list.entries) {
        let dt = document.createElement('div');
        dt.className = 'dt';
        dt.textContent = formatKeyStroke(event);
        let dd = document.createElement('div');
        dd.className = 'dd';
        dd.textContent = action;
        scroll.appendChild(dt);
        scroll.appendChild(dd);
      }
    }
  }
}
