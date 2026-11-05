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
import { rankedMatches } from "#src/util/ranked_matches.js";

describe("rankedMatches", () => {
  const items = [
    { label: "Edit JSON State" },
    { label: "Screenshot" },
    { label: "Toggle Scale Bar" },
  ];

  it("returns all items for an empty query", () => {
    expect(rankedMatches(items, "label", "")).toStrictEqual(items);
  });

  it("is case-insensitive", () => {
    expect(rankedMatches(items, "label", "EDIT")).toStrictEqual([
      { label: "Edit JSON State" },
    ]);
    expect(rankedMatches(items, "label", "edit")).toStrictEqual([
      { label: "Edit JSON State" },
    ]);
  });

  it("ranks prefix matches before substring matches", () => {
    expect(rankedMatches(items, "label", "s")).toStrictEqual([
      { label: "Screenshot" },
      { label: "Edit JSON State" },
      { label: "Toggle Scale Bar" },
    ]);
  });

  it("returns empty for a non-matching query", () => {
    expect(rankedMatches(items, "label", "xyz")).toHaveLength(0);
  });

  it("matches on the named property", () => {
    const groups = [
      { label: "Select Layer", shortcut: "Ctrl+1–9" },
      { label: "Toggle Layer Visibility", shortcut: "1–9" },
    ];
    expect(rankedMatches(groups, "shortcut", "ctrl")).toStrictEqual([
      { label: "Select Layer", shortcut: "Ctrl+1–9" },
    ]);
  });
});
