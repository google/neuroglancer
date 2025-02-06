/**
 * @license
 * Copyright 2025 Google Inc.
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

import type { KvStoreWithPath } from "#src/kvstore/index.js";
import type { VersionSpecifier } from "#src/kvstore/ocdbt/version_specifier.js";
import {
  formatVersion,
  parseVersion,
} from "#src/kvstore/ocdbt/version_specifier.js";
import type { UrlWithParsedScheme } from "#src/kvstore/url.js";
import {
  encodePathForUrl,
  ensureNoQueryOrFragmentParameters,
  ensurePathIsDirectory,
} from "#src/kvstore/url.js";

export function getOcdbtUrl(
  options: { baseUrl: string; version: VersionSpecifier | undefined },
  key: string,
): string {
  const { version, baseUrl } = options;
  const versionString =
    version === undefined ? "" : `@${formatVersion(version)}/`;
  return baseUrl + `|ocdbt:${versionString}${encodePathForUrl(key)}`;
}

export function parseOcdbtUrl(
  parsedUrl: UrlWithParsedScheme,
  base: KvStoreWithPath,
) {
  ensureNoQueryOrFragmentParameters(parsedUrl);
  try {
    const m = (parsedUrl.suffix ?? "").match(/^(?:@([^/]*)(?:\/|$))?(.*)$/)!;
    const [, versionString, path] = m;
    return {
      baseUrl: base.store.getUrl(ensurePathIsDirectory(base.path)),
      version: parseVersion(versionString),
      path: decodeURIComponent(path),
    };
  } catch (e) {
    throw new Error(`Invalid URL: ${parsedUrl.url}`, { cause: e });
  }
}
