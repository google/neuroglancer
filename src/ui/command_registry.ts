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
 * @file Global, binding-independent registry of viewer commands.
 *
 * A command is declared once, with a stable id, a pretty label, and an optional
 * help description. Any key binding is looked up separately and shown alongside;
 * it is not the source of truth for which commands exist.
 *
 * The registry is owned by the viewer so commands can be registered before — or
 * without — any UI chrome. The command palette and help panel are consumers of
 * the same surface; see {@link CommandCatalog}.
 */

import type { ActionIdentifier } from "#src/util/event_action_map.js";
import { RefCounted } from "#src/util/disposable.js";
import { Signal } from "#src/util/signal.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";

interface CommandInfoBase {
  /** Stable, serialisable identifier, e.g. "toggle-scale-bar". */
  readonly id: ActionIdentifier;
  /** Human-readable name shown in the palette / help panel. */
  readonly label: string;
  /**
   * Optional longer help text describing what the command does. Surfaced by
   * hosts that can afford more than a label (help panel, tooltips).
   */
  readonly description?: string;
  /**
   * Optional observable of whether the command is currently usable. When it
   * changes the registry dispatches `changed`, so consumers can re-enumerate
   * "what's usable now" without polling.
   */
  readonly isAvailable?: WatchableValueInterface<boolean>;
}

/**
 * A command backed by a DOM action: invoking it dispatches `action:<id>`,
 * exactly as the equivalent keyboard shortcut would. `id` doubles as the action
 * id, so existing actions need no extra wiring.
 */
export interface ActionCommandInfo extends CommandInfoBase {
  readonly type: "action";
}

/**
 * A command that runs a callback directly, for commands with no corresponding
 * DOM action (e.g. host-registered commands).
 */
export interface CallbackCommandInfo extends CommandInfoBase {
  readonly type: "callback";
  readonly invoke: (payload?: unknown) => unknown;
}

/**
 * A registered command. The `type` discriminant is stated explicitly by the
 * registrant rather than inferred from which optional fields are present, so
 * new command types can be added without changing how existing ones are read.
 */
export type CommandInfo = ActionCommandInfo | CallbackCommandInfo;

export type CommandType = CommandInfo["type"];

/**
 * Per-viewer registry of {@link CommandInfo}. Registration returns a disposer
 * that unregisters the command, so feature code can add commands for the
 * lifetime of a layer / control and clean up automatically.
 */
export class CommandRegistry extends RefCounted {
  private readonly commands = new Map<ActionIdentifier, CommandInfo>();
  private readonly availabilityDisposers = new Map<
    ActionIdentifier,
    () => void
  >();

  /** Dispatched when a command is added/removed, or its availability changes. */
  readonly changed = new Signal();

  /** Registers an action-backed command. See {@link ActionCommandInfo}. */
  registerAction(options: Omit<ActionCommandInfo, "type">): () => void {
    return this.register({ type: "action", ...options });
  }

  /** Registers a callback command. See {@link CallbackCommandInfo}. */
  registerCallback(options: Omit<CallbackCommandInfo, "type">): () => void {
    return this.register({ type: "callback", ...options });
  }

  /** Registers a command. Throws on duplicate `id`. Returns a disposer. */
  register(command: CommandInfo): () => void {
    const { id } = command;
    if (this.commands.has(id)) {
      throw new Error(`Command already registered: ${JSON.stringify(id)}`);
    }
    this.commands.set(id, command);
    const { isAvailable } = command;
    if (isAvailable !== undefined) {
      this.availabilityDisposers.set(
        id,
        isAvailable.changed.add(() => this.changed.dispatch()),
      );
    }
    this.changed.dispatch();
    return () => this.unregister(id);
  }

  unregister(id: ActionIdentifier): void {
    if (!this.commands.delete(id)) return;
    const disposer = this.availabilityDisposers.get(id);
    if (disposer !== undefined) {
      disposer();
      this.availabilityDisposers.delete(id);
    }
    this.changed.dispatch();
  }

  get(id: ActionIdentifier): CommandInfo | undefined {
    return this.commands.get(id);
  }

  has(id: ActionIdentifier): boolean {
    return this.commands.has(id);
  }

  /** Iterates every registered command, regardless of current availability. */
  values(): IterableIterator<CommandInfo> {
    return this.commands.values();
  }

  disposed() {
    for (const disposer of this.availabilityDisposers.values()) disposer();
    this.availabilityDisposers.clear();
    this.commands.clear();
    super.disposed();
  }
}
