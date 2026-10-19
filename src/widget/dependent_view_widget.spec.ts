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

import { debounce } from "lodash-es";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchableValue } from "#src/trackable_value.js";
import type { RefCounted } from "#src/util/disposable.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";

const resources: RefCounted[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function setup(guard = true) {
  const outerModel = new WatchableValue(0);
  const innerModel = new WatchableValue(0);
  const save = vi.fn();
  const disposed = vi.fn();
  const rendered = vi.fn();
  const clicked = vi.fn();
  let current = true;
  let redraw = () => {};
  const outer = new DependentViewWidget(outerModel, (_, parent, context) => {
    const inner = context.registerDisposer(
      new DependentViewWidget(innerModel, (value, parent, context) => {
        rendered(value);
        redraw = context.redraw;
        const input = document.createElement("textarea");
        input.value = `saved ${value}`;
        context.registerDisposer(disposed);
        const pendingSave = context.registerCancellable(debounce(save, 500));
        context.registerEventListener(input, "input", () => pendingSave());
        if (guard) {
          context.deferUpdatesWhileFocused(input, () => current);
          context.deferUpdatesWhilePointerPressed(parent, () => current);
        }
        parent.appendChild(input);
        const button = document.createElement("button");
        button.textContent = "Action";
        context.registerEventListener(button, "click", clicked);
        parent.appendChild(button);
      }),
    );
    parent.appendChild(inner.element);
  });
  resources.push(outer);
  document.body.appendChild(outer.element);
  return {
    outer,
    outerModel,
    innerModel,
    save,
    disposed,
    rendered,
    clicked,
    input: () => outer.element.querySelector("textarea")!,
    button: () => outer.element.querySelector("button")!,
    redraw: () => redraw(),
    invalidate: () => {
      current = false;
    },
  };
}

describe("dependent views with a focused editor", () => {
  it.each(["inner", "outer", "both", "forced"])(
    "preserves the editor and lifetime during %s updates, then renders the latest state on blur",
    async (update) => {
      const test = setup();
      const input = test.input();
      input.focus();
      input.value = "unfinished α\nβ description";
      input.setSelectionRange(2, 7, "backward");
      for (let value = 1; value <= 3; value++) {
        if (update === "inner" || update === "both")
          test.innerModel.value = value;
        if (update === "outer" || update === "both")
          test.outerModel.value = value;
        if (update === "forced") test.redraw();
        await frame();
      }
      expect(test.input()).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("unfinished α\nβ description");
      expect([
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ]).toEqual([2, 7, "backward"]);
      expect(test.disposed).not.toHaveBeenCalled();
      expect(test.rendered).toHaveBeenCalledOnce();
      input.blur();
      await frame();
      expect(test.input()).not.toBe(input);
      expect(test.input().value).toBe(`saved ${test.innerModel.value}`);
      // Both dirty ancestors may render in order during this frame.
      const rebuilds = update === "both" ? 2 : 1;
      expect(test.disposed).toHaveBeenCalledTimes(rebuilds);
      expect(test.rendered).toHaveBeenCalledTimes(rebuilds + 1);
    },
  );

  it("keeps a pending debounced save across both ancestor updates", async () => {
    vi.useFakeTimers();
    const test = setup();
    const input = test.input();
    input.focus();
    input.dispatchEvent(new Event("input"));
    test.innerModel.value++;
    test.outerModel.value++;
    await vi.advanceTimersByTimeAsync(499);
    expect(test.save).not.toHaveBeenCalled();
    expect(test.input()).toBe(input);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.save).toHaveBeenCalledOnce();
  });

  it.each(["before press", "on blur", "during an unfocused press"])(
    "preserves a button click when ancestor updates arrive %s",
    async (timing) => {
      const test = setup();
      const input = test.input();
      const button = test.button();
      if (timing !== "during an unfocused press") input.focus();
      const changeModels = () => {
        test.innerModel.value++;
        test.outerModel.value++;
      };
      if (timing === "before press") {
        changeModels();
        await frame();
      } else if (timing === "on blur") {
        input.addEventListener("blur", changeModels, { once: true });
      }
      button.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          isPrimary: true,
        }),
      );
      button.focus();
      if (timing === "during an unfocused press") changeModels();
      await frame();
      expect(test.button()).toBe(button);
      expect(test.disposed).not.toHaveBeenCalled();

      // Releasing another pointer must not release this press.
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2 }));
      await frame();
      expect(test.button()).toBe(button);
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
      button.click();
      expect(test.clicked).toHaveBeenCalledOnce();
      await frame();
      expect(test.button()).not.toBe(button);
      expect(test.input().value).toBe(`saved ${test.innerModel.value}`);
    },
  );

  it.each(["pointercancel", "window blur", "invalidation", "disposal"])(
    "releases a deferred press on %s",
    async (reason) => {
      const test = setup();
      const button = test.button();
      button.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          isPrimary: true,
        }),
      );
      button.focus();
      test.innerModel.value++;
      test.outerModel.value++;
      await frame();
      expect(test.button()).toBe(button);
      if (reason === "pointercancel") {
        document.dispatchEvent(
          new PointerEvent("pointercancel", { pointerId: 1 }),
        );
      } else if (reason === "window blur") {
        window.dispatchEvent(new Event("blur"));
      } else if (reason === "invalidation") {
        test.invalidate();
        test.outerModel.value++;
      } else {
        resources.splice(resources.indexOf(test.outer), 1);
        test.outer.dispose();
        document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
      }
      await frame();
      expect(test.button()).not.toBe(button);
      if (reason === "disposal") {
        expect(test.rendered).toHaveBeenCalledOnce();
        expect(test.disposed).toHaveBeenCalledOnce();
      } else {
        expect(test.input().value).toBe(`saved ${test.innerModel.value}`);
      }
    },
  );

  it.each(["inner", "outer"])(
    "does not defer an invalidated editor's %s update",
    async (update) => {
      const test = setup();
      const input = test.input();
      input.focus();
      test.invalidate();
      (update === "inner" ? test.innerModel : test.outerModel).value++;
      await frame();
      expect(test.input()).not.toBe(input);
      expect(test.disposed).toHaveBeenCalledOnce();
      expect(document.activeElement).not.toBe(test.input());
    },
  );

  it("does not defer unregistered controls", async () => {
    const test = setup(false);
    const input = test.input();
    input.focus();
    test.outerModel.value++;
    await frame();
    expect(test.input()).not.toBe(input);
  });

  it("does not defer a press in an unregistered view", async () => {
    const test = setup(false);
    const button = test.button();
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        isPrimary: true,
      }),
    );
    test.outerModel.value++;
    await frame();
    expect(test.button()).not.toBe(button);
  });

  it("does not defer unfocused editors or steal focus", async () => {
    const test = setup();
    const input = test.input();
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    test.outerModel.value++;
    await frame();
    expect(test.input()).not.toBe(input);
    expect(document.activeElement).toBe(other);
  });

  it("disposes a focused editor and cancels its pending save when the panel closes", async () => {
    vi.useFakeTimers();
    const test = setup();
    const input = test.input();
    input.focus();
    input.dispatchEvent(new Event("input"));
    test.outerModel.value++;
    await vi.advanceTimersByTimeAsync(100);
    resources.splice(resources.indexOf(test.outer), 1);
    test.outer.dispose();
    input.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(500);
    expect(test.disposed).toHaveBeenCalledOnce();
    expect(test.save).not.toHaveBeenCalled();
    expect(test.rendered).toHaveBeenCalledOnce();
  });
});
