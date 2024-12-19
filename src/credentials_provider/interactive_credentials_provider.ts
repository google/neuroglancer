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

import { StatusMessage } from "#src/status.js";
import { scopedAbortCallback } from "#src/util/abort.js";

export function getCredentialsWithStatus<Token>(
  options: {
    description: string;
    requestDescription?: string;
    supportsImmediate?: boolean;
    get: (abortSignal: AbortSignal, immediate: boolean) => Promise<Token>;
  },
  abortSignal: AbortSignal,
): Promise<Token> {
  const { requestDescription = "login" } = options;
  const status = new StatusMessage(/*delay=*/ true);
  let abortController: AbortController | undefined;
  return new Promise<Token>((resolve, reject) => {
    const disposeAbortCallback = scopedAbortCallback(abortSignal, (reason) => {
      if (abortController !== undefined) {
        abortController.abort(reason);
        abortController = undefined;
        status.dispose();
        reject(reason);
      }
    });
    function dispose() {
      if (abortController === undefined) return;
      abortController = undefined;
      status.dispose();
      disposeAbortCallback?.[Symbol.dispose]();
    }
    function writeLoginStatus(
      msg = `${options.description} ${requestDescription} required.`,
      linkMessage = `Request ${requestDescription}.`,
    ) {
      status.setText(msg + "  ");
      const button = document.createElement("button");
      button.textContent = linkMessage;
      status.element.appendChild(button);
      button.addEventListener("click", () => {
        login(/*immediate=*/ false);
      });
    }
    function login(immediate: boolean) {
      abortController?.abort();
      abortController = new AbortController();
      writeLoginStatus(
        `Waiting for ${options.description} ${requestDescription}...`,
        "Retry",
      );
      options.get(abortController.signal, immediate).then(
        (token) => {
          dispose();
          resolve(token);
        },
        (reason) => {
          if (abortController === undefined) {
            // Already completed, ignore.
            return;
          }
          abortController = undefined;
          status.setVisible(true);
          status.setModal(true);
          if (immediate) {
            writeLoginStatus();
          } else {
            writeLoginStatus(
              `${options.description} ${requestDescription} failed: ${reason}.`,
              "Retry",
            );
          }
        },
      );
    }
    if (options.supportsImmediate === true) {
      login(/*immediate=*/ true);
    } else {
      writeLoginStatus();
      status.setVisible(true);
    }
  });
}

export class AuthWindowClosedError extends Error {
  constructor() {
    super("Authentication window was closed");
  }
}

export function monitorAuthPopupWindow(
  popup: Window,
  abortController: AbortController,
) {
  window.addEventListener(
    "beforeunload",
    () => {
      popup.close();
    },
    { signal: abortController.signal },
  );
  const checkClosed = setInterval(() => {
    if (popup.closed) {
      abortController.abort(new AuthWindowClosedError());
    }
  }, 1000);
  abortController.signal.addEventListener("abort", () => {
    try {
      popup.close();
    } catch {
      // Ignore error closing window.
    }
    clearInterval(checkClosed);
  });
}
