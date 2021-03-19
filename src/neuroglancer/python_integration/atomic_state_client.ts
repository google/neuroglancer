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

import debounce from 'lodash/debounce';
import throttle from 'lodash/throttle';
import {RefCounted} from 'neuroglancer/util/disposable';
import {getRandomHexString} from 'neuroglancer/util/random';
import {Signal} from 'neuroglancer/util/signal';
import {getCachedJson, Trackable} from 'neuroglancer/util/trackable';

export class AtomicStateClient extends RefCounted {
  serverGeneration = '';
  clientGeneration = -1;
  private connected_ = false;
  receiveUpdateRequested = new Signal<(lastGeneration: string) => void>();
  sendUpdateRequested = new Signal<(value: any, generation: string) => void>();
  private lastServerState: string|undefined;
  private sendUpdates: boolean;

  set connected(value: boolean) {
    if (value !== this.connected_) {
      this.connected_ = value;
      if (value === true) {
        if (this.receiveUpdates) {
          this.receiveUpdateRequested.dispatch(this.serverGeneration);
        }
        this.handleStateChanged();
      }
    }
  }

  get connected() {
    return this.connected_;
  }

  /**
   * @param updateDelayMilliseconds If `null`, this client is receive only.  No updates are sent.
   * @param receiveUpdates If `false`, this client doesn't receive updates.
   */
  constructor(
      public state: Trackable, updateDelayMilliseconds: number|null = 100,
      public receiveUpdates = true) {
    super();
    if (updateDelayMilliseconds !== null) {
      this.sendUpdates = true;
      this.registerDisposer(state.changed.add(this.registerCancellable(throttle(
          this.registerCancellable(debounce(() => this.handleStateChanged(), 0)),
          updateDelayMilliseconds, {leading: false}))));
    } else {
      this.sendUpdates = false;
    }
  }

  setState(value: any, generation: string) {
    if (!this.receiveUpdates) {
      return;
    }
    if (generation !== this.serverGeneration) {
      this.lastServerState = JSON.stringify(value);
      this.state.reset();
      this.state.restoreState(value);
      this.serverGeneration = generation;
      this.clientGeneration = this.state.changed.count;
    }
  }

  private handleStateChanged() {
    if (!this.sendUpdates) {
      return;
    }
    if (!this.connected_ || (this.receiveUpdates && this.serverGeneration === '') ||
        this.clientGeneration === this.state.changed.count) {
      return;
    }
    const newStateJson = getCachedJson(this.state).value;
    const newStateEncoded = JSON.stringify(newStateJson);
    if (newStateEncoded === this.lastServerState) {
      // Avoid sending back the exact same state just received from or sent to the server.  This is
      // also important for making things work in the presence of multiple simultaneous clients.
      this.clientGeneration = this.state.changed.count;
      return;
    }
    const generation = getRandomHexString(160);
    this.serverGeneration = generation;
    this.lastServerState = newStateEncoded;
    this.sendUpdateRequested.dispatch(newStateJson, generation);
  }
}
