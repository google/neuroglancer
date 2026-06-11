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

export interface ResolvedPanelPickSample {
  offset: number;
  relativeX: number;
  relativeY: number;
  pickValue: number;
  depthValue?: number;
}

export function getPickDiameter(pickRadius: number): number {
  return 1 + pickRadius * 2;
}

let _cachedPickRadius = -1;
let _cachedPickOffsetSequence: Uint32Array | undefined;

/**
 * Sequence of offsets into C order (pickDiamater, pickDiamater) array in order of increasing
 * distance from center.
 */
export function getPickOffsetSequence(pickRadius: number) {
  if (pickRadius === _cachedPickRadius) {
    return _cachedPickOffsetSequence!;
  }
  _cachedPickRadius = pickRadius;
  const pickDiameter = getPickDiameter(pickRadius);
  const maxDist2 = pickRadius ** 2;
  const getDist2 = (x: number, y: number) =>
    (x - pickRadius) ** 2 + (y - pickRadius) ** 2;

  let offsets = new Uint32Array(pickDiameter * pickDiameter);
  let count = 0;
  for (let x = 0; x < pickDiameter; ++x) {
    for (let y = 0; y < pickDiameter; ++y) {
      if (getDist2(x, y) > maxDist2) continue;
      offsets[count++] = y * pickDiameter + x;
    }
  }
  offsets = offsets.subarray(0, count);
  offsets.sort((a, b) => {
    const x1 = a % pickDiameter;
    const y1 = (a - x1) / pickDiameter;
    const x2 = b % pickDiameter;
    const y2 = (b - x2) / pickDiameter;
    return getDist2(x1, y1) - getDist2(x2, y2);
  });
  return (_cachedPickOffsetSequence = offsets);
}

/**
 * Sets array elements to 0 that would be outside the viewport.
 *
 * @param buffer Array view, which contains a C order (pickDiameter, pickDiameter) array.
 * @param baseOffset Offset into `buffer` corresponding to (0, 0).
 * @param stride Stride between consecutive elements of the array.
 * @param glWindowX Center x pixel index.
 * @param glWindowY Center y pixel index.
 * @param viewportWidth Width of viewport in pixels.
 * @param viewportHeight Width of viewport in pixels.
 */
export function clearOutOfBoundsPickData(
  buffer: Float32Array,
  baseOffset: number,
  stride: number,
  glWindowX: number,
  glWindowY: number,
  viewportWidth: number,
  viewportHeight: number,
  pickRadius: number,
) {
  const pickDiameter = getPickDiameter(pickRadius);
  const startX = glWindowX - pickRadius;
  const startY = glWindowY - pickRadius;
  if (
    startX >= 0 &&
    startY >= 0 &&
    startX + pickDiameter <= viewportWidth &&
    startY + pickDiameter <= viewportHeight
  ) {
    return;
  }
  for (let relativeY = 0; relativeY < pickDiameter; ++relativeY) {
    for (let relativeX = 0; relativeX < pickDiameter; ++relativeX) {
      const x = startX + relativeX;
      const y = startY + relativeY;
      if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) {
        buffer[baseOffset + (relativeY * pickDiameter + relativeX) * stride] =
          0;
      }
    }
  }
}

export function getCenteredPickWindowCoordinate(
  glWindowCoordinate: number,
  relativeCoordinate: number,
  pickRadius: number,
) {
  return glWindowCoordinate + relativeCoordinate - pickRadius + 0.5;
}

export function resolveNearestPanelPickSample(
  data: ArrayLike<number>,
  pickOffsetSequence: ArrayLike<number>,
  pickRadius: number,
  options: {
    depthBaseOffset?: number;
    pickBaseOffset?: number;
    stride?: number;
  } = {},
): ResolvedPanelPickSample | undefined {
  const {
    depthBaseOffset,
    pickBaseOffset = depthBaseOffset ?? 0,
    stride = 4,
  } = options;
  const pickDiameter = getPickDiameter(pickRadius);
  for (let i = 0; i < pickOffsetSequence.length; ++i) {
    const offset = pickOffsetSequence[i];
    const depthValue =
      depthBaseOffset === undefined
        ? undefined
        : (data[depthBaseOffset + stride * offset] ?? 0);
    if (depthBaseOffset !== undefined && depthValue === 0) {
      continue;
    }
    const pickValue = data[pickBaseOffset + stride * offset] ?? 0;
    if (depthBaseOffset === undefined && pickValue === 0) {
      continue;
    }
    const relativeX = offset % pickDiameter;
    return {
      offset,
      relativeX,
      relativeY: (offset - relativeX) / pickDiameter,
      pickValue,
      depthValue,
    };
  }
  return undefined;
}
