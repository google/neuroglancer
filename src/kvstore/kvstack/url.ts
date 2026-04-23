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

import type { UrlWithParsedScheme } from "#src/kvstore/url.js";
import { ensureNoQueryOrFragmentParameters } from "#src/kvstore/url.js";

export interface KvStackLayer {
  base: string;
  exact?: string;
  prefix?: string;
}

export interface KvStackSpec {
  layers: KvStackLayer[];
}

// URL form: `kvstack:<percent-encoded-JSON-spec>[/<path>]`.
//
// The JSON is percent-encoded (encodeURIComponent) so it never contains a bare
// `/`; the first `/` in the suffix therefore always delimits the optional
// within-kvstack path.
export function parseKvStackUrl(parsedUrl: UrlWithParsedScheme): {
  spec: KvStackSpec;
  path: string;
} {
  ensureNoQueryOrFragmentParameters(parsedUrl);
  const suffix = parsedUrl.suffix ?? "";
  const slashIdx = suffix.indexOf("/");
  const jsonPart = slashIdx === -1 ? suffix : suffix.substring(0, slashIdx);
  const pathPart = slashIdx === -1 ? "" : suffix.substring(slashIdx + 1);
  let spec: unknown;
  try {
    spec = JSON.parse(decodeURIComponent(jsonPart));
  } catch (e) {
    throw new Error(`Invalid kvstack URL: ${parsedUrl.url}`, { cause: e });
  }
  validateKvStackSpec(spec);
  return { spec, path: decodeURIComponent(pathPart) };
}

export function formatKvStackUrl(spec: KvStackSpec, key: string = ""): string {
  const json = encodeURIComponent(JSON.stringify(spec));
  return key === "" ? `kvstack:${json}` : `kvstack:${json}/${key}`;
}

function validateKvStackSpec(spec: unknown): asserts spec is KvStackSpec {
  if (
    typeof spec !== "object" ||
    spec === null ||
    !Array.isArray((spec as { layers?: unknown }).layers)
  ) {
    throw new Error("kvstack spec must have a 'layers' array");
  }
  for (const layer of (spec as KvStackSpec).layers) {
    if (typeof layer !== "object" || layer === null) {
      throw new Error("kvstack layer must be an object");
    }
    if (typeof layer.base !== "string") {
      throw new Error("kvstack layer must have a 'base' string");
    }
    const hasExact = typeof layer.exact === "string";
    const hasPrefix = typeof layer.prefix === "string";
    if (hasExact && hasPrefix) {
      throw new Error("kvstack layer cannot have both 'exact' and 'prefix'");
    }
  }
}
