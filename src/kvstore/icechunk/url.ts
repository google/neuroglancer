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

import { isSnapshotId } from "#src/kvstore/icechunk/ref.js";
import type { KvStoreWithPath } from "#src/kvstore/index.js";
import type { UrlWithParsedScheme } from "#src/kvstore/url.js";
import {
  encodePathForUrl,
  ensureNoQueryOrFragmentParameters,
  ensurePathIsDirectory,
} from "#src/kvstore/url.js";

export type RefSpec =
  | { snapshot: string }
  | { branch: string }
  | { tag: string };

const BRANCH_PREFIX = "branch.";
const TAG_PREFIX = "tag.";

export function getIcechunkUrl(
  options: { baseUrl: string; refSpec: RefSpec | undefined },
  key: string,
) {
  const { baseUrl, refSpec } = options;
  const versionString =
    refSpec === undefined ? "" : `@${formatRefSpec(refSpec)}/`;
  return baseUrl + `|icechunk:${versionString}${encodePathForUrl(key)}`;
}

export function formatRefSpec(refSpec: RefSpec) {
  if ("branch" in refSpec) {
    return BRANCH_PREFIX + encodePathForUrl(refSpec.branch);
  }
  if ("tag" in refSpec) {
    return TAG_PREFIX + encodePathForUrl(refSpec.tag);
  }
  return refSpec.snapshot;
}

export function isValidBranchName(name: string) {
  return name.length > 0 && !name.includes("/");
}

export function parseRefSpec(
  versionString: string | undefined,
): RefSpec | undefined {
  if (versionString === undefined) return undefined;
  if (versionString.startsWith(BRANCH_PREFIX)) {
    const branch = versionString.substring(BRANCH_PREFIX.length);
    if (!isValidBranchName(branch)) {
      throw new Error(`Invalid branch name: ${JSON.stringify(branch)}`);
    }
    return { branch: decodeURIComponent(branch) };
  }
  if (versionString.startsWith(TAG_PREFIX)) {
    const tag = versionString.substring(TAG_PREFIX.length);
    if (!isValidBranchName(tag)) {
      throw new Error(`Invalid tag name: ${JSON.stringify(tag)}`);
    }
    return { tag: decodeURIComponent(tag) };
  }
  if (isSnapshotId(versionString)) {
    return { snapshot: versionString };
  }
  throw new Error(`Invalid ref spec: ${JSON.stringify(versionString)}`);
}

export function parseIcechunkUrl(
  parsedUrl: UrlWithParsedScheme,
  base: KvStoreWithPath,
) {
  ensureNoQueryOrFragmentParameters(parsedUrl);
  try {
    const m = (parsedUrl.suffix ?? "").match(/^(?:@([^/]*)(?:\/|$))?(.*)$/)!;
    const [, refSpecString, path] = m;
    return {
      baseUrl: base.store.getUrl(ensurePathIsDirectory(base.path)),
      version: parseRefSpec(refSpecString),
      path: decodeURIComponent(path),
    };
  } catch (e) {
    throw new Error(`Invalid URL: ${parsedUrl.url}`, { cause: e });
  }
}
