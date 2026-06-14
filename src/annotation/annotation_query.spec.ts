/**
 * @license
 * Copyright 2024 Google Inc.
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
  AnnotationQueryItem,
  AnnotationQuerySchema,
} from "#src/annotation/annotation_query.js";
import {
  buildAnnotationQueryItems,
  buildAnnotationQuerySchema,
  executeAnnotationQuery,
  makeAnnotationNumericalDataSource,
  parseAnnotationQuery,
  unparseAnnotationQuery,
} from "#src/annotation/annotation_query.js";
import { DataType } from "#src/util/data_type.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FLOAT_SPEC = {
  type: "float32" as const,
  identifier: "score",
  description: "Score value",
  default: 0,
  min: 0,
  max: 1,
};
const INT_SPEC = {
  type: "int32" as const,
  identifier: "count",
  description: undefined,
  default: 0,
};
const ENUM_SPEC = {
  type: "uint8" as const,
  identifier: "status",
  description: "Status code",
  default: 0,
  enumValues: [0, 1, 2],
  enumLabels: ["pending", "active", "done"],
};
const BOOL_SPEC = {
  type: "bool" as const,
  identifier: "verified",
  description: undefined,
  default: 0,
};

const ALL_SPECS = [FLOAT_SPEC, INT_SPEC, ENUM_SPEC, BOOL_SPEC];

function makeSchema(): AnnotationQuerySchema {
  return buildAnnotationQuerySchema(ALL_SPECS as any);
}

// Build items directly (without a real AnnotationLayerState)
function makeItems(
  rows: Array<{
    description?: string;
    score?: number;
    count?: number;
    status?: number;
    verified?: boolean;
  }>,
): AnnotationQueryItem[] {
  return rows.map((r) => {
    const values = new Map<string, number | boolean>();
    if (r.score !== undefined) values.set("score", r.score);
    if (r.count !== undefined) values.set("count", r.count);
    if (r.status !== undefined) values.set("status", r.status);
    if (r.verified !== undefined) values.set("verified", r.verified);
    return { description: r.description ?? "", values };
  });
}

// ---------------------------------------------------------------------------
// buildAnnotationQuerySchema
// ---------------------------------------------------------------------------

describe("buildAnnotationQuerySchema", () => {
  it("partitions specs correctly", () => {
    const schema = makeSchema();
    expect(schema.numericProps.map((p) => p.identifier)).toEqual([
      "score",
      "count",
    ]);
    expect(schema.enumProps.map((p) => p.identifier)).toEqual(["status"]);
    expect(schema.boolProps.map((p) => p.identifier)).toEqual(["verified"]);
  });

  it("sets bounds from spec min/max", () => {
    const schema = makeSchema();
    const scoreProp = schema.numericProps.find((p) => p.identifier === "score")!;
    expect(scoreProp.bounds).toEqual([0, 1]);
    expect(scoreProp.dataType).toBe(DataType.FLOAT32);
  });

  it("sets enum labels", () => {
    const schema = makeSchema();
    const statusProp = schema.enumProps[0];
    expect(statusProp.enumLabels).toEqual(["pending", "active", "done"]);
    expect(statusProp.enumValues).toEqual([0, 1, 2]);
  });

  it("skips rgb/rgba specs", () => {
    const schema = buildAnnotationQuerySchema([
      { type: "rgb", identifier: "color", description: undefined, default: 0 } as any,
      FLOAT_SPEC as any,
    ]);
    expect(schema.numericProps.map((p) => p.identifier)).toEqual(["score"]);
  });
});

// ---------------------------------------------------------------------------
// buildAnnotationQueryItems
// ---------------------------------------------------------------------------

describe("buildAnnotationQueryItems", () => {
  it("extracts property values by identifier", () => {
    const items = buildAnnotationQueryItems([
      {
        annotation: {
          description: "hello",
          properties: [0.5, 3, 1, 1],
        },
        propSpecs: ALL_SPECS as any,
      },
    ]);
    expect(items[0].description).toBe("hello");
    expect(items[0].values.get("score")).toBeCloseTo(0.5);
    expect(items[0].values.get("count")).toBe(3);
    expect(items[0].values.get("status")).toBe(1);
    expect(items[0].values.get("verified")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseAnnotationQuery
// ---------------------------------------------------------------------------

describe("parseAnnotationQuery", () => {
  const schema = makeSchema();

  it("returns empty query for empty string", () => {
    const result = parseAnnotationQuery(schema, "");
    expect("errors" in result).toBe(false);
    const q = result as any;
    expect(q.prefix).toBeUndefined();
    expect(q.regexp).toBeUndefined();
    expect(q.sortBy).toEqual([{ fieldId: "index", order: "<" }]);
  });

  it("parses description prefix", () => {
    const q = parseAnnotationQuery(schema, "hello world") as any;
    expect(q.prefix).toBe("hello world");
  });

  it("parses regexp", () => {
    const q = parseAnnotationQuery(schema, "/foo.*/") as any;
    expect(q.regexp?.source).toBe("foo.*");
  });

  it("parses sort ascending", () => {
    const q = parseAnnotationQuery(schema, "<score") as any;
    expect(q.sortBy).toContainEqual({ fieldId: "score", order: "<" });
  });

  it("parses sort descending", () => {
    const q = parseAnnotationQuery(schema, ">count") as any;
    expect(q.sortBy[0]).toEqual({ fieldId: "count", order: ">" });
  });

  it("parses sort by description", () => {
    const q = parseAnnotationQuery(schema, "<description") as any;
    expect(q.sortBy[0]).toEqual({ fieldId: "description", order: "<" });
  });

  it("parses column include", () => {
    const q = parseAnnotationQuery(schema, "|score") as any;
    expect(q.includeColumns).toContain("score");
  });

  it("parses numeric less-than constraint", () => {
    const q = parseAnnotationQuery(schema, "score<0.8") as any;
    expect(q.numericalConstraints[0].fieldId).toBe("score");
    expect((q.numericalConstraints[0].bounds[1] as number)).toBeLessThan(0.8);
  });

  it("parses numeric equal constraint", () => {
    const q = parseAnnotationQuery(schema, "count=5") as any;
    expect(q.numericalConstraints[0].bounds).toEqual([5, 5]);
  });

  it("parses numeric range: two constraints on same field", () => {
    const q = parseAnnotationQuery(schema, "score>=0.2 score<=0.9") as any;
    expect(q.numericalConstraints[0].fieldId).toBe("score");
    expect(q.numericalConstraints[0].bounds[0]).toBeCloseTo(0.2);
    expect(q.numericalConstraints[0].bounds[1]).toBeCloseTo(0.9);
  });

  it("parses enum include by label", () => {
    const q = parseAnnotationQuery(schema, "#status=active") as any;
    expect(q.enumConstraints[0].fieldId).toBe("status");
    expect(q.enumConstraints[0].include).toEqual([1]);
  });

  it("parses enum exclude by label (case-insensitive)", () => {
    const q = parseAnnotationQuery(schema, "-#status=DONE") as any;
    expect(q.enumConstraints[0].exclude).toEqual([2]);
  });

  it("parses bool require-true", () => {
    const q = parseAnnotationQuery(schema, "#verified") as any;
    expect(q.boolConstraints[0]).toEqual({ fieldId: "verified", value: true });
  });

  it("parses bool require-false", () => {
    const q = parseAnnotationQuery(schema, "-#verified") as any;
    expect(q.boolConstraints[0]).toEqual({ fieldId: "verified", value: false });
  });

  it("returns error for unknown field in sort", () => {
    const result = parseAnnotationQuery(schema, "<nonexistent");
    expect("errors" in result).toBe(true);
  });

  it("returns error for unknown numeric field", () => {
    const result = parseAnnotationQuery(schema, "nonexistent>=5");
    expect("errors" in result).toBe(true);
  });

  it("returns error for unknown enum property", () => {
    const result = parseAnnotationQuery(schema, "#nonexistent=val");
    expect("errors" in result).toBe(true);
  });

  it("returns error for impossible constraint", () => {
    const result = parseAnnotationQuery(schema, "score>=0.9 score<=0.1");
    expect("errors" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeAnnotationQuery
// ---------------------------------------------------------------------------

describe("executeAnnotationQuery", () => {
  const schema = makeSchema();
  const items = makeItems([
    { description: "apple", score: 0.9, count: 1, status: 0, verified: true },
    { description: "banana", score: 0.5, count: 2, status: 1, verified: false },
    { description: "cherry", score: 0.3, count: 3, status: 2, verified: true },
    { description: "apricot", score: 0.7, count: 4, status: 0, verified: false },
  ]);

  it("returns all indices when query has no constraints", () => {
    const q = parseAnnotationQuery(schema, "") as any;
    const result = executeAnnotationQuery(items, q);
    expect(result.count).toBe(4);
    expect(result.total).toBe(4);
  });

  it("filters by description prefix", () => {
    const q = parseAnnotationQuery(schema, "ap") as any;
    const result = executeAnnotationQuery(items, q);
    // apple and apricot
    expect(result.count).toBe(2);
    expect(Array.from(result.indices!)).toEqual(expect.arrayContaining([0, 3]));
  });

  it("filters by description regexp", () => {
    const q = parseAnnotationQuery(schema, "/^a/") as any;
    const result = executeAnnotationQuery(items, q);
    expect(result.count).toBe(2);
  });

  it("filters by numeric constraint", () => {
    const q = parseAnnotationQuery(schema, "score>=0.6") as any;
    const result = executeAnnotationQuery(items, q);
    // apple(0.9), banana(0.5 — NO), apricot(0.7) → 2 items
    expect(result.count).toBe(2);
  });

  it("filters by enum include", () => {
    const q = parseAnnotationQuery(schema, "#status=pending") as any;
    const result = executeAnnotationQuery(items, q);
    // apple(status=0=pending) and apricot(status=0=pending) → 2
    expect(result.count).toBe(2);
  });

  it("filters by enum exclude", () => {
    const q = parseAnnotationQuery(schema, "-#status=pending") as any;
    const result = executeAnnotationQuery(items, q);
    // banana(1) and cherry(2) → 2
    expect(result.count).toBe(2);
  });

  it("filters by bool true", () => {
    const q = parseAnnotationQuery(schema, "#verified") as any;
    const result = executeAnnotationQuery(items, q);
    // apple and cherry → 2
    expect(result.count).toBe(2);
  });

  it("filters by bool false", () => {
    const q = parseAnnotationQuery(schema, "-#verified") as any;
    const result = executeAnnotationQuery(items, q);
    // banana and apricot → 2
    expect(result.count).toBe(2);
  });

  it("sorts by property ascending", () => {
    const q = parseAnnotationQuery(schema, "<count") as any;
    const result = executeAnnotationQuery(items, q);
    const counts = Array.from(result.indices!).map((i) => items[i].values.get("count") as number);
    expect(counts).toEqual([1, 2, 3, 4]);
  });

  it("sorts by property descending", () => {
    const q = parseAnnotationQuery(schema, ">score") as any;
    const result = executeAnnotationQuery(items, q);
    const scores = Array.from(result.indices!).map((i) => items[i].values.get("score") as number);
    // descending: 0.9, 0.7, 0.5, 0.3
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it("sorts by description", () => {
    const q = parseAnnotationQuery(schema, "<description") as any;
    const result = executeAnnotationQuery(items, q);
    const descs = Array.from(result.indices!).map((i) => items[i].description);
    expect(descs).toEqual(["apple", "apricot", "banana", "cherry"]);
  });

  it("combines prefix and numeric constraint", () => {
    const q = parseAnnotationQuery(schema, "a score>=0.8") as any;
    const result = executeAnnotationQuery(items, q);
    // prefix "a": apple(0.9), apricot(0.7); score>=0.8: only apple
    expect(result.count).toBe(1);
    expect(result.indices![0]).toBe(0);
  });

  it("populates intermediateIndices for marginal CDFs", () => {
    const q = parseAnnotationQuery(schema, "score>=0.6") as any;
    const result = executeAnnotationQuery(items, q);
    // intermediateIndices = all indices (no desc/bool/enum filter), mask says which pass score>=0.6
    expect(result.intermediateIndices).toBeDefined();
    expect(result.intermediateIndicesMask).toBeDefined();
    expect((result.intermediateIndices as any).length).toBe(4);
  });

  it("missing property values sort to end", () => {
    const sparseItems = makeItems([
      { description: "a", score: 0.5 },
      { description: "b" }, // no score
      { description: "c", score: 0.3 },
    ]);
    const q = parseAnnotationQuery(schema, "<score") as any;
    const result = executeAnnotationQuery(sparseItems, q);
    const scores = Array.from(result.indices!).map(
      (i) => sparseItems[i].values.get("score") as number | undefined,
    );
    // b (missing) should be last
    expect(scores[scores.length - 1]).toBeUndefined();
  });

  it("computes enumStats", () => {
    const q = parseAnnotationQuery(schema, "#status=pending") as any;
    const result = executeAnnotationQuery(items, q);
    expect(result.enumStats.get("status")?.get(0)).toBe(2); // 2 pending items
  });

  it("computes boolStats", () => {
    const q = parseAnnotationQuery(schema, "#verified") as any;
    const result = executeAnnotationQuery(items, q);
    expect(result.boolStats.get("verified")?.trueCount).toBe(2);
    expect(result.boolStats.get("verified")?.falseCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// unparseAnnotationQuery
// ---------------------------------------------------------------------------

describe("unparseAnnotationQuery", () => {
  const schema = makeSchema();

  it("round-trips sort order", () => {
    const q = parseAnnotationQuery(schema, ">score") as any;
    const reparsed = parseAnnotationQuery(schema, unparseAnnotationQuery(q)) as any;
    expect(reparsed.sortBy[0]).toEqual({ fieldId: "score", order: ">" });
  });

  it("round-trips enum constraint", () => {
    const q = parseAnnotationQuery(schema, "#status=active") as any;
    const reparsed = parseAnnotationQuery(schema, unparseAnnotationQuery(q)) as any;
    expect(reparsed.enumConstraints[0].include).toEqual([1]);
  });

  it("round-trips bool constraint", () => {
    const q = parseAnnotationQuery(schema, "-#verified") as any;
    const reparsed = parseAnnotationQuery(schema, unparseAnnotationQuery(q)) as any;
    expect(reparsed.boolConstraints[0].value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeAnnotationNumericalDataSource
// ---------------------------------------------------------------------------

describe("makeAnnotationNumericalDataSource", () => {
  const schema = makeSchema();
  const items = makeItems([
    { score: 0.2 },
    { score: 0.5 },
    { score: 0.8 },
  ]);

  it("exposes numericProps as properties", () => {
    const ds = makeAnnotationNumericalDataSource(schema, () => items);
    expect(ds.properties.map((p) => p.id)).toEqual(["score", "count"]);
  });

  it("fills histograms when query has indices", () => {
    const ds = makeAnnotationNumericalDataSource(schema, () => items);
    const q = parseAnnotationQuery(schema, "") as any;
    const result = executeAnnotationQuery(items, q);
    const windowBounds: [number, number][] = [[0, 1], [-2147483648, 2147483647]];
    const histograms: any[] = [];
    ds.updateHistograms(result, histograms, windowBounds as any);
    expect(histograms.length).toBe(2);
    // sum of histogram bins should equal number of items that have the property
    const scoreSum = Array.from(histograms[0].histogram as Uint32Array).reduce(
      (a: number, b: number) => a + b,
      0,
    );
    expect(scoreSum).toBe(3);
  });

  it("clears histograms when queryResult is undefined", () => {
    const ds = makeAnnotationNumericalDataSource(schema, () => items);
    const histograms: any[] = [{ window: [0, 1], histogram: new Uint32Array(258) }];
    const windowBounds = [[0, 1]];
    ds.updateHistograms(undefined as any, histograms, windowBounds as any);
    expect(histograms.length).toBe(0);
  });
});
