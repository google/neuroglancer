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

import { describe, expect, it } from "vitest";
import { WatchableValue } from "#src/trackable_value.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";

function makeEditableView(model: WatchableValue<string>) {
  let renderCount = 0;
  const widget = new DependentViewWidget(
    model,
    (value, parent) => {
      ++renderCount;
      const input = document.createElement("input");
      input.value = value;
      parent.appendChild(input);
    },
    undefined,
    { deferRebuildWhileInteracting: true },
  );
  document.body.appendChild(widget.element);
  return {
    widget,
    input: () => widget.element.querySelector("input")!,
    renderCount: () => renderCount,
  };
}

function makePressableView(model: WatchableValue<string>) {
  const clicked: string[] = [];
  const widget = new DependentViewWidget(
    model,
    (value, parent) => {
      const button = document.createElement("button");
      button.textContent = value;
      button.addEventListener("click", () => clicked.push(value));
      parent.appendChild(button);
    },
    undefined,
    { deferRebuildWhileInteracting: true },
  );
  document.body.appendChild(widget.element);
  return {
    widget,
    button: () => widget.element.querySelector("button")!,
    clicked,
  };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

describe("DependentViewWidget", () => {
  it("shows a change made while its input is edited once the input loses focus", async () => {
    const model = new WatchableValue("first");
    const view = makeEditableView(model);
    const input = view.input();
    input.focus();
    input.value = "typed";

    model.value = "second";
    await nextFrame();
    expect(view.input()).toBe(input);
    expect(input.value).toBe("typed");

    input.blur();
    await nextFrame();
    expect(view.input().value).toBe("second");
    expect(view.renderCount()).toBe(2);
    view.widget.dispose();
    view.widget.element.remove();
  });

  it("keeps a pressed button in place until the press ends, so the click reaches it", async () => {
    const model = new WatchableValue("first");
    const view = makePressableView(model);
    const button = view.button();
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    model.value = "second";
    await nextFrame();
    expect(view.button()).toBe(button);
    window.dispatchEvent(new Event("pointerup"));
    button.click();
    expect(view.clicked).toEqual(["first"]);

    await nextFrame();
    expect(view.button().textContent).toBe("second");
    view.widget.dispose();
    view.widget.element.remove();
  });
});
