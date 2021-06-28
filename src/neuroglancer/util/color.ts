/**
 * @license
 * Copyright 2018 Google Inc.
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

/**
 * @file Facilities for converting between strings and RGB/RGBA colors.
 */

import {WatchableValue} from 'neuroglancer/trackable_value';
import {float32ToString} from 'neuroglancer/util/float32_to_string';
import {vec3, vec4} from 'neuroglancer/util/geom';
import {hexEncodeByte} from 'neuroglancer/util/hex';

/**
 * Parse the serialization of a color.
 *
 * This is based on the definition here:
 * https://html.spec.whatwg.org/multipage/canvas.html#serialisation-of-a-color
 */
export function parseColorSerialization(x: string) {
  const rgbaPattern = /^rgba\(([0-9]+), ([0-9]+), ([0-9]+), (0(?:\.[0-9]+)?)\)$/;
  {
    const m = x.match(rgbaPattern);
    if (m !== null) {
      return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseFloat(m[4])];
    }
  }
  const hexPattern = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/;
  {
    const m = x.match(hexPattern);
    if (m !== null) {
      return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 1.0];
    }
  }
  throw new Error(`Invalid serialized color: ${JSON.stringify(x)}.`);
}

export function parseRGBAColorSpecification(x: any) {
  try {
    if (typeof x !== 'string') {
      throw new Error(`Expected string, but received ${JSON.stringify(x)}.`);
    }
    const context = document.createElement('canvas').getContext('2d')!;
    context.fillStyle = x;
    const result = parseColorSerialization(context.fillStyle);
    return vec4.fromValues(result[0] / 255, result[1] / 255, result[2] / 255, result[3]);
  } catch (parseError) {
    throw new Error(`Failed to parse color specification: ${parseError.message}`);
  }
}

export function parseRGBColorSpecification(x: any) {
  const result = parseRGBAColorSpecification(x);
  return <vec3>result.subarray(0, 3);
}

/**
 * Returns an integer formed by concatenating the channels of the input color vector.
 * Each channel is clamped to the range [0.0, 1.0] before being converted to 8 bits.
 * An RGB color is packed into 24 bits, and a RGBA into 32 bits.
 */
export function packColor(x: vec3|vec4): number {
  const size = (x[3] === undefined) ? 3 : 4;
  let result = 0;
  for (let i = 0; i < size; i++) {
    // The ">>> 0" ensures an unsigned value.
    result =
        ((result << 8) >>> 0) + Math.min(255, Math.max(0, (Math.round(x[size - 1 - i] * 255))));
  }
  return result;
}

export function unpackRGB(value: number) {
  return vec3.fromValues(
      ((value >>> 0) & 0xff) / 255, ((value >>> 8) & 0xff) / 255, ((value >>> 16) & 0xff) / 255);
}

export function unpackRGBA(value: number) {
  return vec4.fromValues(
      ((value >>> 0) & 0xff) / 255, ((value >>> 8) & 0xff) / 255, ((value >>> 16) & 0xff) / 255,
      ((value >>> 24) & 0xff) / 255);
}

export function serializeColor(x: vec3|vec4) {
  if (x[3] === undefined || x[3] === 1) {
    let result = '#';
    for (let i = 0; i < 3; ++i) {
      result += hexEncodeByte(Math.min(255, Math.max(0, Math.round(x[i] * 255))));
    }
    return result;
  } else {
    let result = 'rgba(';
    for (let i = 0; i < 3; ++i) {
      if (i !== 0) {
        result += ', ';
      }
      result += Math.min(255, Math.max(0, Math.round(x[i] * 255)));
    }
    result += `, ${float32ToString(x[3])})`;
    return result;
  }
}

// Converts an sRGB color component to the gamma-expanded ("linear") value.
export function srgbGammaExpand(value: number) {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// Computes the relative luminance according to Web Content Accessibility Guidelines (WCAG) 2.0
//
// https://www.w3.org/TR/WCAG20/#relativeluminancedef
//
// @param color sRGB color
export function getRelativeLuminance(color: vec3|vec4) {
  const [r, g, b] = color;
  return 0.2126 * srgbGammaExpand(r) + 0.7152 * srgbGammaExpand(g) + 0.0722 * srgbGammaExpand(b);
}

// Determines whether a white background would provide higher contrast than a black background for
// the given foreground color.
//
// This is determined according to the Web Content Accessibility Guidelines (WCAG) 2.0:
// https://www.w3.org/TR/WCAG20/#contrast-ratiodef
//
// https://stackoverflow.com/a/3943023
export function useWhiteBackground(foregroundColor: vec3|vec4) {
  return getRelativeLuminance(foregroundColor) <= 0.179;
}

export class TrackableRGB extends WatchableValue<vec3> {
  constructor(public defaultValue: vec3) {
    super(vec3.clone(defaultValue));
  }
  toString() {
    return serializeColor(this.value);
  }
  toJSON() {
    if (vec3.equals(this.value, this.defaultValue)) {
      return undefined;
    } else {
      return serializeColor(this.value);
    }
  }
  reset() {
    this.value = vec3.clone(this.defaultValue);
  }
  restoreState(x: any) {
    if (x === undefined) {
      this.reset();
      return;
    }
    const {value} = this;
    const newValue = parseRGBColorSpecification(x);
    if (!vec3.equals(value, newValue)) {
      this.value = newValue;
    }
  }
}

export class TrackableOptionalRGB extends WatchableValue<vec3|undefined> {
  constructor() {
    super(undefined);
  }
  toJSON() {
    const {value} = this;
    if (value === undefined) return undefined;
    return serializeColor(value);
  }
  reset() {
    this.value = undefined;
  }
  restoreState(x: any) {
    if (x === undefined) {
      this.reset();
      return;
    }
    const {value} = this;
    const newValue = parseRGBColorSpecification(x);
    if (value === undefined || !vec3.equals(value, newValue)) {
      this.value = newValue;
    }
  }
}
