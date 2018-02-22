/**
 * @license
 * Copyright 2016 Google Inc.
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
 * Converts an HSV color (with h, s, v in [0,1]) to RGB (in range [0,1]).
 *
 * Based on goog/color/color.js in the Google Closure library.
 */
export function hsvToRgb(out: Float32Array, h: number, s: number, v: number): Float32Array {
  h *= 6;
  let hueIndex = Math.floor(h);
  let remainder = h - hueIndex;
  let val1 = v * (1 - s);
  let val2 = v * (1 - (s * remainder));
  let val3 = v * (1 - (s * (1 - remainder)));
  switch (hueIndex % 6) {
    case 0:
      out[0] = v;
      out[1] = val3;
      out[2] = val1;
      break;
    case 1:
      out[0] = val2;
      out[1] = v;
      out[2] = val1;
      break;
    case 2:
      out[0] = val1;
      out[1] = v;
      out[2] = val3;
      break;
    case 3:
      out[0] = val1;
      out[1] = val2;
      out[2] = v;
      break;
    case 4:
      out[0] = val3;
      out[1] = val1;
      out[2] = v;
      break;
    case 5:
      out[0] = v;
      out[1] = val1;
      out[2] = val2;
      break;
  }
  return out;
}


/**
 * Converts from RGB values (with r,g,b in range [0,1]) to an array of HSV values (in range [0, 1])
 *
 * Based on goog/color/color.js in the Google Closure library.
 */
export function rgbToHsv(out: Float32Array, r: number, g: number, b: number): Float32Array {
  const max = Math.max(Math.max(r, g), b);
  const min = Math.min(Math.min(r, g), b);
  out[2] = max;
  if (min === max) {
    out[0] = 0;
    out[1] = 0;
  } else {
    const delta = (max - min);
    out[1] = delta / max;

    if (r === max) {
      out[0] = (g - b) / delta;
    } else if (g === max) {
      out[0] = 2 + ((b - r) / delta);
    } else {
      out[0] = 4 + ((r - g) / delta);
    }
    out[0] /= 6.0;
    if (out[0] < 0.0) {
      out[0] += 1.0;
    }
    if (out[0] > 1.0) {
      out[0] -= 1.0;
    }
  }
  return out;
}

/**
 * Convert hex sixtet or shorthand triplet to RGB (in range [0,1]).
 * Returns null if conversion fails
 *
 * Based on https://stackoverflow.com/questions/5623838/rgb-to-hex-and-hex-to-rgb
 */
export function hexToRgb(out: Float32Array, hex: string): Float32Array|null {
  // Expand shorthand form (e.g. "03F") to full form (e.g. "0033FF")
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  hex = hex.replace(shorthandRegex, function(_, r, g, b) {
    return r + r + g + g + b + b;
  });

  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    out[0] = parseInt(result[1], 16) / 255.0;
    out[1] = parseInt(result[2], 16) / 255.0;
    out[2] = parseInt(result[3], 16) / 255.0;
    return out;
  }
  return null;
}

/**
 * Convert RGB (in range [0,1]) to 7 letter string (e.g. '#0033FF').
 * Returns null if conversion fails
 */
export function rgbToHex(rgb: ArrayLike<number>): string|null {
  if (rgb.length < 3) {
    return null;
  }

  const r = Math.max(0, Math.min(Math.round(rgb[0] * 255), 255));
  const g = Math.max(0, Math.min(Math.round(rgb[1] * 255), 255));
  const b = Math.max(0, Math.min(Math.round(rgb[2] * 255), 255));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
