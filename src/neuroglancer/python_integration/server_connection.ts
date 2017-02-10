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

import SockJS from 'sockjs-client';
import {Trackable, CompoundTrackable} from 'neuroglancer/util/trackable';
import {RefCounted} from 'neuroglancer/util/disposable';
import {OperationalTransformationClient, OperationToSubmit} from 'neuroglancer/python_integration/operational_transformation';

function getServerConnectionURL()  {
  const match = window.location.pathname.match(/^\/static\/([^\/]+)\//);
  if (match === null) {
    throw new Error('Failed to determine token from URL.');
  }
  const path = '/socket/' + match[1];
  const viewerToken = window.location.hash.substring(1);
  return `${window.location.origin}/socket/${match[1]}?v=${viewerToken}`;
}

const defaultReconnectionDelay = 1000;

const updateDelayMilliseconds = 100;

export class ServerConnection extends RefCounted {
  socket: typeof SockJS.prototype|undefined;
  reconnectionDelay = defaultReconnectionDelay;
  waitingToReconnect: number = -1;
  isOpen = false;

  otClient: OperationalTransformationClient;

  constructor (public state: Trackable, public url: string = getServerConnectionURL()) {
    super();
    this.connect();

    const otClient = this.otClient =
      this.registerDisposer(new OperationalTransformationClient(state, updateDelayMilliseconds));
    otClient.operationToSubmitPending.add(() => this.maybeSubmitOperation());
  }

  private maybeSubmitOperation() {
    if (!this.isOpen) {
      return;
    }
    const operationToSubmit = this.otClient.getOperationToSubmit(/*resubmit=*/false);
    console.log('maybeSubmitOperation', operationToSubmit);
    if (operationToSubmit !== undefined) {
      this.sendOperation(operationToSubmit);
    }
  }

  private sendOperation(op: OperationToSubmit|undefined) {
    const {serverGeneration} = this.otClient;
    if (op === undefined) {
      this.send('update', {'g': serverGeneration});
    } else {
      this.send('update', {'g': serverGeneration, 'o': op.operation, 'i': op.id});
    }
  }

  dispose () {
    if (this.socket !== undefined) {
      this.socket.close();
      this.socket = undefined;
    }
    if (this.waitingToReconnect !== -1) {
      clearTimeout(this.waitingToReconnect);
      this.waitingToReconnect = -1;
    }
  }

  private send(messageType: string, message: {[key: string]: any}) {
    message['t'] = messageType;
    this.socket!.send(JSON.stringify(message));
  }

  private connect () {
    const socket = this.socket = new SockJS(this.url);
    socket.onopen = () => {
      this.reconnectionDelay = defaultReconnectionDelay;
      this.isOpen = true;

      // FIXME: maybe just initialize otClient and viewer later.
      if (!this.otClient.isInitialized) {
        this.send('getState', {});
      } else {
        this.sendOperation(this.otClient.getOperationToSubmit(/*resubmit=*/true));
      }
    };
    socket.onclose = () => {
      const {reconnectionDelay} = this;
      this.isOpen = false;
      this.waitingToReconnect = setTimeout(() => {
        this.waitingToReconnect = -1;
        this.connect();
      }, reconnectionDelay);
      this.reconnectionDelay = Math.min(30 * 1000, reconnectionDelay * 2);
    };
    socket.onmessage = e => {
      const x = JSON.parse(e.data);
      if (typeof x !== 'object' || Array.isArray(x)) {
        throw new Error('Invalid message received over server connection.');
      }
      console.log('Got message', x);
      switch (x['t']) {
        case 'setState': {
          this.otClient.initialize(x['g'], x['s']);
          break;
        }
        case 'update': {
          this.otClient.applyChange(x['g'], x['o'], x['a']);
          break;
        }
      }
    };
  }
}
