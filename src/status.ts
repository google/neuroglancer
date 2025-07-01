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

<<<<<<< HEAD
let statusContainer: HTMLElement | undefined;
let modalStatusContainer: HTMLElement | undefined;

// Exported for use by #tests/fixtures/status_message_handler.js
export const statusMessages = new Set<StatusMessage>();
=======
let statusContainer: HTMLElement | null = null;
let modalStatusContainer: HTMLElement | null = null;
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)

export const DEFAULT_STATUS_DELAY = 200;

export type Delay = boolean | number;

function setupStatusContainer(container: HTMLElement) {
  container.addEventListener("mousedown", (event) => {
    // Prevent focus changes due to clicking on status message.
    event.preventDefault();
  });
}

function getStatusContainer() {
  if (statusContainer === undefined) {
    statusContainer = document.createElement("ul");
    setupStatusContainer(statusContainer);
    statusContainer.id = "neuroglancer-status-container";
    const el: HTMLElement | null = document.getElementById(
      "neuroglancer-container",
    );
    if (el) {
      el.appendChild(statusContainer);
    } else {
      document.body.appendChild(statusContainer);
    }
  }
  return statusContainer;
}

function getModalStatusContainer() {
  if (modalStatusContainer === undefined) {
    modalStatusContainer = document.createElement("ul");
    setupStatusContainer(modalStatusContainer);
    modalStatusContainer.id = "neuroglancer-status-container-modal";
    const el: HTMLElement | null = document.getElementById(
      "neuroglancer-container",
    );
    if (el) {
      el.appendChild(modalStatusContainer);
    } else {
      document.body.appendChild(modalStatusContainer);
    }
  }
  return modalStatusContainer;
}

// For use by #tests/fixtures/status_message_handler.js
export function getStatusMessageContainers() {
  return [getStatusContainer(), getModalStatusContainer()];
}

export class StatusMessage {
  element: HTMLElement;
<<<<<<< HEAD
  private modalElementWrapper: HTMLElement | undefined;
  private timer: number | null;
  private visibility = true;
  constructor(delay: Delay = false, modal = false) {
=======
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
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
    const element = document.createElement("li");
    this.element = element;
    if (delay === true) {
      delay = DEFAULT_STATUS_DELAY;
    }
    this.setModal(modal);
    if (delay !== false) {
      this.setVisible(false);
      this.timer = window.setTimeout(this.setVisible.bind(this, true), delay);
    } else {
      this.timer = null;
    }
<<<<<<< HEAD
    statusMessages.add(this);
=======
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
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  dispose() {
    if (this.modalElementWrapper) {
      modalStatusContainer!.removeChild(this.modalElementWrapper);
    } else {
      statusContainer!.removeChild(this.element);
    }
<<<<<<< HEAD
=======
    this.element = <any>undefined;
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    statusMessages.delete(this);
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
  setModal(value: boolean) {
    if (value) {
      if (this.modalElementWrapper === undefined) {
        const modalElementWrapper = document.createElement("div");
        const dismissModalElement = makeCloseButton({
          title: "Dismiss",
          onClick: () => {
            this.setModal(false);
          },
        });
        dismissModalElement.classList.add("neuroglancer-dismiss-modal");
        modalElementWrapper.appendChild(dismissModalElement);
        modalElementWrapper.appendChild(this.element);
        this.modalElementWrapper = modalElementWrapper;
        this.applyVisibility();
        getModalStatusContainer().appendChild(modalElementWrapper);
      }
    } else {
      if (this.modalElementWrapper !== undefined) {
        modalStatusContainer!.removeChild(this.modalElementWrapper);
        this.modalElementWrapper = undefined;
        getStatusContainer().appendChild(this.element);
      } else if (this.element.parentElement === null) {
        getStatusContainer().appendChild(this.element);
      }
    }
  }

  private applyVisibility() {
    const newVisibility = this.visibility ? "" : "none";
    this.element.style.display = newVisibility;
    const { modalElementWrapper } = this;
    if (modalElementWrapper !== undefined) {
      modalElementWrapper.style.display = newVisibility;
    }
  }

  setVisible(value: boolean) {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (value !== this.visibility) {
      this.visibility = value;
      this.applyVisibility();
    }
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
