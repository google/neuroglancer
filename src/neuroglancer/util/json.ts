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

import {WritableArrayLike} from 'neuroglancer/util/array';
import {vec3} from 'neuroglancer/util/geom';

export function verifyFloat(obj: any): number {
  let t = typeof obj;
  if (t === 'number' || t === 'string') {
    let x = parseFloat('' + obj);
    if (!Number.isNaN(x)) {
      return x;
    }
  }
  throw new Error(`Expected floating-point number, but received: ${JSON.stringify(obj)}.`);
}

export function verifyFiniteFloat(obj: any): number {
  let x = verifyFloat(obj);
  if (Number.isFinite(x)) {
    return x;
  }
  throw new Error(`Expected finite floating-point number, but received: ${x}.`);
}

export function verifyFinitePositiveFloat(obj: any): number {
  let x = verifyFiniteFloat(obj);
  if (x > 0) {
    return x;
  }
  throw new Error(`Expected positive finite floating-point number, but received: ${x}.`);
}

export function parseXYZ<A extends WritableArrayLike<number>>(
    out: A, obj: any, validator: (x: any) => number = verifyFloat): A {
  verifyObject(obj);
  out[0] = out[1] = out[2] = 0;
  for (const key of Object.keys(obj)) {
    switch (key) {
    case 'x':
      out[0] = validator(obj[key]);
      break;
    case 'y':
      out[1] = validator(obj[key]);
      break;
    case 'z':
      out[2] = validator(obj[key]);
      break;
    default:
      throw new Error(
          `Expected object to have keys ['x', 'y', 'z'], but received: ${JSON.stringify(obj)}.`);
    }
  }
  return out;
}

export function parseFiniteVec<U extends WritableArrayLike<number>>(out: U, obj: any[]) {
  let length = out.length;
  if (!Array.isArray(obj) || obj.length !== length) {
    throw new Error('Incompatible sizes');
  }

  for (let i = 0; i < length; ++i) {
    if (!Number.isFinite(parseFloat(obj[i]))) {
      throw new Error('Non-finite value.');
    }
  }
  for (let i = 0; i < length; ++i) {
    out[i] = parseFloat(obj[i]);
  }
  return out;
}

export function parseIntVec<U extends WritableArrayLike<number>>(out: U, obj: any) {
  let length = out.length;
  if (!Array.isArray(obj) || obj.length !== length) {
    throw new Error('Incompatible sizes.');
  }

  for (let i = 0; i < length; ++i) {
    let val = parseInt(obj[i], undefined);
    if (!Number.isInteger(val)) {
      throw new Error('Non-integer value.');
    }
  }

  for (let i = 0; i < length; ++i) {
    out[i] = parseInt(obj[i], undefined);
  }
  return out;
}

/**
 * Returns a JSON representation of x, with object keys sorted to ensure a
 * consistent result.
 */
export function stableStringify(x: any) {
  if (typeof x === 'object') {
    if (x === null) {
      return 'null';
    }
    if (Array.isArray(x)) {
      let s = '[';
      let size = x.length;
      let i = 0;
      if (i < size) {
        s += stableStringify(x[i]);
        while (++i < size) {
          s += ',';
          s += stableStringify(x[i]);
        }
      }
      s += ']';
      return s;
    }
    let s = '{';
    let keys = Object.keys(x).sort();
    let i = 0;
    let size = keys.length;
    if (i < size) {
      let key = keys[i];
      s += JSON.stringify(key);
      s += ':';
      s += stableStringify(x[key]);
      while (++i < size) {
        s += ',';
        key = keys[i];
        s += JSON.stringify(key);
        s += ':';
        s += stableStringify(x[key]);
      }
    }
    s += '}';
    return s;
  }
  return JSON.stringify(x);
}

function swapQuotes(x: string) {
  return x.replace(/['"]/g, s => {
    return (s === '"' ? '\'' : '"');
  });
}

export function urlSafeStringifyString(x: string) {
  return swapQuotes(JSON.stringify(swapQuotes(x)));
}

const URL_SAFE_COMMA = '_';

export function urlSafeStringify(x: any): string {
  if (typeof x === 'object') {
    if (x === null) {
      return 'null';
    }
    let toJSON = x['toJSON'];
    if (typeof toJSON === 'function') {
      return urlSafeStringify(toJSON.call(x));
    }
    if (Array.isArray(x)) {
      let s = '[';
      let size = x.length;
      let i = 0;
      if (i < size) {
        s += urlSafeStringify(x[i]);
        while (++i < size) {
          s += URL_SAFE_COMMA;
          s += urlSafeStringify(x[i]);
        }
      }
      s += ']';
      return s;
    }
    let s = '{';
    let keys = Object.keys(x);
    let first = true;
    for (let key of keys) {
      let value = x[key];
      if (value === undefined) {
        continue;
      }
      let valueString = urlSafeStringify(value);
      if (!valueString) {
        continue;
      }
      if (!first) {
        s += URL_SAFE_COMMA;
      } else {
        first = false;
      }
      s += urlSafeStringifyString(key);
      s += ':';
      s += valueString;
    }
    s += '}';
    return s;
  }
  if (typeof x === 'string') {
    return urlSafeStringifyString(x);
  }
  return JSON.stringify(x);
}

const SINGLE_QUOTE_STRING_PATTERN = /('(?:[^'\\]|(?:\\.))*')/;
const DOUBLE_QUOTE_STRING_PATTERN = /("(?:[^'\\]|(?:\\.))*")/;
const SINGLE_OR_DOUBLE_QUOTE_STRING_PATTERN =
    new RegExp(`${SINGLE_QUOTE_STRING_PATTERN.source}|${DOUBLE_QUOTE_STRING_PATTERN.source}`);
const DOUBLE_OR_SINGLE_QUOTE_STRING_PATTERN =
    new RegExp(`${DOUBLE_QUOTE_STRING_PATTERN.source}|${SINGLE_QUOTE_STRING_PATTERN.source}`);

const DOUBLE_QUOTE_PATTERN = /^((?:[^"'\\]|(?:\\[^']))*)("|\\')/;
const SINGLE_QUOTE_PATTERN = /^((?:[^"'\\]|(?:\\.))*)'/;

function convertStringLiteral(
  x: string, quoteInitial: string, quoteReplace: string, quoteSearch: RegExp) {
  if (x.length >= 2 && x.charAt(0) === quoteInitial && x.charAt(x.length - 1) === quoteInitial) {
    let inner = x.substr(1, x.length - 2);
    let s = quoteReplace;
    while (inner.length > 0) {
      let m = inner.match(quoteSearch);
      if (m === null) {
        s += inner;
        break;
      }
      s += m[1];
      if (m[2] === quoteReplace) {
        // We received a single unescaped quoteReplace character.
        s += '\\';
        s += quoteReplace;
      } else {
        // We received "\\" + quoteInitial.  We need to remove the escaping.
        s += quoteInitial;
      }
      inner = inner.substr(m.index! + m[0].length);
    }
    s += quoteReplace;
    return s;
  }
  return x;
}

/**
 * Converts a string literal delimited by either single or double quotes into a string literal
 * delimited by double quotes.
 */
export function normalizeStringLiteral(x: string) {
  return convertStringLiteral(x, '\'', '"', DOUBLE_QUOTE_PATTERN);
}



// quoteChar: des
function convertJsonHelper(x: string, desiredCommaChar: string, desiredQuoteChar: string) {
  const commaSearch = /[&_,]/g;
  let quoteInitial: string;
  let quoteSearch: RegExp;
  let stringLiteralPattern: RegExp;
  if (desiredQuoteChar === '"') {
    quoteInitial = '\'';
    quoteSearch = DOUBLE_QUOTE_PATTERN;
    stringLiteralPattern = SINGLE_OR_DOUBLE_QUOTE_STRING_PATTERN;
  } else {
    quoteInitial = '"';
    quoteSearch = SINGLE_QUOTE_PATTERN;
    stringLiteralPattern = DOUBLE_OR_SINGLE_QUOTE_STRING_PATTERN;
  }
  let s = '';
  while (x.length > 0) {
    let m = x.match(stringLiteralPattern);
    let before: string;
    let replacement: string;
    if (m === null) {
      before = x;
      x = '';
      replacement = '';
    } else {
      before = x.substr(0, m.index);
      x = x.substr(m.index! + m[0].length);
      let originalString = m[1];
      if (originalString !== undefined) {
        replacement =
            convertStringLiteral(originalString, quoteInitial, desiredQuoteChar, quoteSearch);
      } else {
        replacement = m[2];
      }
    }
    s += before.replace(commaSearch, desiredCommaChar);
    s += replacement;
  }
  return s;
}

export function urlSafeToJSON(x: string) {
  return convertJsonHelper(x, ',', '"');
}

export function jsonToUrlSafe(x: string) {
  return convertJsonHelper(x, '_', '\'');
}

export function urlSafeParse(x: string) {
  return JSON.parse(urlSafeToJSON(x));
}

// Converts a string containing a Python literal into a string containing an equivalent JSON
// literal.
export function pythonLiteralToJSON(x: string) {
  let s = '';
  while (x.length > 0) {
    let m = x.match(SINGLE_OR_DOUBLE_QUOTE_STRING_PATTERN);
    let before: string;
    let replacement: string;
    if (m === null) {
      before = x;
      x = '';
      replacement = '';
    } else {
      before = x.substr(0, m.index);
      x = x.substr(m.index! + m[0].length);
      let singleQuoteString = m[1];
      if (singleQuoteString !== undefined) {
        replacement = normalizeStringLiteral(singleQuoteString);
      } else {
        replacement = m[2];
      }
    }
    s += before.replace(/\(/g, '[')
             .replace(/\)/g, ']')
             .replace('True', 'true')
             .replace('False', 'false')
             .replace(/,\s*([\}\]])/g, '$1');
    s += replacement;
  }
  return s;
}

// Converts a string containing a Python literal into an equivalent JavaScript value.
export function pythonLiteralParse(x: string) {
  return JSON.parse(pythonLiteralToJSON(x));
}

// Checks that `x' is an array, maps each element by parseElement.
export function parseArray<T>(x: any, parseElement: (x: any, index: number) => T): T[] {
  if (!Array.isArray(x)) {
    throw new Error(`Expected array, but received: ${JSON.stringify(x)}.`);
  }
  return (<any[]>x).map(parseElement);
}

export function parseFixedLengthArray<T, U extends WritableArrayLike<T>>(
    out: U, obj: any, parseElement: (x: any, index: number) => T): U {
  const length = out.length;
  if (!Array.isArray(obj) || obj.length !== length) {
    throw new Error(`Expected length ${length} array, but received: ${JSON.stringify(obj)}.`);
  }
  for (let i = 0; i < length; ++i) {
    out[i] = parseElement(obj[i], i);
  }
  return out;
}

export function verifyObject(obj: any) {
  if (typeof obj !== 'object' || obj == null || Array.isArray(obj)) {
    throw new Error(`Expected JSON object, but received: ${JSON.stringify(obj)}.`);
  }
  return obj;
}

export function verifyInt(obj: any) {
  let result = parseInt(obj, 10);
  if (!Number.isInteger(result)) {
    throw new Error(`Expected integer, but received: ${JSON.stringify(obj)}.`);
  }
  return result;
}

export function verifyPositiveInt(obj: any) {
  const result = verifyInt(obj);
  if (result <= 0) {
    throw new Error(`Expected positive integer, but received: ${result}.`);
  }
  return result;
}

export function verifyNonnegativeInt(obj: any) {
  const result = verifyInt(obj);
  if (result < 0) {
    throw new Error(`Expected non-negative integer, but received: ${result}.`);
  }
  return result;
}

export function verifyMapKey<U>(obj: any, map: Map<string, U>) {
  let result = map.get(obj);
  if (result === undefined) {
    throw new Error(
        `Expected one of ${JSON.stringify(Array.from(map.keys()))}, ` +
        `but received: ${JSON.stringify(obj)}.`);
  }
  return result;
}

export function verifyString(obj: any) {
  if (typeof obj !== 'string') {
    throw new Error(`Expected string, but received: ${JSON.stringify(obj)}.`);
  }
  return obj;
}

export function verifyOptionalString(obj: any): string|undefined {
  if (obj === undefined) {
    return undefined;
  }
  return verifyString(obj);
}

export function verifyOptionalInt(obj: any): number|undefined {
  if (obj === undefined) {
    return undefined;
  }
  return verifyInt(obj);
}

export function verifyOptionalNonnegativeInt(obj: any): number|undefined {
  if (obj === undefined) {
    return undefined;
  }
  return verifyNonnegativeInt(obj);
}

export function verifyOptionalPositiveInt(obj: any): number|undefined {
  if (obj === undefined) {
    return undefined;
  }
  return verifyPositiveInt(obj);
}

export function verifyOptionalBoolean(obj: any): boolean|undefined {
  if (obj === undefined) {
    return undefined;
  }
  if (typeof obj === 'boolean') {
    return obj;
  } else if (obj === 'true') {
    return true;
  } else if (obj === 'false') {
    return false;
  } else {
    throw new Error(`Expected string or boolean but received: ${JSON.stringify(obj)}`);
  }
}

export function valueOr<T>(value: T|undefined, defaultValue: T) {
  return value === undefined ? defaultValue : value;
}

export function verifyObjectProperty<T>(
    obj: any, propertyName: string, validator: (value: any) => T): T {
  let value = obj.hasOwnProperty(propertyName) ? obj[propertyName] : undefined;
  try {
    return validator(value);
  } catch (parseError) {
    throw new Error(
        `Error parsing ${JSON.stringify(propertyName)} property: ${parseError.message}`);
  }
}

export function verifyObjectAsMap<T>(obj: any, validator: (value: any) => T): Map<string, T> {
  verifyObject(obj);
  let map = new Map<string, T>();
  for (let key of Object.keys(obj)) {
    try {
      map.set(key, validator(obj[key]));
    } catch (parseError) {
      throw new Error(
          `Error parsing value associated with key ${JSON.stringify(key)}: ${parseError.message}`);
    }
  }
  return map;
}

export function verifyFloat01(obj: any): number {
  if (typeof obj !== 'number' || !Number.isFinite(obj) || obj < 0 || obj > 1) {
    throw new Error(
        `Expected floating point number in [0,1], but received: ${JSON.stringify(obj)}.`);
  }
  return obj;
}

/**
 * The query string parameters may either be specified in the usual
 * 'name=value&otherName=otherValue' form or as (optionally urlSafe) JSON: '{"name":"value"}`.
 */
export function parseQueryStringParameters(queryString: string) {
  if (queryString === '') {
    return {};
  }
  if (queryString.startsWith('{')) {
    return urlSafeParse(queryString);
  } else {
    let result: any = {};
    let parts = queryString.split(/[&;]/);
    for (let part of parts) {
      let m = part.match(/^([^=&;]+)=([^&;]*)$/);
      if (m === null) {
        throw new Error(`Invalid query string part: ${JSON.stringify(part)}.`);
      }
      result[m[1]] = decodeURIComponent(m[2]);
    }
    return result;
  }
}

/**
 * Verifies that `obj' is a string that, when converted to uppercase, matches a string property of
 * `enumType`.
 *
 * Note: TypeScript does not seem to allow better typing of the return type.
 *
 * @returns The corresponding numerical value.
 */
export function verifyEnumString(obj: any, enumType: {[x: string]: any}): number {
  if (typeof obj === 'string' && obj.match(/^[a-zA-Z]/) !== null) {
    obj = obj.toUpperCase();
    if (enumType.hasOwnProperty(obj)) {
      return enumType[obj];
    }
  }
  throw new Error(`Invalid enum value: ${JSON.stringify(obj)}.`);
}

export function verify3dVec(obj: any) {
  return parseFixedLengthArray(vec3.create(), obj, verifyFiniteFloat);
}

export function verify3dScale(obj: any) {
  return parseFixedLengthArray(vec3.create(), obj, verifyFinitePositiveFloat);
}

export function verify3dDimensions(obj: any) {
  return parseFixedLengthArray(vec3.create(), obj, verifyPositiveInt);
}

export function verifyStringArray(a: any) {
  if (!Array.isArray(a)) {
    throw new Error(`Expected array, received: ${JSON.stringify(a)}.`);
  }
  for (let x of a) {
    if (typeof x !== 'string') {
      throw new Error(`Expected string, received: ${JSON.stringify(x)}.`);
    }
  }
  return <string[]>a;
}

export function verifyBoolean(x: any) {
  if (typeof x !== 'boolean') {
    throw new Error(`Expected boolean, received: ${JSON.stringify(x)}`);
  }
  return x;
}
