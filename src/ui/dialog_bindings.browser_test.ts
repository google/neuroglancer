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

import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionCommand } from "#src/ui/command.js";
import { bindScreenshotDialog } from "#src/ui/screenshot_menu.js";
import { bindStateEditor } from "#src/ui/state_editor.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

// The fake viewer binds an action on its element, as `Viewer.bindAction` does.
function makeFakeViewer() {
  const element = document.createElement("div");
  const viewer = {
    element,
    bindAction: (action: string, handler: () => void) => {
      disposers.push(registerActionListener(element, action, handler));
    },
    editJsonState: vi.fn(),
    showScreenshotDialog: vi.fn(),
  };
  return viewer;
}

function invoke(id: string, target: EventTarget) {
  new ActionCommand(id, id).invoke({ dispatchTarget: target });
}

describe("dialog bindings", () => {
  it("bindStateEditor opens the state editor on edit-json-state", () => {
    const viewer = makeFakeViewer();
    invoke("edit-json-state", viewer.element);
    expect(viewer.editJsonState).not.toHaveBeenCalled();

    bindStateEditor(viewer as unknown as Viewer);
    invoke("edit-json-state", viewer.element);
    expect(viewer.editJsonState).toHaveBeenCalledTimes(1);
  });

  it("bindScreenshotDialog opens the screenshot dialog on screenshot", () => {
    const viewer = makeFakeViewer();
    invoke("screenshot", viewer.element);
    expect(viewer.showScreenshotDialog).not.toHaveBeenCalled();

    bindScreenshotDialog(viewer as unknown as Viewer);
    invoke("screenshot", viewer.element);
    expect(viewer.showScreenshotDialog).toHaveBeenCalledTimes(1);
  });
});
