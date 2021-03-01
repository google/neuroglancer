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

export function scrollIntoViewIfNeeded(element: HTMLElement) {
  const parent = element.parentElement!;
  const elementLeft = element.offsetLeft - parent.clientLeft;
  const elementTop = element.offsetTop - parent.clientTop;
  const elementRight = elementLeft + element.offsetWidth;
  const elementBottom = elementTop + element.offsetHeight;
  const parentWidth = parent.clientWidth;
  const parentHeight = parent.clientHeight;
  const viewportLeft = parent.scrollLeft;
  const viewportRight = viewportLeft + parentWidth;
  const viewportTop = parent.scrollTop;
  const viewportBottom = viewportTop + parentHeight;

  const scrollLeftDelta =
      Math.max(0.0, elementRight - viewportRight) || Math.min(0.0, elementLeft - viewportLeft);
  const scrollTopDelta =
      Math.max(0.0, elementBottom - viewportBottom) || Math.min(0.0, elementTop - viewportTop);

  parent.scrollLeft += scrollLeftDelta;
  parent.scrollTop += scrollTopDelta;
}
