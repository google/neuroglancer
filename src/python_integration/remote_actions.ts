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
 * @file Facility for remote action handling.
 */

import { debounce } from "lodash-es";
import { TrackableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import { verifyStringArray } from "#src/util/json.js";
import { Signal } from "#src/util/signal.js";
import { getCachedJson } from "#src/util/trackable.js";
import type { Viewer } from "#src/viewer.js";

export class RemoteActionHandler extends RefCounted {
  actionSet = new TrackableValue(
    new Set<string>(),
    (x) => new Set(verifyStringArray(x)),
  );

  actionDisposers: (() => void)[] = [];

  sendActionRequested = new Signal<(action: string, state: any) => void>();

  constructor(public viewer: Viewer) {
    super();
    this.actionSet.changed.add(debounce(() => this.updateActions(), 0));
  }

  private clearListeners() {
    for (const disposer of this.actionDisposers) {
      disposer();
    }
    this.actionDisposers.length = 0;
  }

  disposed() {
    this.clearListeners();
    super.disposed();
  }

  private updateActions() {
    this.clearListeners();
    for (const action of this.actionSet.value) {
      this.actionDisposers.push(
        registerActionListener(this.viewer.element, action, () =>
          this.handleAction(action),
        ),
      );
    }
  }

  private handleAction(action: string) {
    const { mouseState, layerSelectedValues } = this.viewer;
    const actionState: any = {};

    if (mouseState.updateUnconditionally()) {
      actionState.mousePosition = Array.prototype.slice.call(
        mouseState.position,
      );
    }
    actionState.selectedValues = layerSelectedValues.toJSON();
    actionState.viewerState = getCachedJson(this.viewer.state).value;
    this.sendActionRequested.dispatch(
      action,
      JSON.parse(JSON.stringify(actionState)),
    );
  }
}
