/**
 * @license
 * Copyright 2026 Google Inc.
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
 * @file Builds CSS cursors from SVG source. Sets the cursor that a tool shows
 * over an element.
 */

const TOOL_CURSOR_PROPERTY = "--neuroglancer-tool-cursor";

export function svgCursor(
  svg: string,
  hotspot: number,
  fallback: string,
): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, ${fallback}`;
}

export function setToolCursor(
  element: HTMLElement,
  cursor: string | undefined,
): void {
  if (cursor === undefined) {
    element.style.removeProperty(TOOL_CURSOR_PROPERTY);
  } else {
    element.style.setProperty(TOOL_CURSOR_PROPERTY, cursor);
  }
}
