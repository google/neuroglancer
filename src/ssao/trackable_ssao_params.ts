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

import { TrackableBoolean } from "#src/trackable_boolean.js";
import { TrackableValue } from "#src/trackable_value.js";
import { verifyFiniteFloat } from "#src/util/json.js";
import { CompoundTrackable } from "#src/util/trackable.js";

// Slider / clamp range for the SSAO sampling radius.
export const SSAO_RADIUS_RANGE = { min: 0.01, max: 3, step: 0.01 };
// Slider / clamp range for the AO power exponent at composite time.
export const SSAO_INTENSITY_RANGE = { min: 0.5, max: 5.0, step: 0.1 };

// Clamps the parsed value to the given range; out-of-range URL state lands
// in-range rather than falling back to the default.
function clampToRange(range: { min: number; max: number }) {
  return (obj: unknown) =>
    Math.min(range.max, Math.max(range.min, verifyFiniteFloat(obj)));
}

export class TrackableSSAO extends CompoundTrackable {
  enabled = new TrackableBoolean(false, false);
  intensity = new TrackableValue<number>(
    1.8,
    clampToRange(SSAO_INTENSITY_RANGE),
    1.8,
  );
  radius = new TrackableValue<number>(
    0.2,
    clampToRange(SSAO_RADIUS_RANGE),
    0.2,
  );

  constructor() {
    super();
    this.add("enabled", this.enabled);
    this.add("intensity", this.intensity);
    this.add("radius", this.radius);
  }

  toJSON(): any {
    const result = super.toJSON();
    for (const key of Object.keys(result)) {
      if (result[key] === undefined) delete result[key];
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }
}
