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
import { svgCursor } from "#src/ui/tool_cursor.js";

describe("svgCursor", () => {
  it("keeps an SVG that contains quotes and # intact inside the cursor URL", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ff0000"/></svg>`;
    const cursor = svgCursor(svg, 20, "crosshair");
    const match =
      /^url\("data:image\/svg\+xml,([^"#]*)"\) 20 20, crosshair$/.exec(cursor);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe(svg);
  });
});
