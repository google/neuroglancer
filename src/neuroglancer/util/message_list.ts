/**
 * @license
 * Copyright 2019 Google Inc.
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
 * @file Message list framework for messages to be displayed in the UI.
 */

import {NullarySignal} from 'neuroglancer/util/signal';

export enum MessageSeverity {
  info,
  warning,
  error
}

export class Message {
  severity: MessageSeverity;
  message: string;
}

export class MessageList {
  changed = new NullarySignal();

  private messages: Message[] = [];
  private children: MessageList[] = [];

  addMessage(message: Message) {
    this.messages.push(message);
    this.changed.dispatch();
  }

  clearMessages() {
    const {messages} = this;
    if (messages.length === 0) return;
    messages.length = 0;
    this.changed.dispatch();
  }

  isEmpty(): boolean {
    return this.messages.length === 0 && !this.children.some(x => !x.isEmpty());
  }

  addChild(list: MessageList) {
    this.children.push(list);
    list.changed.add(this.changed.dispatch);
    if (!list.isEmpty()) {
      this.changed.dispatch();
    }
    return () => {
      const {children} = this;
      children.splice(children.indexOf(list), 1);
      list.changed.remove(this.changed.dispatch);
      if (!list.isEmpty()) {
        this.changed.dispatch();
      }
    };
  }

  * [Symbol.iterator](): Iterator<Message> {
    yield* this.messages;
    for (const child of this.children) {
      yield* child;
    }
  }
}
