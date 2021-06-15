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
 * @file Facilities for encoding arbitrary strings as HTML5 Drag-and-drop types.
 *
 * The HTML5 Drag and Drop mechanism provides a way of attaching a set of (string key -> string
 * value) mappings to a drag.  The keys can be retrieved by any target the drag passes over, while
 * the values can only be retrieved when the actual "drop" happens.  Therefore, any data that needs
 * to be available prior to the drop must be stored as a key.  Additionally, the key strings are
 * munged.  According to the spec
 * <https://dev.w3.org/html5/spec-preview/dnd.html#the-drag-data-store>, the keys are converted to
 * ASCII lowercase, which means that only ASCII uppercase letters are modified, and all other
 * Unicode characters are preserved.  However, Chrome 62 does not appear to follow the spec, and
 * munges other characters as well.  Therefore, we hex encode to be safe.
 */

import {hexEncode, hexDecode} from 'neuroglancer/util/hex';
import {registerEventListener} from 'neuroglancer/util/disposable';

export function encodeStringAsDragType(s: string) {
  return hexEncode(new TextEncoder().encode(s));
}

export function decodeStringFromDragType(s: string) {
  return new TextDecoder().decode(hexDecode(s));
}

export function encodeDragType(prefix: string, parameters: any) {
  return prefix + encodeStringAsDragType(JSON.stringify(parameters));
}

export function decodeParametersFromDragType(dragType: string, prefix: string) {
  if (!dragType.startsWith(prefix)) {
    return undefined;
  }
  try {
    const jsonString = decodeStringFromDragType(dragType.substring(prefix.length));
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

export function encodeParametersAsDragType(prefix: string, parameters: any) {
  return prefix + encodeStringAsDragType(JSON.stringify(parameters));
}

export interface DragInfo {
  dragType: string;
  parameters: any;
}

export function decodeParametersFromDragTypeList(
    dragTypes: ReadonlyArray<string>, prefix: string): DragInfo|undefined {
  for (const dragType of dragTypes) {
    const parameters = decodeParametersFromDragType(dragType, prefix);
    if (parameters !== undefined) {
      return {parameters, dragType};
    }
  }
  return undefined;
}

let savedDropEffect: DataTransfer['dropEffect'] | undefined;

/**
 * On Chrome 62, the dataTransfer.dropEffect property is reset to 'none' when the 'drop' event is
 * dispatched.  As a workaround, we store it in a global variable.
 *
 * The alternative workaround of recomputing it in the 'drop' event handler is problematic for a
 * different reason: the computation may depend on the modifier key states, and on Firefox 52, these
 * key states are not set in the 'drop' event.
 */
export function setDropEffect<T extends DataTransfer['dropEffect']>(event: DragEvent, dropEffect: T) {
  event.dataTransfer!.dropEffect = dropEffect;
  savedDropEffect = dropEffect;
  return dropEffect;
}

export function getDropEffect() {
  return savedDropEffect;
}

export function preventDrag(element: HTMLElement) {
  element.draggable = true;
  return registerEventListener(element, 'dragstart', (event: DragEvent) => {
    event.stopPropagation();
    event.preventDefault();
  });
}
