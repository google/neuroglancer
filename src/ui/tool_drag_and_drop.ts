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

import type { LocalToolBinder, Tool } from "#src/ui/tool.js";
import type { ToolPalettePanel } from "#src/ui/tool_palette.js";

export interface ToolDragSource {
  readonly localBinder: LocalToolBinder<object>;
  readonly toolJson: any;
  dragElement?: HTMLElement | undefined;
  paletteState?:
    | {
        tool: Tool<object>;
        palette: ToolPalettePanel;
      }
    | undefined;
}

export let toolDragSource: ToolDragSource | undefined = undefined;

export function beginToolDrag(source: ToolDragSource) {
  toolDragSource = source;
}

export function endToolDrag(source: ToolDragSource) {
  if (toolDragSource === source) {
    toolDragSource = undefined;
  }
}
