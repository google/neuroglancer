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
      let button = event.button;
      // Under Firefox on macOS, pressing the left mouse button while holding
      // control results in a mouse event with `button` set to 2 (incorrectly
      // indicating the right mouse button) but `buttons` set to 1 (correctly
      // indicating that only the left mouse button is down).  This attempts to
      // reverse that translation.
      //
      // https://github.com/google/neuroglancer/issues/365
      //
      // Notes:
      //
      // - If both the left and right mouse buttons are both pressed at the same
      //   time, this method of disambiguation does not work.
      //
      // - Firefox seems to "remember" that this translation of the button
      //   number was done, and also sends the `mouseup` event with a button
      //   number of 2, even if the control key was released before releasing
      //   the mouse button.  That means `mouse_drag.ts` works unmodified with
      //   this translation (since it waits for a mouseup event with the same
      //   button number).
      //
      // - This method of disambiguation does not work for `mouseup` events,
      //   since the button has already been released and therefore is not
      //   included in `buttons` anyway.  Fortunately `mouseup` events are not
      //   commonly used in Neuroglancer.
      if (button === 2 && (event.buttons & 3) === 1) {
        // `button` is 2 (right button), but only the left button is currently pressed.
        button = 0;
      }
      this.dispatch(`mousedown${button}`, event);
    });
    this.registerEventListener(target, 'mouseup', (event: MouseEvent) => {
      if (commonHandler !== undefined) commonHandler(event);
      this.dispatch(`mouseup${event.button}`, event);
    });
  }
}

export {EventActionMap, registerActionListener};
export type {EventActionMapInterface, ActionEvent}
