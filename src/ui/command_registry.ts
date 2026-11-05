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
 * @file Registry of the {@link Command}s a viewer knows about.
 *
 * The registry owns *what commands exist*: their id, how they present, and how
 * they run. Bindings, ordering and grouping live with the consumers; a consumer
 * that wants to show a shortcut looks the live binding up itself.
 *
 * The registry is owned by the viewer, so commands can be registered before any
 * UI chrome exists, or without any at all. It lists the commands it was told
 * about, and there is no way to make that list complete: a viewer embedded in
 * another application, or driven from Python, can bind an action without ever
 * registering a command for it. See `docs/concepts/commands.rst`.
 */

import type { Command, CommandId } from "#src/ui/command.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

/**
 * Per-viewer registry of {@link Command}s. Registration returns a disposer that
 * unregisters the command, so feature code can add commands for the lifetime of
 * a layer / control and clean up automatically.
 */
export class CommandRegistry extends RefCounted {
  private readonly commands = new Map<CommandId, Command>();
  private readonly commandChangedDisposers = new Map<CommandId, () => void>();

  /**
   * Dispatched when a command is registered or unregistered, or when a
   * registered command reports a change of its own.
   */
  readonly changed = new NullarySignal();

  /** Registers `command`. Throws on duplicate id. Returns a disposer. */
  register(command: Command): () => void {
    const { id } = command;
    if (this.commands.has(id)) {
      throw new Error(`Command already registered: ${JSON.stringify(id)}`);
    }
    this.commands.set(id, command);
    this.commandChangedDisposers.set(
      id,
      command.changed.add(() => this.changed.dispatch()),
    );
    this.changed.dispatch();
    return () => this.unregister(id);
  }

  unregister(id: CommandId): void {
    if (!this.commands.delete(id)) return;
    const disposer = this.commandChangedDisposers.get(id);
    if (disposer !== undefined) {
      disposer();
      this.commandChangedDisposers.delete(id);
    }
    this.changed.dispatch();
  }

  get(id: CommandId): Command | undefined {
    return this.commands.get(id);
  }

  has(id: CommandId): boolean {
    return this.commands.has(id);
  }

  /** Iterates every registered command, enabled or not, in registration order. */
  values(): IterableIterator<Command> {
    return this.commands.values();
  }

  disposed() {
    for (const disposer of this.commandChangedDisposers.values()) disposer();
    this.commandChangedDisposers.clear();
    this.commands.clear();
    super.disposed();
  }
}
