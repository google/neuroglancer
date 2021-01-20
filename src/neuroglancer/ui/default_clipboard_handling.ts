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

import {isInputTextTarget} from 'neuroglancer/util/dom';
import {getCachedJson} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

export function bindDefaultCopyHandler(viewer: Viewer) {
  viewer.registerEventListener(document, 'copy', (event: ClipboardEvent) => {
    if (isInputTextTarget(event.target)) {
      return;
    }
    const selection = document.getSelection();
    if (selection !== null && selection.type === 'Range') return;
    const stateJson = getCachedJson(viewer.state).value;
    const {clipboardData} = event;
    if (clipboardData !== null) {
      clipboardData.setData('text/plain', JSON.stringify(stateJson, undefined, '  '));
    }
    event.preventDefault();
  });
}

/**
 * Checks if `s` consists of `rank` numbers separated by whitespace or commas, with optional parentheses or
 * brackets before and after.
 *
 * @param s The string to parse.
 * @param rank Specifies how many numbers are expected.
 * @return The parsed vector, or undefined if parsing failed.
 */
export function parsePositionString(s: string, rank: number): Float32Array|undefined {
  let pattern = String.raw`^[\[\]{}()\s,]*`;
  for (let i = 0; i < rank; ++i) {
    if (i !== 0) {
      pattern += String.raw`[,\s]+`;
    }
    pattern += String.raw`(\d+(?:\.\d+)?)`;
  }
  pattern += String.raw`[\[\]{}()\s,]*$`;
  const match = s.match(pattern);
  if (match === null) return undefined;
  const result = new Float32Array(rank);
  for (let i = 0; i < rank; ++i) {
    const n = Number(match[i + 1]);
    if (!Number.isFinite(n)) return undefined;
    result[i] = n;
  }
  return result;
}

export function bindDefaultPasteHandler(viewer: Viewer) {
  viewer.registerEventListener(document, 'paste', (event: ClipboardEvent) => {
    if (isInputTextTarget(event.target)) {
      return;
    }
    const {clipboardData} = event;
    if (clipboardData !== null) {
      const data = clipboardData.getData('text/plain');
      const parsedPosition = parsePositionString(data, viewer.coordinateSpace.value.rank);
      if (parsedPosition !== undefined) {
        viewer.navigationState.position.value = parsedPosition;
      }
    }
    event.preventDefault();
  });
}
