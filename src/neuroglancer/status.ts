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

require('./status.css');

let statusContainer: HTMLElement|null = null;

export var DEFAULT_STATUS_DELAY = 200;

export type Delay = boolean | number;

export class StatusMessage {
  element: HTMLElement;
  private timer: number|null;
  constructor(delay: Delay = false) {
    if (statusContainer === null) {
      statusContainer = document.createElement('ul');
      statusContainer.id = 'statusContainer';
      document.body.appendChild(statusContainer);
    }
    let element = document.createElement('li');
    this.element = element;
    if (delay === true) {
      delay = DEFAULT_STATUS_DELAY;
    }
    if (delay !== false) {
      this.setVisible(false);
      this.timer = setTimeout(this.setVisible.bind(this, true), delay);
    } else {
      this.timer = null;
    }
    statusContainer.appendChild(element);
  }
  dispose() {
    statusContainer!.removeChild(this.element);
    this.element = <any>undefined;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
  }
  setText(text: string, makeVisible?: boolean) {
    this.element.textContent = text;
    if (makeVisible) {
      this.setVisible(true);
    }
  }
  setHTML(text: string, makeVisible?: boolean) {
    this.element.innerHTML = text;
    if (makeVisible) {
      this.setVisible(true);
    }
  }
  setVisible(value: boolean) {
    this.timer = null;
    this.element.style.display = value ? 'block' : 'none';
  }

  static forPromise<T>(
      promise: Promise<T>,
      options: {initialMessage: string, delay?: Delay, errorPrefix: string}): Promise<T> {
    let status = new StatusMessage(options.delay);
    status.setText(options.initialMessage);
    let dispose = status.dispose.bind(status);
    promise.then(dispose, reason => {
      let msg: string;
      if (reason instanceof Error) {
        msg = reason.message;
      } else {
        msg = '' + reason;
      }
      let {errorPrefix = ''} = options;
      status.element.textContent = errorPrefix + msg + '  ';
      let button = document.createElement('button');
      button.textContent = 'Dismiss';
      button.addEventListener('click', () => {
        status.dispose();
      });
      status.element.appendChild(button);
      status.setVisible(true);
    });
    return promise;
  }

  static showMessage(message: string): StatusMessage {
    const msg = new StatusMessage();
    msg.element.textContent = message;
    msg.setVisible(true);
    return msg;
  }
}
