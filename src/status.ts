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

import "#src/status.css";

import { makeCloseButton } from "#src/widget/close_button.js";

let statusContainer: HTMLElement | null = null;
let modalStatusContainer: HTMLElement | null = null;

export const DEFAULT_STATUS_DELAY = 200;

export type Delay = boolean | number;

export class StatusMessage {
  element: HTMLElement;
  modalElementWrapper: HTMLElement | undefined;
  private timer: number | null;
  constructor(delay: Delay = false, modal = false) {
    if (statusContainer === null) {
      statusContainer = document.createElement("ul");
      statusContainer.id = "statusContainer";
      const el: HTMLElement | null = document.getElementById(
        "neuroglancer-container",
      );
      if (el) {
        el.appendChild(statusContainer);
      } else {
        document.body.appendChild(statusContainer);
      }
    }
    if (modal && modalStatusContainer === null) {
      modalStatusContainer = document.createElement("ul");
      modalStatusContainer.id = "statusContainerModal";
      const el: HTMLElement | null = document.getElementById(
        "neuroglancer-container",
      );
      if (el) {
        el.appendChild(modalStatusContainer);
      } else {
        document.body.appendChild(modalStatusContainer);
      }
    }
    const element = document.createElement("li");
    this.element = element;
    if (delay === true) {
      delay = DEFAULT_STATUS_DELAY;
    }
    if (delay !== false) {
      this.setVisible(false);
      this.timer = window.setTimeout(this.setVisible.bind(this, true), delay);
    } else {
      this.timer = null;
    }
    if (modal) {
      const modalElementWrapper = document.createElement("div");
      const dismissModalElement = makeCloseButton({
        title: "Dismiss",
        onClick: () => {
          this.dismissModal();
        },
      });
      dismissModalElement.classList.add("dismiss-modal");
      dismissModalElement.addEventListener("click", () => this.dismissModal());
      modalElementWrapper.appendChild(dismissModalElement);
      modalElementWrapper.appendChild(element);
      this.modalElementWrapper = modalElementWrapper;
      modalStatusContainer!.appendChild(modalElementWrapper);
    } else {
      statusContainer.appendChild(element);
    }
  }
  dispose() {
    if (this.modalElementWrapper) {
      modalStatusContainer!.removeChild(this.modalElementWrapper);
    } else {
      statusContainer!.removeChild(this.element);
    }
    this.element = <any>undefined;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
  }
  dismissModal() {
    if (this.modalElementWrapper) {
      modalStatusContainer!.removeChild(this.modalElementWrapper);
      this.modalElementWrapper = undefined;
      statusContainer!.appendChild(this.element);
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
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.element.style.display = value ? "block" : "none";
  }

  static forPromise<T>(
    promise: Promise<T>,
    options: { initialMessage: string; delay?: Delay; errorPrefix: string },
  ): Promise<T> {
    const status = new StatusMessage(options.delay);
    status.setText(options.initialMessage);
    const dispose = status.dispose.bind(status);
    promise.then(dispose, (reason) => {
      let msg: string;
      if (reason instanceof Error) {
        msg = reason.message;
      } else {
        msg = "" + reason;
      }
      const { errorPrefix = "" } = options;
      status.setErrorMessage(errorPrefix + msg);
      status.setVisible(true);
    });
    return promise;
  }

  setErrorMessage(message: string) {
    this.element.textContent = message + " ";
    const button = document.createElement("button");
    button.textContent = "Dismiss";
    button.addEventListener("click", () => {
      this.dispose();
    });
    this.element.appendChild(button);
  }

  static showMessage(message: string): StatusMessage {
    const msg = new StatusMessage();
    msg.element.textContent = message;
    msg.setVisible(true);
    return msg;
  }

  static showTemporaryMessage(
    message: string,
    closeAfter = 2000,
  ): StatusMessage {
    const msg = StatusMessage.showMessage(message);
    window.setTimeout(() => msg.dispose(), closeAfter);
    return msg;
  }
}
