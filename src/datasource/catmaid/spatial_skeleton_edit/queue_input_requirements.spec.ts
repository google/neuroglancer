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

import {
  getCatmaidQueueInputRequirements,
  getCatmaidMergeQueueInputRequirements,
} from "#src/datasource/catmaid/spatial_skeleton_edit/queue_input_requirements.js";

describe("getCatmaidQueueInputRequirements", () => {
  it("deduplicates required endpoints", () => {
    const endpoint = { segmentId: 7, nodeId: 11 };
    expect(getCatmaidQueueInputRequirements(endpoint, endpoint)).toEqual({
      required: [endpoint],
    });
  });

  it("declares the Merge destination as loadable", () => {
    const source = { segmentId: 7, nodeId: 11 };
    const target = { segmentId: 8, nodeId: 12 };
    expect(getCatmaidMergeQueueInputRequirements(source, target)).toEqual({
      required: [source],
      loadable: [target],
    });
  });

  it("does not expose a duplicate required endpoint as loadable", () => {
    const endpoint = { segmentId: 7, nodeId: 11 };
    expect(getCatmaidMergeQueueInputRequirements(endpoint, endpoint)).toEqual({
      required: [endpoint],
    });
  });
});
