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
 * @file Facility for displaying remote status messages.
 */

import debounce from 'lodash/debounce';
import {StatusMessage} from 'neuroglancer/status';
import {NullarySignal} from 'neuroglancer/util/signal';
import {RefCounted} from 'neuroglancer/util/disposable';
import {verifyObject, verifyString} from 'neuroglancer/util/json';

export class TrackableBasedStatusMessages extends RefCounted {
  existingMessages = new Map<string, StatusMessage>();

  changed = new NullarySignal();

  messages = new Map<string, string>();

  reset() {
    this.messages.clear();
    this.changed.dispatch();
  }

  restoreState(obj: any) {
    verifyObject(obj);
    this.messages.clear();
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      const text = verifyString(value);
      this.messages.set(key, text);
    }
    this.changed.dispatch();
  }

  constructor () {
    super();
    this.changed.add(this.registerCancellable(debounce(() => this.updateMessages(), 0)));
  }

  disposed() {
    for (const message of this.existingMessages.values()) {
      message.dispose();
    }
    this.existingMessages.clear();
  }

  private updateMessages() {
    const {existingMessages} = this;
    const newMessages = this.messages;

    for (const [key, existingMessage] of existingMessages) {
      const newMessage = newMessages.get(key);
      if (newMessage === undefined) {
        existingMessage.dispose();
        existingMessages.delete(key);
      } else {
        existingMessage.setText(newMessage);
      }
    }

    for (const [key, newMessage] of newMessages) {
      if (existingMessages.has(key)) {
        // Already handled by previous loop.
        continue;
      }
      const existingMessage = new StatusMessage();
      existingMessage.setText(newMessage);
      existingMessages.set(key, existingMessage);
    }
  }

  toJSON () {
    const result: any = {};
    for (const [key, value] of this.messages) {
      result[key] = value;
    }
    return result;
  }
}
