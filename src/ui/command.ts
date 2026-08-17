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
 * @file A command: something the user can invoke, named independently of how it
 * happens to be bound.
 *
 * A command owns its identity (`id`), how it presents (`label`, `description`)
 * and how it runs (`invoke`). Bindings, ordering and grouping belong to the
 * consumers that present it. See `docs/concepts/commands.rst` for how commands,
 * {@link CommandRegistry} and {@link CommandCatalog} divide up the work.
 */

import type { ActionIdentifier } from "#src/util/event_action_map.js";
import { NullarySignal } from "#src/util/signal.js";

/**
 * Stable, serialisable identifier of a command, e.g. "toggle-scale-bar". For an
 * {@link ActionCommand} this is also the DOM action id, hence the shared type.
 */
export type CommandId = ActionIdentifier;

/**
 * What a command is told about the invocation. An interface rather than a bare
 * target so that more context (mouse position, originating layer, …) can be
 * added later without touching every implementation.
 */
export interface CommandContext {
  /**
   * Element the invocation is attributed to. For the command palette this is
   * whichever element had focus when the palette was opened, so that a command
   * acts on the panel the user was in.
   */
  readonly dispatchTarget: EventTarget;
}

/**
 * Base class for commands. Subclass it to define how the command runs; the
 * registry stores instances and consumers read `label`/`description` and call
 * {@link invoke}.
 */
export abstract class Command {
  /**
   * Dispatched when anything a consumer renders or filters on changes. Bundling
   * these into one signal means a consumer subscribes once per command rather
   * than once per mutable property. Currently only {@link enabled} changes.
   */
  readonly changed = new NullarySignal();

  private enabled_ = true;

  constructor(
    readonly id: CommandId,
    readonly label: string,
    readonly description?: string,
  ) {}

  /**
   * Whether the command can currently be invoked. Consumers are expected to
   * omit disabled commands (the catalog does). Nothing built in flips this yet;
   * it exists so a feature can register a command once and mark it unavailable
   * while its preconditions are unmet, rather than register/unregister it.
   */
  get enabled(): boolean {
    return this.enabled_;
  }

  set enabled(value: boolean) {
    if (value === this.enabled_) return;
    this.enabled_ = value;
    this.changed.dispatch();
  }

  abstract invoke(context: CommandContext): void;
}

/**
 * A command backed by a DOM action: invoking it dispatches `action:<id>` at the
 * context's dispatch target, exactly as the equivalent key binding would, so
 * existing `registerActionListener` handlers need no extra wiring.
 */
export class ActionCommand extends Command {
  invoke({ dispatchTarget }: CommandContext) {
    dispatchTarget.dispatchEvent(
      new CustomEvent(`action:${this.id}`, {
        bubbles: true,
        cancelable: true,
        detail: {},
      }),
    );
  }
}

/**
 * A command that runs a callback directly, for behaviour with no corresponding
 * DOM action, e.g. commands contributed by an application embedding the
 * viewer.
 */
export class CallbackCommand extends Command {
  constructor(
    id: CommandId,
    label: string,
    private readonly callback: (context: CommandContext) => void,
    description?: string,
  ) {
    super(id, label, description);
  }

  invoke(context: CommandContext) {
    this.callback(context);
  }
}

export function formatKeyName(name: string) {
  if (name.startsWith("key")) {
    return name.substring(3);
  }
  if (name.startsWith("digit")) {
    return name.substring(5);
  }
  if (name.startsWith("arrow")) {
    return name.substring(5);
  }
  return name;
}

export function formatKeyStroke(stroke: string) {
  const parts = stroke.split("+");
  return parts.map(formatKeyName).join("+");
}
