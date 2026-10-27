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

/**
 * @file Reads and writes the known attributes of a skeleton node: radius,
 * confidence and true end.
 */

import type {
  SkeletonNode,
  SkeletonNodeAttributes,
} from "#src/skeleton/api.js";
import { KnownSkeletonNodeAttribute } from "#src/skeleton/api.js";

export function getSkeletonNodeRadius(node: SkeletonNode): number | undefined {
  return node.attributes?.[KnownSkeletonNodeAttribute.RADIUS]?.[0];
}

export function getSkeletonNodeConfidence(
  node: SkeletonNode,
): number | undefined {
  return node.attributes?.[KnownSkeletonNodeAttribute.CONFIDENCE_PERCENT]?.[0];
}

export function isSkeletonNodeTrueEnd(node: SkeletonNode): boolean {
  const value = node.attributes?.[KnownSkeletonNodeAttribute.IS_TRUE_END]?.[0];
  return value !== undefined && value !== 0;
}

// An undefined value or a false true end removes the attribute.
export function setSkeletonNodeAttributes(
  attributes: SkeletonNodeAttributes | undefined,
  changes: {
    readonly radius?: number;
    readonly confidence?: number;
    readonly isTrueEnd?: boolean;
  },
): SkeletonNodeAttributes | undefined {
  const result: Record<string, ArrayLike<number>> = { ...attributes };
  const setScalar = (
    id: KnownSkeletonNodeAttribute,
    value: number | undefined,
  ) => {
    if (value === undefined) {
      delete result[id];
    } else {
      result[id] = Object.freeze([value]);
    }
  };
  if (Object.hasOwn(changes, "radius")) {
    setScalar(KnownSkeletonNodeAttribute.RADIUS, changes.radius);
  }
  if (Object.hasOwn(changes, "confidence")) {
    setScalar(
      KnownSkeletonNodeAttribute.CONFIDENCE_PERCENT,
      changes.confidence,
    );
  }
  if (Object.hasOwn(changes, "isTrueEnd")) {
    setScalar(
      KnownSkeletonNodeAttribute.IS_TRUE_END,
      changes.isTrueEnd ? 1 : undefined,
    );
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}
