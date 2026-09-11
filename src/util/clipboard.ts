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

import { registerEventListener } from "#src/util/disposable.js";

/**
 * Starts a clipboard write while the data to copy is still being generated.
 *
 * This must be called directly from a user gesture handler. In particular,
 * Safari rejects clipboard writes that are started only after awaiting the
 * data, but accepts a ClipboardItem containing a promise for that data.
 */
export function setClipboardFromPromise(
  data: Promise<string>,
  format = "text/plain",
) {
  return navigator.clipboard.write([
    new ClipboardItem({
      [format]: data.then((value) => new Blob([value], { type: format })),
    }),
  ]);
}

export function setClipboard(data: string, format = "text/plain") {
  let success = false;
  const cleanup = registerEventListener(
    document,
    "copy",
    (event: ClipboardEvent) => {
      const { clipboardData } = event;
      if (clipboardData !== null) {
        clipboardData.setData(format, data);
        success = true;
      }
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
  try {
    document.execCommand("copy");
  } finally {
    cleanup();
  }
  return success;
}
