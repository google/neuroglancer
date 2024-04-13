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
 * @file Facility for updating an EventActionMap based on a JSON representation.
 */

import { EventActionMap } from "#src/util/event_action_map.js";
import { verifyObject, verifyString } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

export class TrackableBasedEventActionMap implements Trackable {
  eventActionMap = new EventActionMap();
  changed = new NullarySignal();

  reset() {
    this.eventActionMap.clear();
    this.changed.dispatch();
  }

  restoreState(obj: any) {
    verifyObject(obj);
    const { eventActionMap } = this;
    for (const key of Object.keys(obj)) {
      const action = verifyString(obj[key]);
      eventActionMap.set(key, action);
    }
    this.changed.dispatch();
  }

  toJSON() {
    const result: { [key: string]: string } = {};
    for (const [key, eventAction] of this.eventActionMap.bindings) {
      result[key] = eventAction.action;
    }
    return result;
  }
}
