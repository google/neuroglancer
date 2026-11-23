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

import { describe, it, expect } from "vitest";
import {
  SSAO_DEPTH_CUE_RANGE,
  SSAO_INTENSITY_RANGE,
  SSAO_RADIUS_RANGE,
  TrackableSSAO,
} from "#src/ssao/trackable_ssao_params.js";
import { CompoundTrackable, getCachedJson } from "#src/util/trackable.js";

describe("TrackableSSAO", () => {
  it("has the documented defaults", () => {
    const ssao = new TrackableSSAO();
    expect(ssao.enabled.value).toBe(false);
    expect(ssao.intensity.value).toBe(1.8);
    expect(ssao.radius.value).toBe(0.2);
    expect(ssao.depthCue.value).toBe(0);
  });

  it("is omitted from its parent's JSON at defaults", () => {
    // Keeps an untouched viewer from adding an `ssao` key to the URL.
    const parent = new CompoundTrackable();
    const ssao = new TrackableSSAO();
    parent.add("ssao", ssao);
    expect(parent.toJSON()).toEqual({});
    expect(getCachedJson(parent).value).toEqual({});

    ssao.depthCue.value = 0.3;
    expect(parent.toJSON()).toEqual({ ssao: { depthCue: 0.3 } });
    expect(getCachedJson(parent).value).toEqual({ ssao: { depthCue: 0.3 } });
  });

  it("round-trips a partial state and keeps other defaults", () => {
    const ssao = new TrackableSSAO();
    ssao.restoreState({ depthCue: 0.3 });
    expect(ssao.depthCue.value).toBe(0.3);
    expect(ssao.radius.value).toBe(0.2);
    expect(ssao.toJSON()).toEqual({ depthCue: 0.3 });

    const copy = new TrackableSSAO();
    copy.restoreState(ssao.toJSON());
    expect(copy.toJSON()).toEqual({ depthCue: 0.3 });
  });

  it("round-trips every field", () => {
    const state = { enabled: true, intensity: 2.5, radius: 0.4, depthCue: 0.7 };
    const ssao = new TrackableSSAO();
    ssao.restoreState(state);
    expect(ssao.toJSON()).toEqual(state);
  });

  it("clamps out-of-range values on restore", () => {
    const ssao = new TrackableSSAO();
    ssao.restoreState({ intensity: 100, radius: 5, depthCue: -1 });
    expect(ssao.intensity.value).toBe(SSAO_INTENSITY_RANGE.max);
    expect(ssao.radius.value).toBe(SSAO_RADIUS_RANGE.max);
    expect(ssao.depthCue.value).toBe(SSAO_DEPTH_CUE_RANGE.min);
  });

  it("falls back to the default for a non-numeric value", () => {
    const ssao = new TrackableSSAO();
    ssao.radius.value = 0.4;
    ssao.restoreState({ radius: "big" });
    expect(ssao.radius.value).toBe(0.2);
  });
});
