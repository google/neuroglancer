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

import type { Snapshot } from "#src/kvstore/icechunk/snapshot.js";
import {
  normalizeListResponse,
  type ListResponse,
} from "#src/kvstore/index.js";
import { binarySearch, binarySearchLowerBound } from "#src/util/array.js";
import { defaultStringCompare } from "#src/util/string.js";

export function getListResponseFromSnapshot(
  snapshot: Snapshot,
  prefix: string,
): ListResponse {
  const { nodes } = snapshot;
  const startIndex = binarySearchLowerBound(
    0,
    nodes.length,
    (index) => nodes[index].path >= prefix,
  );
  const endIndex = binarySearchLowerBound(
    Math.min(nodes.length, startIndex + 1),
    nodes.length,
    (index) => !nodes[index].path.startsWith(prefix),
  );
  const response: ListResponse = { entries: [], directories: [] };
  for (let index = startIndex; index < endIndex; ) {
    const node = nodes[index];
    const { path } = node;
    const i = path.indexOf("/", prefix.length);
    if (i === -1) {
      // Node must exactly match prefix.
      ++index;
    } else {
      if (i + 1 === path.length) {
        // Direct child node, include in results.
        response.directories.push(path.slice(0, i));
      }
      // Skip over non-direct descedant nodes.
      const directoryPrefix = path.substring(0, i + 1);
      index = binarySearchLowerBound(
        index + 1,
        endIndex,
        (index) => !nodes[index].path.startsWith(directoryPrefix),
      );
    }
  }

  // Also add `zarr.json` file if it would match.
  const lastSlash = prefix.lastIndexOf("/");
  if ("zarr.json".startsWith(prefix.slice(lastSlash + 1))) {
    const parentPath = prefix.substring(0, lastSlash + 1);
    const parentNodeIndex = binarySearch(nodes, parentPath, (path, node) =>
      defaultStringCompare(path, node.path),
    );
    if (parentNodeIndex >= 0) {
      response.entries.push({ key: parentPath + "zarr.json" });
    } else {
      throw new Error(`Parent node ${JSON.stringify(parentPath)} not found`);
    }
  }
  return normalizeListResponse(response);
}
