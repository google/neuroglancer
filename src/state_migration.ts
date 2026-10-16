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

import { NullarySignal } from "#src/util/signal.js";

export const CURRENT_STATE_VERSION = 1;

export function verifyStateVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Expected non-negative integer state version, but received: ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export class StateMigrationCoordinator {
  changed = new NullarySignal();
  private restoredStateVersion = CURRENT_STATE_VERSION;
  private restoring = false;
  private pendingMigrations = new Set<symbol>();

  beginRestore(stateVersion: number) {
    this.restoredStateVersion = stateVersion;
    this.restoring = true;
    this.pendingMigrations.clear();
    this.changed.dispatch();
  }

  endRestore() {
    this.restoring = false;
    this.changed.dispatch();
  }

  get stateVersion() {
    if (!this.restoring && this.pendingMigrations.size === 0) {
      return Math.max(this.restoredStateVersion, CURRENT_STATE_VERSION);
    }
    return this.restoredStateVersion;
  }

  registerMigration(targetVersion: number): (() => void) | undefined {
    if (!this.restoring || this.restoredStateVersion >= targetVersion) {
      return undefined;
    }
    const migration = Symbol();
    this.pendingMigrations.add(migration);
    this.changed.dispatch();
    let pending = true;
    return () => {
      if (!pending) return;
      pending = false;
      if (this.pendingMigrations.delete(migration)) {
        this.changed.dispatch();
      }
    };
  }
}
