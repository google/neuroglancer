/**
 * @license
 * Copyright 2017 Google Inc.
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

/**
 * @file Facility for triggering named actions in response to mouse events.
 */

import {RefCounted} from 'neuroglancer/util/disposable';
import {ActionEvent, dispatchEventWithModifiers, EventActionMap, EventActionMapInterface, registerActionListener} from 'neuroglancer/util/event_action_map';

export class MouseEventBinder<EventMap extends EventActionMapInterface> extends RefCounted {
  private dispatch(baseIdentifier: string, event: MouseEvent) {
    dispatchEventWithModifiers(baseIdentifier, event, event, this.eventMap);
  }
  constructor(
      public target: EventTarget, public eventMap: EventMap,
      commonHandler?: (event: MouseEvent) => void) {
    super();
    this.registerEventListener(target, 'wheel', (event: WheelEvent) => {
      if (commonHandler !== undefined) commonHandler(event);
      this.dispatch('wheel', event);
    });
    this.registerEventListener(target, 'click', (event: MouseEvent) => {
      if (commonHandler !== undefined) commonHandler(event);
      this.dispatch(`click${event.button}`, event);
    });
    this.registerEventListener(target, 'dblclick', (event: MouseEvent) => {
      if (commonHandler !== undefined) commonHandler(event);
      this.dispatch(`dblclick${event.button}`, event);
    });
    this.registerEventListener(target, 'mousedown', (event: MouseEvent) => {
      if (commonHandler !== undefined) commonHandler(event);
      this.dispatch(`mousedown${event.button}`, event);
    });
    this.registerEventListener(target, 'mouseup', (event: MouseEvent) => {
      if (commonHandler !== undefined) commonHandler(event);
      this.dispatch(`mouseup${event.button}`, event);
    });
  }
}

export {EventActionMap, registerActionListener};
export type {EventActionMapInterface, ActionEvent}
