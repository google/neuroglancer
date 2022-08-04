/**
 * @license
 * Copyright 2019 Google Inc.
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

import {binarySearchLowerBound} from 'neuroglancer/util/array';

export interface SiPrefix {
  readonly prefix: string;
  readonly exponent: number;
  readonly longPrefix?: string;
}

export const preferredSiPrefixes: readonly SiPrefix[] = [
  {prefix: 'Y', exponent: 24, longPrefix: 'yotta'},
  {prefix: 'Z', exponent: 21, longPrefix: 'zetta'},
  {prefix: 'E', exponent: 18, longPrefix: 'exa'},
  {prefix: 'P', exponent: 15, longPrefix: 'peta'},
  {prefix: 'T', exponent: 12, longPrefix: 'tera'},
  {prefix: 'G', exponent: 9, longPrefix: 'giga'},
  {prefix: 'M', exponent: 6, longPrefix: 'mega'},
  {prefix: 'k', exponent: 3, longPrefix: 'kilo'},
  {prefix: '', exponent: 0, longPrefix: ''},
  {prefix: 'm', exponent: -3, longPrefix: 'milli'},
  {prefix: 'µ', exponent: -6, longPrefix: 'micro'},
  {prefix: 'n', exponent: -9, longPrefix: 'nano'},
  {prefix: 'p', exponent: -12, longPrefix: 'pico'},
  {prefix: 'f', exponent: -15, longPrefix: 'femto'},
  {prefix: 'a', exponent: -18, longPrefix: 'atto'},
  {prefix: 'z', exponent: -21, longPrefix: 'zepto'},
  {prefix: 'y', exponent: -24, longPrefix: 'yocto'},
];

export const allSiPrefixes: readonly SiPrefix[] = [
  ...preferredSiPrefixes,
  {prefix: 'h', exponent: 2, longPrefix: 'hecto'},
  {prefix: 'da', exponent: 1, longPrefix: 'deca'},
  {prefix: 'd', exponent: -1, longPrefix: 'deci'},
  {prefix: 'c', exponent: -2, longPrefix: 'centi'},
];

const siPrefixesWithAlternatives: readonly SiPrefix[] = [
  {prefix: 'u', exponent: -6},  // Also allow "u" for micro
  ...allSiPrefixes,
];

export const supportedUnits = new Map<string, {unit: string, exponent: number}>();
supportedUnits.set('', {unit: '', exponent: 0});
export const exponentToPrefix = new Map<number, string>();
for (const {prefix, exponent} of siPrefixesWithAlternatives) {
  exponentToPrefix.set(exponent, prefix);
  for (const unit of ['m', 's', 'Hz', 'rad/s']) {
    supportedUnits.set(`${prefix}${unit}`, {unit, exponent});
  }
}

export function pickSiPrefix(x: number): SiPrefix {
  const exponent = Math.log10(x);
  const numPrefixes = preferredSiPrefixes.length;
  const i =
      binarySearchLowerBound(0, numPrefixes, i => preferredSiPrefixes[i].exponent <= exponent);
  return preferredSiPrefixes[Math.min(i, numPrefixes - 1)];
}

interface FormatScaleWithUnitOptions {
  precision?: number;
  elide1?: boolean;
}

export function formatScaleWithUnit(
    scale: number, unit: string,
    options: FormatScaleWithUnitOptions = {}): {scale: string, prefix: string, unit: string} {
  const {precision = 6, elide1 = true} = options;
  let adjustedScale = scale;
  let prefix = '';
  if (unit !== '') {
    const result = pickSiPrefix(scale);
    prefix = result.prefix;
    adjustedScale = scaleByExp10(scale, -result.exponent);
  }
  if (elide1 && adjustedScale === 1) {
    return {scale: '', unit, prefix};
  }
  let scaleString: string;
  if (precision != 0) {
    if (adjustedScale < 1 || adjustedScale >= 1000) {
      scaleString = adjustedScale.toPrecision(precision);
    } else {
      scaleString = adjustedScale.toFixed(precision);
    }
    const eIndex = scaleString.indexOf('e');
    let numString: string;
    let exponentString: string;
    if (eIndex !== -1) {
      numString = scaleString.substring(0, eIndex);
      exponentString = scaleString.substring(eIndex);
    } else {
      numString = scaleString;
      exponentString = '';
    }
    const m = numString.match(/.*\.(?:[0-9]*[1-9])?(0+)$/);
    if (m !== null) {
      numString = numString.substring(0, numString.length - m[1].length);
      if (numString.endsWith('.')) {
        numString = numString.substring(0, numString.length - 1);
      }
      scaleString = numString + exponentString;
    }
  } else {
    scaleString = adjustedScale.toString();
  }
  return {
    scale: scaleString,
    unit,
    prefix,
  };
}

export function formatScaleWithUnitAsString(
    scale: number, unit: string, options?: FormatScaleWithUnitOptions): string {
  const {scale: formattedScale, unit: formattedUnit, prefix} =
      formatScaleWithUnit(scale, unit, options);
  return `${formattedScale}${prefix}${formattedUnit}`;
}

export function parseScale(s: string) {
  if (s === '') {
    return {scale: 1, unit: ''};
  }
  const match = s.match(/^((?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)?([µa-zA-Z]+)?$/);
  if (match === null) return undefined;
  const scaleString = match[1];
  let scale = (scaleString === undefined) ? 1 : Number(scaleString);
  if (Number.isNaN(scale)) return undefined;
  let unit = '';
  if (match[2] !== undefined) {
    const result = supportedUnits.get(match[2]);
    if (result === undefined) {
      return undefined;
    }
    unit = result.unit;
    if (result.exponent > 0) {
      scale *= 10 ** result.exponent;
    } else {
      scale /= 10 ** (-result.exponent);
    }
  }
  if (scale <= 0 || !Number.isFinite(scale)) return undefined;
  return {scale, unit};
}

export function unitFromJson(x: unknown) {
  const result = supportedUnits.get(x as string);
  if (result === undefined) {
    throw new Error(`Invalid unit: ${JSON.stringify(x)}`);
  }
  return result;
}

/**
 * Returns `scale * 10**exponent`, but uses division for negative exponents to reduce loss of
 * precision.
 */
export function scaleByExp10(scale: number, exponent: number) {
  if (exponent >= 0) return scale * (10 ** exponent);
  return scale / (10 ** (-exponent));
}
