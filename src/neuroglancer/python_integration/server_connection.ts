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

import {AtomicStateClient} from 'neuroglancer/python_integration/atomic_state_client';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Trackable} from 'neuroglancer/util/trackable';
import SockJS from 'sockjs-client';
import {StatusMessage} from 'neuroglancer/status';

function getServerUrls() {
  const match = window.location.pathname.match(/^(.*)\/v\/([^\/]+)/);
  if (match === null) {
    throw new Error('Failed to determine token from URL.');
  }
  const prefix = `${window.location.origin}${match[1]}`;
  const token = match[2];
  return {
    socketUrl: `${prefix}/socket/${token}`,
    actionUrl: `${prefix}/action/${token}`,
  };
}

const defaultReconnectionDelay = 1000;

const updateDelayMilliseconds = 100;

export class ServerConnection extends RefCounted {
  socket: typeof SockJS.prototype|undefined;
  reconnectionDelay = defaultReconnectionDelay;
  waitingToReconnect: number = -1;
  isOpen = false;
  socketUrl: string;
  actionUrl: string;

  updateClients = new Map<string, AtomicStateClient>();

  status = this.registerDisposer(new StatusMessage(true));

  constructor(
      public sharedState: Trackable|undefined, public privateState: Trackable,
      public configState: Trackable) {
    super();
    Object.assign(this, getServerUrls());
    const statesToUpdate = [
      {key: 'p', state: privateState, receiveUpdates: false, sendUpdates: 0},
      {key: 'c', state: configState, receiveUpdates: true, sendUpdates: null},
    ];
    if (sharedState !== undefined) {
      statesToUpdate.push({
        key: 's',
        state: sharedState,
        receiveUpdates: true,
        sendUpdates: updateDelayMilliseconds
      });
    }
    for (const {key, state, receiveUpdates, sendUpdates} of statesToUpdate) {
      const updateClient =
          this.registerDisposer(new AtomicStateClient(state, sendUpdates, receiveUpdates));
      this.updateClients.set(key, updateClient);
      if (sendUpdates !== null) {
        updateClient.sendUpdateRequested.add(
            (value, generation) => this.send('setState', {k: key, s: value, g: generation}));
      }
      if (receiveUpdates) {
        updateClient.receiveUpdateRequested.add(
            generation => this.send('getState', {g: generation, k: key}));
      }
    }
    this.connect();
  }

  dispose() {
    if (this.socket !== undefined) {
      this.socket.close();
      this.socket = undefined;
    }
    if (this.waitingToReconnect !== -1) {
      clearInterval(this.waitingToReconnect);
      this.waitingToReconnect = -1;
    }
  }

  private send(messageType: string, message: {[key: string]: any}) {
    message['t'] = messageType;
    this.socket!.send(JSON.stringify(message));
  }

  private connect() {
    this.status.setText('Connecting to Python server');
    this.status.setVisible(true);
    const socket = this.socket = new SockJS(this.socketUrl, {transports: ['websocket', 'xhr-streaming']});
    socket.onopen = () => {
      this.isOpen = true;
      this.reconnectionDelay = defaultReconnectionDelay;
      this.status.setVisible(false);
      for (const client of this.updateClients.values()) {
        client.connected = true;
      }
    };
    socket.onclose = () => {
      this.isOpen = false;
      const {reconnectionDelay} = this;
      for (const client of this.updateClients.values()) {
        client.connected = false;
      }
      const reconnectTime = Date.now() + reconnectionDelay;
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
      this.reconnectionDelay = Math.min(30 * 1000, reconnectionDelay * 2);
    };
    socket.onmessage = e => {
      const x = JSON.parse(e.data);
      if (typeof x !== 'object' || Array.isArray(x)) {
        throw new Error('Invalid message received over server connection.');
      }
      switch (x['t']) {
        case 'setState': {
          const updateClient = this.updateClients.get(x['k']);
          if (updateClient === undefined) {
            throw new Error(`Invalid state key: ${JSON.stringify(x['k'])}`);
          }
          updateClient.setState(x['s'], x['g']);
          break;
        }
      }
    };
  }

  sendActionNotification(action: string, state: any) {
    fetch(this.actionUrl, {method: 'POST', body: JSON.stringify({action, state})});
  }
}
