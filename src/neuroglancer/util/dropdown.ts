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

/**
 * @file
 * Utilities for positioning dropdown menus.
 */

export function positionDropdown(dropdownElement: HTMLElement, associatedElement: HTMLElement, {
  horizontal = false,
  vertical = true,
  topMargin = 6,
  bottomMargin = 6,
  leftMargin = 6,
  rightMargin = 6,
  maxHeight = true,
  maxWidth = true
} = {}) {
  let rect = associatedElement.getBoundingClientRect();

  if (horizontal) {
    let viewportWidth = dropdownElement.ownerDocument!.documentElement!.clientHeight;
    let distanceLeft = rect.right;
    let distanceRight = viewportWidth - rect.left;
    if (distanceLeft > distanceRight) {
      dropdownElement.style.left = '';
      dropdownElement.style.right = '0';
      if (maxWidth) {
        dropdownElement.style.maxWidth = (distanceLeft - leftMargin) + 'px';
      }
    } else {
      dropdownElement.style.right = '';
      dropdownElement.style.left = '0';
      if (maxWidth) {
        dropdownElement.style.maxWidth = (distanceRight - rightMargin) + 'px';
      }
    }
  }

  if (vertical) {
    let viewportHeight = dropdownElement.ownerDocument!.documentElement!.clientHeight;
    let distanceToTop = rect.top - topMargin;
    let distanceToBottom = viewportHeight - rect.bottom - bottomMargin;
    if (distanceToTop > distanceToBottom * 3) {
      dropdownElement.style.top = '';
      dropdownElement.style.bottom = '100%';
      if (maxHeight) {
        dropdownElement.style.maxHeight = distanceToTop + 'px';
      }
    } else {
      dropdownElement.style.top = '100%';
      dropdownElement.style.bottom = '';
      if (maxHeight) {
        dropdownElement.style.maxHeight = distanceToBottom + 'px';
      }
    }
  }
}
