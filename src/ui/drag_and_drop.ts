/**
 * @license
 * Copyright 2021 Google Inc.
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

import "#src/ui/drag_and_drop.css";
import { filterArrayInplace } from "#src/util/array.js";
import { removeChildren } from "#src/util/dom.js";

let dragStatusElement: HTMLElement | undefined;

export type DragStatusRenderer = string | (() => Node);

export type DragStatusType = "drag" | "drop";

const dragStatusStack: {
  target: EventTarget;
  operation: DragStatusType;
  status: DragStatusRenderer;
  leaveHandler?: () => void;
}[] = [];

function getStatusElement() {
  if (dragStatusElement === undefined) {
    const element = (dragStatusElement = document.createElement("div"));
    element.classList.add("neuroglancer-drag-status");
    document.body.appendChild(element);
  }
  return dragStatusElement;
}

function clearStatus() {
  if (dragStatusElement !== undefined) {
    removeChildren(dragStatusElement);
    dragStatusElement.style.display = "none";
  }
}

function applyStatus(event: MouseEvent, status: DragStatusRenderer) {
  const element = getStatusElement();
  removeChildren(element);
  if (event.clientX === 0 && event.clientY === 0) {
    // Probably an invalid position due to dragging outside the window.
  } else {
    if (event.clientX < window.innerWidth / 2) {
      element.style.left = "auto";
      element.style.right = "0px";
    } else {
      element.style.right = "auto";
      element.style.left = "0px";
    }
  }

  if (typeof status === "string") {
    element.appendChild(document.createTextNode(status));
  } else {
    element.appendChild(status());
  }
  element.style.display = "";
}

function removeDragStatus(target: EventTarget, operation: DragStatusType) {
  filterArrayInplace(dragStatusStack, (entry) => {
    if (entry.target === target && entry.operation === operation) {
      entry.leaveHandler?.();
      return false;
    }
    return true;
  });
}

export function pushDragStatus(
  event: MouseEvent,
  target: EventTarget,
  operation: DragStatusType,
  status: DragStatusRenderer,
  leaveHandler?: () => void,
) {
  removeDragStatus(target, operation);
  dragStatusStack.push({ target, operation, status, leaveHandler });
  applyStatus(event, status);
}

export function popDragStatus(
  event: MouseEvent,
  target: EventTarget,
  operation: DragStatusType,
) {
  removeDragStatus(target, operation);
  const entry =
    dragStatusStack.length === 0
      ? undefined
      : dragStatusStack[dragStatusStack.length - 1];
  if (entry === undefined) {
    clearStatus();
  } else {
    applyStatus(event, entry.status);
  }
}
