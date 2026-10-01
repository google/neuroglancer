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
import { wrapUserShaderMain } from "#src/webgl/dynamic_shader.js";

describe("wrapUserShaderMain", () => {
  // The whole output is the contract, the trailing reset most of all: three call
  // sites append generated code after it.
  it("renames main and hands line attribution back", () => {
    expect(wrapUserShaderMain("void main() {\n  emitDefault();\n}")).toBe(
      "\n#define main userMain\n" +
        "\n#line 0 1\n" +
        "void main() {\n  emitDefault();\n}" +
        "\n#undef main\n#line 1 0\n",
    );
  });

  it("ends outside the user's source string", () => {
    const wrapped = wrapUserShaderMain("void main() {}");
    const directives = wrapped.match(/#line \d+ \d+/g);
    expect(directives).toEqual(["#line 0 1", "#line 1 0"]);
    expect(wrapped.endsWith("#line 1 0\n")).toBe(true);
  });
});
