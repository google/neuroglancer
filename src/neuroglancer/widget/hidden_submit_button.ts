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
 * This creates a form submit button that is not displayed, in order that the form may be submitted
 * using the enter key.
 */
export function makeHiddenSubmitButton() {
  let element = document.createElement('button');
  element.type = 'submit';
  element.className = 'hidden-submit-button';
  // We apply these styles directly to the element rather than by styling the class in order to
  // avoid them being overridden accidentally.
  element.style.margin = '0';
  element.style.border = '0';
  element.style.padding = '0';
  element.style.width = '0';
  element.style.height = '0';
  element.style.overflow = 'hidden';
  element.tabIndex = -1;
  return element;
}
