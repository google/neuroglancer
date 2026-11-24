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
 * @file Which dimensions a displacement field warps, and how they meet the
 * dimensions of the moving (image) source. Pure: names, units and sizes in,
 * roles out, so every rule can be tested without loading anything.
 *
 * The field has one vector dimension with K components. Each of its other
 * dimensions is
 *  - displaced: one component displaces it (there are exactly K of these);
 *  - indexed: the field varies along it, with no component (e.g. t of a
 *    time-varying 3-d warp);
 *  - dropped: size 1 and not displaced, so the field is constant along it.
 * The moving source's output dimensions are matched by name (never by
 * position): a field dimension it has is warped (displaced) or indexed; a
 * displaced dimension it lacks is gained by the warped output (the image is
 * constant along it); a moving dimension the field lacks passes through.
 */

export interface WarpFieldDimension {
  name: string;
  // Neuroglancer base unit: "m", "s", "" (none), ...
  unit: string;
  // Number of samples along the dimension.
  size: number;
  // The OME "displacement" axis.
  isDisplacementAxis?: boolean;
}

export interface WarpMovingDimension {
  name: string;
  unit: string;
}

export interface WarpDimensionHints {
  // Name of the field's vector dimension.
  vectorDimension?: string;
  // Names of the field dimensions the components displace, in component
  // order (given by the warp spec).
  vectorDimensions?: string[];
  // The same, from the field's own metadata (lower precedence).
  metadataVectorDimensions?: string[];
  // Component order when nothing above gives one: the displaced dimensions
  // are ordered as in this list of names (e.g. NIfTI's x, y, z, or an OME
  // coordinate system's axes), then in the field's dimension order.
  componentOrder?: string[];
}

export type WarpFieldDimensionRole = "displaced" | "indexed";

export interface WarpResolvedFieldDimension {
  // Index into the field dimensions.
  fieldDim: number;
  role: WarpFieldDimensionRole;
  // Index into the moving dimensions, or -1 if the moving source does not
  // have it (a displaced dimension the warped output gains).
  movingDim: number;
}

export interface WarpPassthroughDimension {
  movingDim: number;
  // Channel dimensions ("^") are carried whole in every warped chunk; others
  // (time, a z the field does not have, ...) are chunked at 1.
  whole: boolean;
}

export interface WarpDimensionResolution {
  vectorDim: number;
  numComponents: number;
  // Field dimension displaced by each component.
  componentDims: number[];
  // The field dimensions the warp is computed over, in field order.
  fieldDims: WarpResolvedFieldDimension[];
  // Field dimensions of size 1 that are dropped (the field is constant).
  droppedDims: number[];
  // Moving dimensions not in the field, in moving order.
  passthrough: WarpPassthroughDimension[];
  // Informational notes (e.g. dimensions the output gains).
  messages: string[];
}

function unitKind(unit: string) {
  return unit === "" ? "dimensionless" : unit;
}

function describe(names: string[]) {
  return JSON.stringify(names);
}

/**
 * Channel ("^") and local ("'", e.g. an OME channel axis) dimensions: vector
 * dimension candidates, and carried whole when passed through.
 */
export function isChannelDimensionName(name: string) {
  return name.endsWith("^") || name.endsWith("'");
}

/**
 * Resolves the roles of the field and moving dimensions. Throws an Error
 * naming the dimensions on both sides if they cannot be matched.
 */
export function resolveWarpDimensions(
  field: WarpFieldDimension[],
  moving: WarpMovingDimension[],
  hints: WarpDimensionHints = {},
): WarpDimensionResolution {
  const fieldNames = field.map((d) => d.name);
  const movingNames = moving.map((d) => d.name);
  const both = () =>
    `field dimensions ${describe(fieldNames)}, source dimensions ` +
    `${describe(movingNames)}`;
  const fail = (message: string): never => {
    throw new Error(`warp: ${message} (${both()})`);
  };
  const fieldIndex = (name: string, what: string) => {
    const i = fieldNames.indexOf(name);
    if (i === -1)
      fail(`${what} ${JSON.stringify(name)} is not a field dimension`);
    return i;
  };

  // Vector dimension.
  let vectorDim: number;
  const displacementAxes = field
    .map((d, i) => (d.isDisplacementAxis ? i : -1))
    .filter((i) => i !== -1);
  if (displacementAxes.length > 1) {
    fail("the field has several displacement axes");
  }
  if (displacementAxes.length === 1) {
    vectorDim = displacementAxes[0];
  } else if (hints.vectorDimension !== undefined) {
    vectorDim = fieldIndex(hints.vectorDimension, "vectorDimension");
  } else {
    const channels = field
      .map((d, i) => (isChannelDimensionName(d.name) ? i : -1))
      .filter((i) => i !== -1);
    if (channels.length === 0) {
      fail(
        "the field has no vector dimension (no displacement axis or channel " +
          'dimension "^"); give "vectorDimension"',
      );
    }
    if (channels.length > 1) {
      fail(
        `several candidate vector dimensions ${describe(
          channels.map((i) => fieldNames[i]),
        )}; give "vectorDimension"`,
      );
    }
    vectorDim = channels[0];
  }
  const numComponents = field[vectorDim].size;
  if (numComponents < 1) fail("the vector dimension is empty");

  // Size-1 field dimensions the moving source does not have are constant.
  const droppedDims: number[] = [];
  let candidates: number[] = [];
  field.forEach((d, i) => {
    if (i === vectorDim) return;
    if (d.size === 1 && !movingNames.includes(d.name)) droppedDims.push(i);
    else candidates.push(i);
  });

  // Displaced dimensions, in component order.
  let componentDims: number[] | undefined;
  const explicit = hints.vectorDimensions ?? hints.metadataVectorDimensions;
  if (explicit !== undefined) {
    componentDims = explicit.map((name) => {
      const i = fieldIndex(name, "displaced dimension");
      if (i === vectorDim)
        fail(`${JSON.stringify(name)} is the vector dimension`);
      return i;
    });
    if (new Set(componentDims).size !== componentDims.length) {
      fail(`repeated displaced dimension in ${describe(explicit)}`);
    }
    if (componentDims.length !== numComponents) {
      fail(
        `${numComponents} components but ${componentDims.length} displaced ` +
          `dimensions ${describe(explicit)}`,
      );
    }
    // A dimension named as displaced is kept even if it has size 1.
    for (const i of componentDims) {
      const j = droppedDims.indexOf(i);
      if (j !== -1) {
        droppedDims.splice(j, 1);
        candidates.push(i);
      }
    }
    candidates = candidates.sort((a, b) => a - b);
  } else {
    let displaced: number[] | undefined;
    const nonSingleton = candidates.filter((i) => field[i].size > 1);
    if (candidates.length === numComponents) {
      displaced = candidates;
    } else if (nonSingleton.length === numComponents) {
      displaced = nonSingleton;
    } else {
      const byKind = new Map<string, number[]>();
      for (const i of candidates) {
        const k = unitKind(field[i].unit);
        byKind.set(k, [...(byKind.get(k) ?? []), i]);
      }
      const matching = [...byKind.values()].filter(
        (dims) => dims.length === numComponents,
      );
      if (matching.length === 1) displaced = matching[0];
    }
    if (displaced === undefined) {
      fail(
        `ambiguous: ${numComponents} components for the field dimensions ` +
          `${describe(candidates.map((i) => fieldNames[i]))}; say which ` +
          'dimensions the components displace ("vectorDimensions")',
      );
    }
    // Components follow componentOrder where it names the dimension, then
    // the field's dimension order.
    const order = hints.componentOrder ?? [];
    const rank = (i: number) => {
      const r = order.indexOf(fieldNames[i]);
      return r === -1 ? order.length + i : r;
    };
    componentDims = displaced!.slice().sort((a, b) => rank(a) - rank(b));
  }

  // Roles, and matching by name.
  const messages: string[] = [];
  const fieldDims: WarpResolvedFieldDimension[] = [];
  for (const i of candidates) {
    const d = field[i];
    const movingDim = movingNames.indexOf(d.name);
    const displaced = componentDims.includes(i);
    // A size-1 dimension that is not displaced is dropped below, whatever
    // its unit.
    const kept = displaced || d.size !== 1;
    if (
      kept &&
      movingDim !== -1 &&
      unitKind(moving[movingDim].unit) !== unitKind(d.unit)
    ) {
      fail(
        `dimension ${JSON.stringify(d.name)} has unit ${JSON.stringify(
          d.unit,
        )} in the field but ${JSON.stringify(moving[movingDim].unit)} in the source`,
      );
    }
    if (displaced) {
      if (movingDim === -1) {
        messages.push(
          `warp: the source has no dimension ${JSON.stringify(d.name)}; it is ` +
            "treated as constant along it, and the warped output gains it",
        );
      }
      fieldDims.push({ fieldDim: i, role: "displaced", movingDim });
      continue;
    }
    if (d.size === 1) {
      droppedDims.push(i);
      continue;
    }
    if (movingDim === -1) {
      fail(
        `the field varies along ${JSON.stringify(d.name)} but the source has ` +
          "no such dimension; rename or drop it with the warp's transform",
      );
    }
    fieldDims.push({ fieldDim: i, role: "indexed", movingDim });
  }
  droppedDims.sort((a, b) => a - b);
  if (!fieldDims.some((d) => d.role === "displaced" && d.movingDim !== -1)) {
    fail(
      "no displaced field dimension matches a source dimension by name; " +
        "rename them with the warp's transform",
    );
  }
  const matched = new Set(fieldDims.map((d) => d.movingDim));
  const passthrough: WarpPassthroughDimension[] = [];
  moving.forEach((d, i) => {
    if (matched.has(i)) return;
    passthrough.push({ movingDim: i, whole: isChannelDimensionName(d.name) });
  });
  return {
    vectorDim,
    numComponents,
    componentDims,
    fieldDims,
    droppedDims,
    passthrough,
    messages,
  };
}
