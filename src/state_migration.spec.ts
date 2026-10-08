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

import { describe, expect, test } from "vitest";
import {
  CURRENT_STATE_VERSION,
  StateMigrationCoordinator,
  verifyStateVersion,
} from "#src/state_migration.js";

describe("StateMigrationCoordinator", () => {
  test("validates versions as exact non-negative integer numbers", () => {
    expect(verifyStateVersion(0)).toBe(0);
    expect(verifyStateVersion(2)).toBe(2);
    for (const value of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => verifyStateVersion(value)).toThrow();
    }
  });

  test("does not advance the version until deferred migrations complete", () => {
    const migrations = new StateMigrationCoordinator();
    migrations.beginRestore(0);
    expect(migrations.stateVersion).toBe(0);
    const complete = migrations.registerMigration(1)!;
    migrations.endRestore();
    expect(migrations.stateVersion).toBe(0);
    complete();
    expect(migrations.stateVersion).toBe(CURRENT_STATE_VERSION);
  });

  test("advances after a pending migration is discarded with its state", () => {
    const migrations = new StateMigrationCoordinator();
    migrations.beginRestore(0);
    const discard = migrations.registerMigration(1)!;
    migrations.endRestore();
    discard();
    expect(migrations.stateVersion).toBe(CURRENT_STATE_VERSION);
  });

  test("does not register migrations already covered by the restored version", () => {
    const migrations = new StateMigrationCoordinator();
    migrations.beginRestore(CURRENT_STATE_VERSION);
    expect(migrations.registerMigration(CURRENT_STATE_VERSION)).toBeUndefined();
    migrations.endRestore();
    expect(migrations.stateVersion).toBe(CURRENT_STATE_VERSION);
  });

  test("preserves a future state version", () => {
    const migrations = new StateMigrationCoordinator();
    migrations.beginRestore(CURRENT_STATE_VERSION + 1);
    migrations.endRestore();
    expect(migrations.stateVersion).toBe(CURRENT_STATE_VERSION + 1);
  });

  test("does not migrate state created after restoration", () => {
    const migrations = new StateMigrationCoordinator();
    migrations.beginRestore(0);
    migrations.endRestore();
    expect(migrations.registerMigration(CURRENT_STATE_VERSION)).toBeUndefined();
  });
});
