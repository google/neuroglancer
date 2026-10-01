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
import type {
  PropertyQueryDomainResolver,
  ResolvedPropertyQueryBase,
} from "#src/ui/property_query.js";
import {
  parsePropertyQuerySyntax,
  resolvePropertyQuery,
  serializePropertyQueryClauses,
  tokenizePropertyQuery,
} from "#src/ui/property_query.js";
import { DataType } from "#src/util/data_type.js";
import type { DataTypeInterval } from "#src/util/lerp.js";

describe("tokenizePropertyQuery", () => {
  test("uses all whitespace and preserves source ranges", () => {
    expect(tokenizePropertyQuery("  <score\t#status=active\ntext ")).toEqual([
      { text: "<score", begin: 2, end: 8 },
      { text: "#status=active", begin: 9, end: 23 },
      { text: "text", begin: 24, end: 28 },
    ]);
  });
});

describe("parsePropertyQuerySyntax", () => {
  test("parses every shared clause without assigning domain meaning", () => {
    const result = parsePropertyQuerySyntax(
      "<score >count |length score>=0.5 #verified -#status=done /foo.*/ text",
    );
    expect(result.errors).toEqual([]);
    expect(result.clauses.map(({ type }) => type)).toEqual([
      "sort",
      "sort",
      "column",
      "comparison",
      "categorical",
      "categorical",
      "regexp",
      "text",
    ]);
    expect(result.clauses[3]).toMatchObject({
      field: "score",
      operator: ">=",
      value: "0.5",
    });
    expect(result.clauses[5]).toMatchObject({
      exclude: true,
      field: "status",
      value: "done",
    });
    expect(result.clauses[6]).toMatchObject({
      pattern: "foo.*",
      closed: true,
    });
  });

  test("accepts a regexp without a closing slash", () => {
    expect(parsePropertyQuerySyntax("/foo").clauses[0]).toMatchObject({
      type: "regexp",
      pattern: "foo",
      closed: false,
    });
  });

  test("leaves non-numeric equality expressions for domain text handling", () => {
    expect(parsePropertyQuerySyntax("label=foo").clauses[0]).toMatchObject({
      type: "text",
      value: "label=foo",
    });
  });

  test("reports source-ranged missing fields", () => {
    expect(parsePropertyQuerySyntax("x <  |").errors).toEqual([
      { begin: 2, end: 3, message: "Sort field is missing" },
      { begin: 5, end: 6, message: "Column field is missing" },
    ]);
  });
});

describe("serializePropertyQueryClauses", () => {
  test("serializes the common canonical syntax", () => {
    expect(
      serializePropertyQueryClauses([
        { type: "sort", field: "score", order: "<" },
        { type: "column", field: "length" },
        {
          type: "comparison",
          field: "score",
          operator: ">=",
          value: "0.5",
        },
        {
          type: "categorical",
          exclude: true,
          field: "status",
          value: "done",
        },
        { type: "regexp", pattern: "foo.*", closed: true },
        { type: "text", value: "text" },
      ]),
    ).toBe("<score |length score>=0.5 -#status=done /foo.*/ text");
  });
});

describe("resolvePropertyQuery", () => {
  interface TestQuery extends ResolvedPropertyQueryBase {
    categories: string[];
  }

  const makeResolver = (): PropertyQueryDomainResolver<TestQuery> => ({
    createQuery: () => ({
      prefix: undefined as string | undefined,
      regexp: undefined as RegExp | undefined,
      numericalConstraints: [],
      sortBy: [],
      includeColumns: [],
      categories: [] as string[],
    }),
    resolveSortField: (clause: {
      field: string;
      begin: number;
      end: number;
    }) =>
      clause.field === "score"
        ? ({ value: "score" } as const)
        : ({
            error: {
              begin: clause.begin + 1,
              end: clause.end,
              message: `Unknown sort field: ${clause.field}`,
            },
          } as const),
    resolveColumnField: () => ({ value: "score" }) as const,
    resolveNumericField: () =>
      ({
        value: {
          fieldId: "score",
          dataType: DataType.INT32,
          bounds: [0, 10] as DataTypeInterval,
        },
      }) as const,
    applyCategoricalClause: (query, clause) => {
      query.categories.push(clause.field);
    },
    defaultSort: { fieldId: "index", order: "<" as const },
    regexpFlags: "i",
  });

  test("resolves common clauses and narrows numerical intervals", () => {
    const result = resolvePropertyQuery<TestQuery>(
      "score>=2 score<8 |score #active /foo/",
      makeResolver(),
    );
    expect(result).toMatchObject({
      regexp: /foo/i,
      numericalConstraints: [{ fieldId: "score", bounds: [2, 7] }],
      includeColumns: ["score"],
      categories: ["active"],
      sortBy: [{ fieldId: "index", order: "<" }],
    });
  });

  test("reports duplicate sorts and regexp/text conflicts", () => {
    expect(
      resolvePropertyQuery<TestQuery>(
        "<score >score /foo/ text",
        makeResolver(),
      ),
    ).toEqual({
      errors: [
        { begin: 8, end: 13, message: "Duplicate sort field: score" },
        {
          begin: 20,
          end: 24,
          message: "Prefix cannot be combined with regular expression",
        },
      ],
    });
  });

  test("combines multiple text clauses", () => {
    expect(
      resolvePropertyQuery<TestQuery>("alpha beta", makeResolver()),
    ).toMatchObject({ prefix: "alpha beta" });
  });
});
