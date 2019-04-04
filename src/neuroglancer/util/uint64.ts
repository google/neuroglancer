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

const randomTempBuffer = new Uint32Array(2);

const trueBase = 0x100000000;

// For dealing with the string representation in base b, we will represent the 64-bit number as
//
//   highPrime * intermediateBase[b] + lowPrime,
//
// where:
//
//   intermediateBaseForBase[b] = Math.pow(b, lowDigitsforBase[b]),
//
// and
//
//   lowDigitsForBase[b] = Math.floor(Math.log(Math.pow(2,53 - 32)) / Math.log(b)).

interface StringConversionData {
  lowDigits: number;

  lowBase: number;

  pattern: RegExp;
}

let stringConversionData: StringConversionData[] = [];
for (let base = 2; base <= 36; ++base) {
  let lowDigits = Math.floor(32 / Math.log2(base));
  let lowBase = Math.pow(base, lowDigits);
  let patternString = `^[0-${String.fromCharCode('0'.charCodeAt(0) + Math.min(9, base - 1))}`;
  if (base > 10) {
    patternString += `a-${String.fromCharCode('a'.charCodeAt(0) + base - 11)}`;
    patternString += `A-${String.fromCharCode('A'.charCodeAt(0) + base - 11)}`;
  }
  let maxDigits = Math.ceil(64 / Math.log2(base));
  patternString += `]{1,${maxDigits}}$`;
  let pattern = new RegExp(patternString);
  stringConversionData[base] = {lowDigits, lowBase, pattern};
}

/**
 * Returns the high 32 bits of the result of the 32-bit integer multiply `a` and `b`.
 *
 * The low 32-bits can be obtained using the built-in `Math.imul` function.
 */
function uint32MultiplyHigh(a: number, b: number) {
  a >>>= 0;
  b >>>= 0;

  const a00 = a & 0xFFFF, a16 = a >>> 16;
  const b00 = b & 0xFFFF, b16 = b >>> 16;

  let c00 = a00 * b00;
  let c16 = (c00 >>> 16) + (a16 * b00);
  let c32 = c16 >>> 16;
  c16 = (c16 & 0xFFFF) + (a00 * b16);
  c32 += c16 >>> 16;
  let c48 = c32 >>> 16;
  c32 = (c32 & 0xFFFF) + (a16 * b16);
  c48 += c32 >>> 16;

  return (((c48 & 0xFFFF) << 16) | (c32 & 0xFFFF)) >>> 0;
}

export class Uint64 {
  constructor(public low: number = 0, public high: number = 0) {}

  clone() {
    return new Uint64(this.low, this.high);
  }

  assign(x: Uint64) {
    this.low = x.low;
    this.high = x.high;
  }

  toString(base = 10): string {
    let vLow = this.low, vHigh = this.high;
    if (vHigh === 0) {
      return vLow.toString(base);
    }
    vHigh *= trueBase;
    let {lowBase, lowDigits} = stringConversionData[base];
    let vHighExtra = vHigh % lowBase;
    vHigh = Math.floor(vHigh / lowBase);
    vLow += vHighExtra;
    vHigh += Math.floor(vLow / lowBase);
    vLow = vLow % lowBase;
    let vLowStr = vLow.toString(base);
    return vHigh.toString(base) + '0'.repeat(lowDigits - vLowStr.length) + vLowStr;
  }

  /**
   * Returns true if a is strictly less than b.
   */
  static less(a: Uint64, b: Uint64): boolean {
    return a.high < b.high || (a.high === b.high && a.low < b.low);
  }

  /**
   * Returns a negative number if a is strictly less than b, 0 if a is equal to b, or a positive
   * number if a is strictly greater than b.
   */
  static compare(a: Uint64, b: Uint64): number {
    return (a.high - b.high) || (a.low - b.low);
  }

  static ZERO = new Uint64(0, 0);

  static equal(a: Uint64, b: Uint64) {
    return a.low === b.low && a.high === b.high;
  }

  static min(a: Uint64, b: Uint64): Uint64 {
    return Uint64.less(a, b) ? a : b;
  }

  static random() {
    crypto.getRandomValues(randomTempBuffer);
    return new Uint64(randomTempBuffer[0], randomTempBuffer[1]);
  }

  tryParseString(s: string, base = 10) {
    const {lowDigits, lowBase, pattern} = stringConversionData[base];
    if (!pattern.test(s)) {
      return false;
    }
    if (s.length <= lowDigits) {
      this.low = parseInt(s, base);
      this.high = 0;
      return true;
    }
    const splitPoint = s.length - lowDigits;
    const lowPrime = parseInt(s.substr(splitPoint), base);
    const highPrime = parseInt(s.substr(0, splitPoint), base);

    let high: number, low: number;

    if (lowBase === trueBase) {
      high = highPrime;
      low = lowPrime;
    } else {
      const highRemainder = Math.imul(highPrime, lowBase) >>> 0;
      high = uint32MultiplyHigh(highPrime, lowBase) +
          (Math.imul(Math.floor(highPrime / trueBase), lowBase) >>> 0);
      low = lowPrime + highRemainder;
      if (low >= trueBase) {
        ++high;
        low -= trueBase;
      }
    }
    if ((low >>> 0) !== low || ((high >>> 0) !== high)) {
      return false;
    }
    this.low = low;
    this.high = high;
    return true;
  }

  parseString(s: string, base = 10) {
    if (!this.tryParseString(s, base)) {
      throw new Error(`Failed to parse string as uint64 value: ${JSON.stringify(s)}.`);
    }
    return this;
  }

  static parseString(s: string, base = 10) {
    let x = new Uint64();
    return x.parseString(s, base);
  }

  valid() {
    let {low, high} = this;
    return ((low >>> 0) === low) && ((high >>> 0) === high);
  }

  toJSON() {
    return this.toString();
  }

  lshift(bits: number) {
    bits &= 63;
    if (bits == 0) {
      return this.clone();
    } else {
      let {low, high} = this;
      if (bits < 32) {
        return new Uint64(low << bits, (high << bits) | (low >>> (32 - bits)));
      } else {
        return new Uint64(0, low << (bits - 32));
      }
    }
  }

  rshift(bits: number) {
    bits &= 63;
    if (bits == 0) {
      return this.clone();
    } else {
      let {low, high} = this;
      if (bits < 32) {
        return new Uint64((low >>> bits) | (high << (32 - bits)), high >> bits);
      } else {
        return new Uint64(high >> (bits - 32), high >= 0 ? 0 : -1);
      }
    }
  }

  or(other: Uint64) {
    return new Uint64(this.low | other.low, this.high | other.high);
  }

  xor(other: Uint64) {
    return new Uint64(this.low ^ other.low, this.high ^ other.high);
  }

  and(other: Uint64) {
    return new Uint64(this.low & other.low, this.high & other.high);
  }
}
