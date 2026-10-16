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
import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import { upgradeLegacyAnnotationShader } from "#src/layer/annotation/shader.js";
import {
  CURRENT_STATE_VERSION,
  StateMigrationCoordinator,
} from "#src/state_migration.js";

const properties = [
  { identifier: "visible", type: "bool", default: 0 },
  { identifier: "reviewed", type: "bool", default: 0 },
  { identifier: "score", type: "uint8", default: 0 },
] as AnnotationPropertySpec[];

describe("upgradeLegacyAnnotationShader", () => {
  test("permanently rewrites bool property identifier tokens", () => {
    const shader = `
#define PROPERTY_FUNCTION prop_visible
#define CALL_PROPERTY(functionName) functionName()
void main() {
  uint direct = prop_visible();
  uint alias = PROPERTY_FUNCTION();
  uint macro = CALL_PROPERTY(prop_reviewed);
  uint score = prop_score();
}
`;
    expect(upgradeLegacyAnnotationShader(shader, properties)).toBe(`
#define PROPERTY_FUNCTION uint_prop_visible
#define CALL_PROPERTY(functionName) functionName()
void main() {
  uint direct = uint_prop_visible();
  uint alias = PROPERTY_FUNCTION();
  uint macro = CALL_PROPERTY(uint_prop_reviewed);
  uint score = prop_score();
}
`);
  });

  test("preserves comments, strings, and unrelated identifiers", () => {
    const shader = `
#uicontrol string_t label select(options=["prop_visible()"])
// prop_visible() remains documented here.
/* prop_reviewed() also remains documented. */
void main() {
  uint prop_visible_value = prop_visible();
}
`;
    expect(upgradeLegacyAnnotationShader(shader, properties)).toBe(`
#uicontrol string_t label select(options=["prop_visible()"])
// prop_visible() remains documented here.
/* prop_reviewed() also remains documented. */
void main() {
  uint prop_visible_value = uint_prop_visible();
}
`);
  });

  test("is idempotent", () => {
    const shader = "void main() { uint value = uint_prop_visible(); }";
    expect(upgradeLegacyAnnotationShader(shader, properties)).toBe(shader);
  });

  test("does not advance state version until the property schema resolves", () => {
    const migrations = new StateMigrationCoordinator();
    migrations.beginRestore(0);
    const completeMigration = migrations.registerMigration(
      CURRENT_STATE_VERSION,
    )!;
    migrations.endRestore();

    let shader = "void main() { uint value = prop_visible(); }";
    expect(migrations.stateVersion).toBe(0);

    shader = upgradeLegacyAnnotationShader(shader, properties);
    completeMigration();
    expect(shader).toBe("void main() { uint value = uint_prop_visible(); }");
    expect(migrations.stateVersion).toBe(CURRENT_STATE_VERSION);
  });
});
