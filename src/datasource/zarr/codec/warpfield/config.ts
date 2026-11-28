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
 * @file Parsing and validation of the `warpfield` codec configuration. Decoding
 * itself is done by the reference Rust implementation compiled to WebAssembly
 * (`wasm.ts`).
 */

export type AxisRole = "spatial" | "smooth" | "independent" | "component";
export type Predictor = "linear" | "cubic" | "eno";
export type Boundary = "clamped" | "extrapolate";

export interface WarpfieldConfiguration {
  // The configuration as JSON, as handed to the decoder.
  json: string;
  axisRoles: AxisRole[];
  errorBound: number;
  faceErrorBound: number | undefined;
  predictor: Predictor;
  boundary: Boundary;
  // Only the tight error bound matters for decoding.
  tightErrorBound: number | undefined;
  hasJacobian: boolean;
}

function fail(message: string): never {
  throw new Error(`warpfield: ${message}`);
}

function expectNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${key} must be a finite number`);
  }
  return value;
}

/** Parses and validates the codec `configuration` object. */
export function parseWarpfieldConfiguration(
  obj: unknown,
): WarpfieldConfiguration {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    fail("configuration must be an object");
  }
  const o = obj as Record<string, unknown>;
  const known = new Set([
    "axis_roles",
    "error_bound",
    "face_error_bound",
    "predictor",
    "boundary",
    "jacobian",
  ]);
  for (const key of Object.keys(o)) {
    if (!known.has(key))
      fail(`unknown configuration key ${JSON.stringify(key)}`);
  }
  const roles = o.axis_roles;
  if (!Array.isArray(roles)) fail("axis_roles must be a list");
  const axisRoles = roles.map((r) => {
    if (
      r !== "spatial" &&
      r !== "smooth" &&
      r !== "independent" &&
      r !== "component"
    ) {
      fail(`unknown axis role ${JSON.stringify(r)}`);
    }
    return r as AxisRole;
  });
  const errorBound =
    o.error_bound === undefined
      ? 0.25
      : expectNumber(o.error_bound, "error_bound");
  const faceErrorBound =
    o.face_error_bound == null
      ? undefined
      : expectNumber(o.face_error_bound, "face_error_bound");
  const predictor = (o.predictor ?? "eno") as Predictor;
  if (predictor !== "linear" && predictor !== "cubic" && predictor !== "eno") {
    fail(
      `predictor must be linear, cubic or eno, not ${JSON.stringify(predictor)}`,
    );
  }
  const boundary = (o.boundary ?? "clamped") as Boundary;
  if (boundary !== "clamped" && boundary !== "extrapolate") {
    fail(
      `boundary must be clamped or extrapolate, not ${JSON.stringify(boundary)}`,
    );
  }
  let tightErrorBound: number | undefined;
  const jacobian = o.jacobian;
  const hasJacobian = jacobian != null;
  if (hasJacobian) {
    if (typeof jacobian !== "object" || Array.isArray(jacobian)) {
      fail("jacobian must be an object");
    }
    const j = jacobian as Record<string, unknown>;
    if (!Array.isArray(j.grid_spacing))
      fail("jacobian.grid_spacing is required");
    if (j.tight_error_bound != null) {
      tightErrorBound = expectNumber(j.tight_error_bound, "tight_error_bound");
    }
  }
  const config: WarpfieldConfiguration = {
    json: JSON.stringify(o),
    axisRoles,
    errorBound,
    faceErrorBound,
    predictor,
    boundary,
    tightErrorBound,
    hasJacobian,
  };
  validate(config);
  return config;
}

function validate(config: WarpfieldConfiguration) {
  const { axisRoles, errorBound, faceErrorBound, tightErrorBound } = config;
  if (axisRoles.filter((r) => r === "component").length > 1) {
    fail("at most one axis may have role 'component'");
  }
  if (!axisRoles.some((r) => r === "spatial" || r === "smooth")) {
    fail("at least one axis must be 'spatial' or 'smooth'");
  }
  if (!(errorBound > 0)) fail("error_bound must be a positive finite number");
  if (
    faceErrorBound !== undefined &&
    !(faceErrorBound > 0 && faceErrorBound <= errorBound)
  ) {
    fail("face_error_bound must be in (0, error_bound]");
  }
  if (
    tightErrorBound !== undefined &&
    !(tightErrorBound > 0 && tightErrorBound <= errorBound)
  ) {
    fail("tight_error_bound must be in (0, error_bound]");
  }
}
