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
import {StatusMessage} from 'neuroglancer/status';
import {RefCounted} from 'neuroglancer/util/disposable';
import {HttpError} from 'neuroglancer/util/http_request';
import {getRandomHexString} from 'neuroglancer/util/random';
import {getCachedJson, Trackable} from 'neuroglancer/util/trackable';

const DEBUG = false;

function getServerUrls() {
  const match = window.location.pathname.match(/^(.*)\/v\/([^\/]+)/);
  if (match === null) {
    throw new Error('Failed to determine token from URL.');
  }
  const prefix = `${window.location.origin}${match[1]}`.replace(/\/+$/, '');
  const token = match[2];
  return {
    socket: `${prefix}/socket/${token}`,
    action: `${prefix}/action/${token}`,
    events: `${prefix}/events/${token}`,
    state: `${prefix}/state/${token}`,
    credentials: `${prefix}/credentials/${token}`,
  };
}

export class ClientStateSynchronizer extends RefCounted {
  clientGeneration = -1;
  lastServerState = '';
  lastServerGeneration = '';
  private needUpdate = false;
  private updateInProgress = false;

  constructor(
      public client: Client, public state: Trackable, updateDelayMilliseconds: number|null) {
    super();
    if (updateDelayMilliseconds !== null) {
      this.registerDisposer(state.changed.add(this.registerCancellable(throttle(
          this.registerCancellable(debounce(() => this.handleStateChanged(), 0)),
          updateDelayMilliseconds, {leading: false}))));
    }
  }

  private async handleStateChanged() {
    this.needUpdate = true;
    if (this.updateInProgress) {
      return;
    }
    while (this.needUpdate) {
      this.needUpdate = false;
      const clientGeneration = this.state.changed.count;
      if (clientGeneration == this.clientGeneration) {
        return;
      }
      const newStateJson = getCachedJson(this.state).value;
      const newStateEncoded = JSON.stringify(newStateJson);
      if (newStateEncoded === this.lastServerState) {
        // Avoid sending back the exact same state just received from or sent to the server.  This
        // is also important for making things work in the presence of multiple simultaneous
        // clients.
        this.clientGeneration = clientGeneration;
        return;
      }
      if (DEBUG) {
        console.log('Sending update due to mismatch: ', {
          newStateEncoded,
          lastServerState: this.lastServerState,
          lastServerGeneration: this.lastServerGeneration
        });
      }
      try {
        this.updateInProgress = true;
        const response = await fetch(this.client.urls.state, {
          method: 'POST',
          body: JSON.stringify({
            s: newStateJson,
            g: clientGeneration,
            pg: this.lastServerGeneration,
            c: this.client.clientId
          })
        });
        this.updateInProgress = false;
        if (response.status === 200) {
          const responseJson = await response.json();
          this.lastServerState = newStateEncoded;
          this.lastServerGeneration = responseJson['g'];
          this.clientGeneration = clientGeneration;
        } else if (response.status === 412) {
          const responseJson = await response.json();
          const newState = responseJson['s'];
          const newGeneration = responseJson['g'];
          this.setServerState(newState, newGeneration);
        } else {
          throw HttpError.fromResponse(response);
        }
      } catch (e) {
        this.updateInProgress = false;
        console.log('Failed to send state update', e);
        return;
      }
    }
  }

  setServerState(state: any, generation: string) {
    const trackable = this.state;
    trackable.reset();
    trackable.restoreState(state);
    this.lastServerState = JSON.stringify(state);
    this.clientGeneration = trackable.changed.count;
    this.lastServerGeneration = generation;
  }
}

export class ClientStateReceiver extends RefCounted {
  private numConnectionFailures = 0;
  status = this.registerDisposer(new StatusMessage(true));
  waitingToReconnect: number = -1;
  eventSource: EventSource|undefined;

  constructor(public client: Client, public states: Map<string, ClientStateSynchronizer>) {
    super();
    this.connect();
  }

  disposed() {
    this.eventSource?.close();
    if (this.waitingToReconnect !== -1) {
      clearInterval(this.waitingToReconnect);
      this.waitingToReconnect = -1;
    }
  }

  connect() {
    this.status.setText('Connecting to Python server');
    this.status.setVisible(true);
    const url = new URL(this.client.urls.events);
    url.searchParams.set('c', this.client.clientId);
    for (const [key, synchronizer] of this.states) {
      url.searchParams.set(`g${key}`, synchronizer.lastServerGeneration);
    }
    const eventSource = this.eventSource = new EventSource(url.toString());
    eventSource.onmessage = (ev: MessageEvent<string>) => {
      const msg = JSON.parse(ev.data);
      if (DEBUG) {
        console.log('got message', msg);
      }
      const generation = msg['g'];
      const key = msg['k'];
      const state = msg['s'];
      const synchronizer = this.states.get(key);
      if (synchronizer === undefined) {
        console.log('unexpected state update for key: ', key);
        return;
      }
      synchronizer.setServerState(state, generation);
    };
    eventSource.onerror = () => {
      console.log('python state event source disconnected');
      eventSource.close();
      this.eventSource = undefined;
      const reconnectionDelay =
          Math.min(30000, 100 * Math.pow(2, Math.min(20, this.numConnectionFailures)));
      const reconnectTime = Date.now() + reconnectionDelay;
      ++this.numConnectionFailures;
      this.status.setVisible(true);
      const updateStatus = (remaining: number) => {
        this.status.setText(
            `Disconnected from Python server.  ` +
            `Retrying in ${Math.ceil(remaining / 1000)} seconds.`);
      };
      this.waitingToReconnect = window.setInterval(() => {
        const remaining = reconnectTime - Date.now();
        if (remaining < 0) {
          window.clearInterval(this.waitingToReconnect);
          this.waitingToReconnect = -1;
          this.connect();
        } else {
          updateStatus(remaining);
        }
      }, 1000);
      updateStatus(reconnectionDelay);
    };
    eventSource.onopen = () => {
      this.status.setVisible(false);
      console.log('python state event source connected');
      this.numConnectionFailures = 0;
    };
  }
}

export class Client {
  urls = getServerUrls();
  clientId = getRandomHexString();

  sendActionNotification(action: string, state: any) {
    fetch(this.urls.action, {method: 'POST', body: JSON.stringify({action, state})});
  }
}
