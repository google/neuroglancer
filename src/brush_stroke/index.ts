/**
 * @license
 * Copyright 2024 Google Inc.
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

import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import { NullarySignal } from "#src/util/signal.js";

/**
 * Sparse 3D overlay of segmentation-label voxels keyed by spatial (x, y, z).
 *
 * The CPU-side hash and the GPU fragment shader in `renderlayer.ts` both
 * compute the same key from the same xyz triple — keep them in sync if
 * the multipliers below ever change.
 */
export class BrushHashTable extends HashMapUint64 {
  changed = new NullarySignal();

  public coordinates = new Map<bigint, [number, number, number]>();
  private getBrushKey(x: number, y: number, z: number): bigint {
    const x1 = x >>> 0;
    const y1 = y >>> 0;
    const z1 = z >>> 0;

    const h1 = ((x1 * 73 * 1271) ^ (y1 * 513 * 1345) ^ (z1 * 421 * 675)) >>> 0;
    const h2 = ((x1 * 127 * 337) ^ (y1 * 111 * 887) ^ (z1 * 269 * 325)) >>> 0;

    return BigInt(h1) + (BigInt(h2) << 32n);
  }

  addBrushPoint(x: number, y: number, z: number, value: number) {
    const key = this.getBrushKey(x, y, z);
    this.delete(key);
    const brushValue = BigInt(value);
    this.set(key, brushValue);

    this.coordinates.set(key, [x, y, z]);
    this.changed.dispatch();
  }

  deleteBrushPoint(x: number, y: number, z: number) {
    const key = this.getBrushKey(x, y, z);
    this.delete(key);

    this.coordinates.delete(key);
    this.changed.dispatch();
  }

  getBrushValue(x: number, y: number, z: number): number | undefined {
    const key = this.getBrushKey(x, y, z);
    const value = this.get(key);
    if (value !== undefined) {
      return Number(value);
    }
    return undefined;
  }

  hasBrushPoint(x: number, y: number, z: number): boolean {
    const key = this.getBrushKey(x, y, z);
    return this.has(key);
  }

  clear() {
    this.coordinates.clear();
    const cleared = super.clear();
    this.changed.dispatch();
    return cleared;
  }
}
