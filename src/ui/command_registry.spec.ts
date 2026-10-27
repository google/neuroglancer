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
import type { CommandContext } from "#src/ui/command.js";
import { ActionCommand, CallbackCommand } from "#src/ui/command.js";
import { CommandRegistry } from "#src/ui/command_registry.js";

function makeContext(dispatchTarget: EventTarget = new EventTarget()) {
  return { dispatchTarget } satisfies CommandContext;
}

describe("Command", () => {
  it("dispatches an action event for an action command", () => {
    const target = document.createElement("div");
    const seen: string[] = [];
    target.addEventListener("action:screenshot", () => seen.push("screenshot"));
    new ActionCommand("screenshot", "Screenshot").invoke(makeContext(target));
    expect(seen).toStrictEqual(["screenshot"]);
  });

  it("passes the invocation context to a callback command", () => {
    const target = new EventTarget();
    let seen: EventTarget | undefined;
    new CallbackCommand("c", "C", (context) => {
      seen = context.dispatchTarget;
    }).invoke(makeContext(target));
    expect(seen).toBe(target);
  });

  it("dispatches changed when enabled flips, and only then", () => {
    const command = new ActionCommand("a", "A");
    let count = 0;
    command.changed.add(() => ++count);
    expect(command.enabled).toBe(true);
    command.enabled = true;
    expect(count).toBe(0);
    command.enabled = false;
    expect(count).toBe(1);
  });
});

describe("CommandRegistry", () => {
  it("registers and retrieves a command by id", () => {
    const registry = new CommandRegistry();
    registry.register(
      new ActionCommand("screenshot", "Screenshot", "Capture a screenshot."),
    );
    expect(registry.has("screenshot")).toBe(true);
    expect(registry.get("screenshot")?.label).toBe("Screenshot");
    expect(registry.get("screenshot")?.description).toBe(
      "Capture a screenshot.",
    );
    registry.dispose();
  });

  it("enumerates commands in registration order, independent of any binding", () => {
    const registry = new CommandRegistry();
    registry.register(new ActionCommand("a", "A"));
    registry.register(new CallbackCommand("c", "C", () => {}));
    expect([...registry.values()].map((command) => command.id)).toStrictEqual([
      "a",
      "c",
    ]);
    registry.dispose();
  });

  it("throws on duplicate id", () => {
    const registry = new CommandRegistry();
    registry.register(new ActionCommand("dup", "First"));
    expect(() => registry.register(new ActionCommand("dup", "Second"))).toThrow(
      /already registered/,
    );
    registry.dispose();
  });

  it("unregisters via the returned disposer", () => {
    const registry = new CommandRegistry();
    const dispose = registry.register(new ActionCommand("temp", "Temp"));
    expect(registry.has("temp")).toBe(true);
    dispose();
    expect(registry.has("temp")).toBe(false);
    registry.dispose();
  });

  it("dispatches changed on register and unregister", () => {
    const registry = new CommandRegistry();
    let count = 0;
    registry.changed.add(() => ++count);
    const dispose = registry.register(new ActionCommand("x", "X"));
    expect(count).toBe(1);
    dispose();
    expect(count).toBe(2);
    registry.dispose();
  });

  it("forwards a registered command's own changed signal", () => {
    const registry = new CommandRegistry();
    const command = new ActionCommand("x", "X");
    registry.register(command);
    let count = 0;
    registry.changed.add(() => ++count);
    command.enabled = false;
    expect(count).toBe(1);
    registry.dispose();
  });

  it("stops forwarding a command's changed signal after unregister", () => {
    const registry = new CommandRegistry();
    const command = new ActionCommand("x", "X");
    const dispose = registry.register(command);
    dispose();
    let count = 0;
    registry.changed.add(() => ++count);
    command.enabled = false;
    expect(count).toBe(0);
    registry.dispose();
  });
});
