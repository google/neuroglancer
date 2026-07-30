/**
 * @license
 * Copyright 2024 Google Inc.
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
 * @file Shows a dismissable status message when Neuroglancer cannot display
 * visible data because it has reached its GPU or system memory limit.
 */

import { MemoryLimitFlags } from "#src/chunk_manager/base.js";
import type { ChunkQueueManager } from "#src/chunk_manager/frontend.js";
import { StatusMessage } from "#src/status.js";
import type { RefCounted } from "#src/util/disposable.js";

/**
 * How long the memory limit must stay clear before the status message is
 * hidden and the dismissed state is reset.  Debouncing the falling edge avoids
 * flapping the message during ordinary chunk churn (e.g. while panning) and
 * ensures the message only reappears after memory pressure has genuinely
 * subsided and is hit again.
 */
const CLEAR_DEBOUNCE_MS = 1500;

function describeMemoryLimit(flags: number): string {
  const limits: string[] = [];
  if (flags & MemoryLimitFlags.GPU) {
    limits.push("GPU");
  }
  if (flags & MemoryLimitFlags.SYSTEM) {
    limits.push("system");
  }
  const which = limits.join(" and ");
  return (
    `Some data is not being displayed because Neuroglancer has reached its ` +
    `${which} memory limit. You can increase the memory limits in the ` +
    `settings panel (gear icon at the top right).`
  );
}

/**
 * Registers a handler that surfaces a status message whenever the memory limit
 * blocks visible chunks from loading, and hides it once memory pressure clears.
 *
 * The message can be dismissed by the user; once dismissed it will not reappear
 * until the memory limit has been continuously clear for `CLEAR_DEBOUNCE_MS`
 * and is subsequently reached again.
 */
export function registerMemoryLimitStatusMessage(
  context: RefCounted,
  chunkQueueManager: ChunkQueueManager,
) {
  const watchable = chunkQueueManager.memoryLimitReached;
  let statusMessage: StatusMessage | undefined;
  let shownFlags = MemoryLimitFlags.NONE;
  let dismissed = false;
  let clearTimer: number | undefined;

  const hideMessage = () => {
    if (statusMessage !== undefined) {
      statusMessage.dispose();
      statusMessage = undefined;
    }
    shownFlags = MemoryLimitFlags.NONE;
  };

  const showMessage = (flags: number) => {
    if (statusMessage !== undefined && shownFlags === flags) {
      return;
    }
    hideMessage();
    shownFlags = flags;
    const message = new StatusMessage(/*delay=*/ false);
    message.setPreventFocusChangeOnMouseDown(true);
    message.element.textContent = describeMemoryLimit(flags) + " ";
    const dismissButton = document.createElement("button");
    dismissButton.textContent = "Dismiss";
    dismissButton.addEventListener("click", () => {
      dismissed = true;
      hideMessage();
    });
    message.element.appendChild(dismissButton);
    statusMessage = message;
  };

  const cancelClearTimer = () => {
    if (clearTimer !== undefined) {
      window.clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  };

  const update = () => {
    const flags = watchable.value;
    if (flags !== MemoryLimitFlags.NONE) {
      cancelClearTimer();
      if (!dismissed) {
        showMessage(flags);
      }
    } else if (clearTimer === undefined) {
      // Debounce the falling edge: only clear once memory pressure has stayed
      // resolved for a while.
      clearTimer = window.setTimeout(() => {
        clearTimer = undefined;
        dismissed = false;
        hideMessage();
      }, CLEAR_DEBOUNCE_MS);
    }
  };

  context.registerDisposer(watchable.changed.add(update));
  context.registerDisposer(() => {
    cancelClearTimer();
    hideMessage();
  });
  update();
}
