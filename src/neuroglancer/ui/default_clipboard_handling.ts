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

import {eventHasInputTextTarget} from 'neuroglancer/util/clipboard';
import {vec3} from 'neuroglancer/util/geom';
import {getCachedJson} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

export function bindDefaultCopyHandler(viewer: Viewer) {
  viewer.registerEventListener(document, 'copy', (event: ClipboardEvent) => {
    if (eventHasInputTextTarget(event)) {
      return;
    }
    const stateJson = getCachedJson(viewer.state).value;
    const {clipboardData} = event;
    if (clipboardData !== null) {
      clipboardData.setData('text/plain', JSON.stringify(stateJson, undefined, '  '));
    }
    event.preventDefault();
  });
}

/**
 * Checks if s consists of 3 numbers separated by whitespace or commas, with optional parentheses or
 * brackets before and after.
 *
 * @param s The string to parse.
 * @return The parsed vector, or undefined if parsing failed.
 */
export function parsePositionString(s: string): vec3|undefined {
  const match = s.match(
      /^[\[\]{}()\s,]*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[\[\]{}()\s,]*$/);
  if (match !== null) {
    return vec3.fromValues(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
  }
  return undefined;
}

export function bindDefaultPasteHandler(viewer: Viewer) {
  viewer.registerEventListener(document, 'paste', (event: ClipboardEvent) => {
    if (eventHasInputTextTarget(event)) {
      return;
    }
    const {clipboardData} = event;
    if (clipboardData !== null) {
      const data = clipboardData.getData('text/plain');
      const parsedPosition = parsePositionString(data);
      if (parsedPosition !== undefined) {
        viewer.navigationState.position.setVoxelCoordinates(parsedPosition);
      }
    }
    event.preventDefault();
  });
}
