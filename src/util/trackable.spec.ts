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
import { TrackableBoolean } from "#src/trackable_boolean.js";
import { CompoundTrackable, getCachedJson } from "#src/util/trackable.js";

function makeTestState() {
  function makeTestGroup() {
    const group = new CompoundTrackable();
    const trackable = new TrackableBoolean(true, true);
    group.add("trackable", trackable);
    return { group, trackable };
  }

  const root = new CompoundTrackable();
  const { group: group1, trackable: trackable1 } = makeTestGroup();
  const { group: group2, trackable: trackable2 } = makeTestGroup();
  root.add("group1", group1);
  root.add("group2", group2);
  return { root, trackable1, trackable2 };
}

describe("compound state JSON", () => {
  it("omits nested groups whose members are all at their defaults", () => {
    const { root } = makeTestState();
    expect(getCachedJson(root).value).toEqual({});
    expect(root.toJSON()).toEqual({});
  });

  it("writes only the nested group whose member differs from its default", () => {
    const { root, trackable1 } = makeTestState();
    trackable1.value = false;
    const expected = { group1: { trackable: false } };
    expect(getCachedJson(root).value).toEqual(expected);
    expect(root.toJSON()).toEqual(expected);
  });

  it("writes a nested group when a member changes after a cached read", () => {
    const { root, trackable2 } = makeTestState();
    expect(getCachedJson(root).value).toEqual({});
    trackable2.value = false;
    expect(getCachedJson(root).value).toEqual({ group2: { trackable: false } });
  });
});
