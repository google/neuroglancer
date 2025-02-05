/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { GL } from "#src/webgl/context.js";
import { initializeWebGL } from "#src/webgl/context.js";
import type { Fixture } from "#tests/fixtures/fixture.js";
import { fixture } from "#tests/fixtures/fixture.js";

export function glFixture(): Fixture<GL> {
  return fixture(async () => {
    return initializeWebGL(document.createElement("canvas"));
  });
}
