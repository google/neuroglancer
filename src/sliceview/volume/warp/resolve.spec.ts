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
import type {
  WarpDimensionHints,
  WarpFieldDimension,
} from "#src/sliceview/volume/warp/resolve.js";
import { resolveWarpDimensions } from "#src/sliceview/volume/warp/resolve.js";

/** "z:m:100" -> a dimension; "c:disp:3" -> the OME displacement axis. */
function fieldDims(spec: string): WarpFieldDimension[] {
  return spec.split(" ").map((s) => {
    const [name, unit, size] = s.split(":");
    return unit === "disp"
      ? { name, unit: "", size: Number(size), isDisplacementAxis: true }
      : { name, unit, size: Number(size) };
  });
}

function movingDims(spec: string) {
  return spec.split(" ").map((s) => {
    const [name, unit] = s.split(":");
    return { name, unit };
  });
}

/** Compact summary: roles by name, and the passthrough dimensions. */
function summarize(
  field: string,
  moving: string,
  hints: WarpDimensionHints = {},
) {
  const f = fieldDims(field);
  const m = movingDims(moving);
  const r = resolveWarpDimensions(f, m, hints);
  return {
    vector: f[r.vectorDim].name,
    components: r.componentDims.map((i) => f[i].name),
    dims: r.fieldDims.map(
      (d) =>
        `${f[d.fieldDim].name}:${d.role}${d.movingDim === -1 ? ":gained" : ""}`,
    ),
    dropped: r.droppedDims.map((i) => f[i].name),
    passthrough: r.passthrough.map(
      (p) => `${m[p.movingDim].name}:${p.whole ? "whole" : "sliced"}`,
    ),
    messages: r.messages.length,
  };
}

describe("resolveWarpDimensions", () => {
  const cases: {
    name: string;
    field: string;
    moving: string;
    hints?: WarpDimensionHints;
    expected: ReturnType<typeof summarize>;
  }[] = [
    {
      name: "3-d OME field on a 3-d image (today)",
      field: "c:disp:3 z:m:100 y:m:100 x:m:100",
      moving: "x:m y:m z:m",
      expected: {
        vector: "c",
        components: ["z", "y", "x"],
        dims: ["z:displaced", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: [],
        messages: 0,
      },
    },
    {
      name: "channels pass through whole (today)",
      field: "c:disp:3 z:m:100 y:m:100 x:m:100",
      moving: "c^: x:m y:m z:m",
      expected: {
        vector: "c",
        components: ["z", "y", "x"],
        dims: ["z:displaced", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: ["c^:whole"],
        messages: 0,
      },
    },
    {
      name: "4-d t x xyz image with a static 3-d field",
      field: "c:disp:3 z:m:100 y:m:100 x:m:100",
      moving: "t:s z:m y:m x:m",
      expected: {
        vector: "c",
        components: ["z", "y", "x"],
        dims: ["z:displaced", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: ["t:sliced"],
        messages: 0,
      },
    },
    {
      name: "4-d image with a time-varying 3-d field (unit kinds)",
      field: "t:s:20 z:m:100 y:m:100 x:m:100 c^::3",
      moving: "t:s z:m y:m x:m",
      expected: {
        vector: "c^",
        components: ["z", "y", "x"],
        dims: ["t:indexed", "z:displaced", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: [],
        messages: 0,
      },
    },
    {
      name: "a 4-d warp (4 components, including t)",
      field: "t:s:20 z:m:100 y:m:100 x:m:100 c^::4",
      moving: "t:s z:m y:m x:m",
      expected: {
        vector: "c^",
        components: ["t", "z", "y", "x"],
        dims: ["t:displaced", "z:displaced", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: [],
        messages: 0,
      },
    },
    {
      name: "a 2-d field on a z-stack, slice by slice",
      field: "y:m:100 x:m:100 c^::2",
      moving: "z:m y:m x:m",
      expected: {
        vector: "c^",
        components: ["y", "x"],
        dims: ["y:displaced", "x:displaced"],
        dropped: [],
        passthrough: ["z:sliced"],
        messages: 0,
      },
    },
    {
      name: "per-section 2-d fields (SEAMLeSS), displaced dims given",
      field: "z:m:7000 y:m:100 x:m:100 c^::2",
      moving: "x:m y:m z:m",
      hints: { vectorDimensions: ["y", "x"] },
      expected: {
        vector: "c^",
        components: ["y", "x"],
        dims: ["z:indexed", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: [],
        messages: 0,
      },
    },
    {
      name: "an ANTs NIfTI field (x, y, z, t = 1, c^ = 3)",
      field: "x:m:100 y:m:100 z:m:100 t::1 c^::3",
      moving: "x:m y:m z:m",
      hints: { componentOrder: ["x", "y", "z"] },
      expected: {
        vector: "c^",
        components: ["x", "y", "z"],
        dims: ["x:displaced", "y:displaced", "z:displaced"],
        dropped: ["t"],
        passthrough: [],
        messages: 0,
      },
    },
    {
      name: "an ANTs NIfTI field on a 4-d image keeps t as passthrough",
      field: "x:m:100 y:m:100 z:m:100 t:s:1 c^::3",
      moving: "x:m y:m z:m t:s",
      expected: {
        vector: "c^",
        components: ["x", "y", "z"],
        dims: ["x:displaced", "y:displaced", "z:displaced"],
        dropped: ["t"],
        passthrough: ["t:sliced"],
        messages: 0,
      },
    },
    {
      name: "a 3-d field on a 2-d image: the output gains z",
      field: "c:disp:3 z:m:100 y:m:100 x:m:100",
      moving: "y:m x:m",
      expected: {
        vector: "c",
        components: ["z", "y", "x"],
        dims: ["z:displaced:gained", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: [],
        messages: 1,
      },
    },
    {
      name: "a displaced dimension of size 1 is a constant warp along it",
      field: "c:disp:3 z:m:1 y:m:100 x:m:100",
      moving: "z:m y:m x:m",
      expected: {
        vector: "c",
        components: ["z", "y", "x"],
        dims: ["z:displaced", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: [],
        messages: 0,
      },
    },
    {
      name: "a size-1 dimension that is not displaced is dropped",
      field: "t:s:1 z:m:100 y:m:100 x:m:100 c^::3",
      moving: "t:s z:m y:m x:m",
      expected: {
        vector: "c^",
        components: ["z", "y", "x"],
        dims: ["z:displaced", "y:displaced", "x:displaced"],
        dropped: ["t"],
        passthrough: ["t:sliced"],
        messages: 0,
      },
    },
    {
      name: "an OME channel axis (c') is the vector dimension",
      field: "y:m:100 x:m:100 c'::2",
      moving: "z:m y:m x:m",
      expected: {
        vector: "c'",
        components: ["y", "x"],
        dims: ["y:displaced", "x:displaced"],
        dropped: [],
        passthrough: ["z:sliced"],
        messages: 0,
      },
    },
    {
      name: "component order follows componentOrder (NIfTI x, y, z)",
      field: "z:m:100 x:m:100 y:m:100 c^::3",
      moving: "x:m y:m z:m",
      hints: { componentOrder: ["x", "y", "z"] },
      expected: {
        vector: "c^",
        components: ["x", "y", "z"],
        dims: ["z:displaced", "x:displaced", "y:displaced"],
        dropped: [],
        passthrough: [],
        messages: 0,
      },
    },
    {
      name: "a dropped size-1 dimension's unit is not checked",
      field: "x:m:100 y:m:100 z:m:100 t::1 c^::3",
      moving: "t:s z:m y:m x:m",
      expected: {
        vector: "c^",
        components: ["x", "y", "z"],
        dims: ["x:displaced", "y:displaced", "z:displaced"],
        dropped: ["t"],
        passthrough: ["t:sliced"],
        messages: 0,
      },
    },
    {
      name: "local dimensions of the source pass through whole",
      field: "c:disp:3 z:m:100 y:m:100 x:m:100",
      moving: "c' z:m y:m x:m",
      expected: {
        vector: "c",
        components: ["z", "y", "x"],
        dims: ["z:displaced", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: ["c':whole"],
        messages: 0,
      },
    },
    {
      name: "vectorDimension names a non-channel vector dimension",
      field: "v::3 z:m:100 y:m:100 x:m:100",
      moving: "z:m y:m x:m",
      hints: { vectorDimension: "v" },
      expected: {
        vector: "v",
        components: ["z", "y", "x"],
        dims: ["z:displaced", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: [],
        messages: 0,
      },
    },
    {
      name: "metadata says which dimensions are displaced",
      field: "c:disp:2 z:m:50 y:m:100 x:m:100",
      moving: "z:m y:m x:m",
      hints: { metadataVectorDimensions: ["y", "x"] },
      expected: {
        vector: "c",
        components: ["y", "x"],
        dims: ["z:indexed", "y:displaced", "x:displaced"],
        dropped: [],
        passthrough: [],
        messages: 0,
      },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(summarize(c.field, c.moving, c.hints)).toEqual(c.expected);
    });
  }

  const errors: {
    name: string;
    field: string;
    moving: string;
    hints?: WarpDimensionHints;
    message: RegExp;
  }[] = [
    {
      name: "no vector dimension",
      field: "z:m:100 y:m:100 x:m:100",
      moving: "z:m y:m x:m",
      message: /no vector dimension/,
    },
    {
      name: "several candidate vector dimensions",
      field: "a^::3 b^::3 x:m:100",
      moving: "x:m",
      message: /several candidate vector dimensions \["a\^","b\^"\]/,
    },
    {
      name: "vectorDimension that does not exist",
      field: "z:m:100 y:m:100 x:m:100",
      moving: "z:m y:m x:m",
      hints: { vectorDimension: "c" },
      message: /vectorDimension "c" is not a field dimension/,
    },
    {
      name: "components cannot be matched to displaced dimensions",
      field: "z:m:7000 y:m:100 x:m:100 c^::2",
      moving: "z:m y:m x:m",
      message: /ambiguous: 2 components .*"vectorDimensions"/,
    },
    {
      name: "explicit displaced dimensions of the wrong count",
      field: "z:m:100 y:m:100 x:m:100 c^::3",
      moving: "z:m y:m x:m",
      hints: { vectorDimensions: ["y", "x"] },
      message: /3 components but 2 displaced dimensions/,
    },
    {
      name: "no displaced dimension matches the image (naming)",
      field: "d0:m:100 d1:m:100 d2:m:100 c^::3",
      moving: "x:m y:m z:m",
      message:
        /no displaced field dimension matches a source dimension by name.*field dimensions \["d0","d1","d2","c\^"\], source dimensions \["x","y","z"\]/,
    },
    {
      name: "unit kinds differ",
      field: "t:m:20 z:m:100 y:m:100 x:m:100 c^::4",
      moving: "t:s z:m y:m x:m",
      message: /dimension "t" has unit "m" in the field but "s" in the source/,
    },
    {
      name: "an indexed dimension the image lacks",
      field: "t:s:20 z:m:100 y:m:100 x:m:100 c^::3",
      moving: "z:m y:m x:m",
      message: /varies along "t" but the source has no such dimension/,
    },
  ];
  for (const c of errors) {
    it(`error: ${c.name}`, () => {
      expect(() =>
        resolveWarpDimensions(
          fieldDims(c.field),
          movingDims(c.moving),
          c.hints,
        ),
      ).toThrow(c.message);
    });
  }
});
