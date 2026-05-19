/**
 * @license
 * Copyright 2026 Ichnaea
 * Licensed under the Apache License, Version 2.0.
 */

import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import {
  parseArray,
  verifyFiniteNonNegativeFloat,
  verifyObject,
  verifyObjectProperty,
} from "#src/util/json.js";

const DEFAULT_LOWER = [0, 0, 0] as const;
const DEFAULT_UPPER = [1, 1, 1] as const;

function clampFraction(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function vecEqual(a: Float32Array, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 3; ++i) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Per-axis clip range on a volume layer, in display-space [0, 1] fractions
 * of the source's full clip-display extent. Consumed by
 * {@link VolumeRenderingRenderLayer} to intersect ray-march bounds.
 *
 * Stored as two `Float32Array(3)`s (display X/Y/Z) so the volume rendering
 * shader's `uLowerClipBound`/`uUpperClipBound` uniforms can be derived
 * without per-frame allocation.
 */
export class TrackableVolumeClipBounds implements Trackable {
  readonly lower = new Float32Array(DEFAULT_LOWER);
  readonly upper = new Float32Array(DEFAULT_UPPER);
  changed = new NullarySignal();

  /** True when no clipping is applied (full extent). Hot-path fast exit. */
  get isIdentity(): boolean {
    return (
      vecEqual(this.lower, DEFAULT_LOWER) && vecEqual(this.upper, DEFAULT_UPPER)
    );
  }

  setRange(lower: ArrayLike<number>, upper: ArrayLike<number>): void {
    let changed = false;
    for (let i = 0; i < 3; ++i) {
      const lo = clampFraction(lower[i]);
      const hi = Math.max(lo, clampFraction(upper[i]));
      if (this.lower[i] !== lo) {
        this.lower[i] = lo;
        changed = true;
      }
      if (this.upper[i] !== hi) {
        this.upper[i] = hi;
        changed = true;
      }
    }
    if (changed) this.changed.dispatch();
  }

  reset(): void {
    this.setRange(DEFAULT_LOWER, DEFAULT_UPPER);
  }

  toJSON(): unknown {
    if (this.isIdentity) return undefined;
    return {
      lower: Array.from(this.lower),
      upper: Array.from(this.upper),
    };
  }

  restoreState(x: unknown): void {
    if (x === undefined || x === null) {
      this.reset();
      return;
    }
    verifyObject(x);
    const parse = (k: string, fallback: readonly number[]) =>
      verifyObjectProperty(x, k, (v) => {
        if (v === undefined) return [...fallback];
        return parseArray(v, verifyFiniteNonNegativeFloat);
      });
    const lower = parse("lower", DEFAULT_LOWER);
    const upper = parse("upper", DEFAULT_UPPER);
    this.setRange(lower, upper);
  }
}
