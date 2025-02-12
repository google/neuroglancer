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

import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";

export function decodeRef(obj: unknown): string {
  verifyObject(obj);
  if (Object.keys(obj as object).length !== 1) {
    throw new Error(
      `Expected object with only a "snapshot" property, but received: ${JSON.stringify(obj)}`,
    );
  }
  const id = verifyObjectProperty(obj, "snapshot", verifyString);
  if (!isSnapshotId(id)) {
    throw new Error(
      `Expected icechunk snapshot id but received: ${JSON.stringify(id)}`,
    );
  }
  return id;
}

export function isSnapshotId(id: string) {
  return id.match(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{20}$/) !== null;
}

// Checks if a given basename is a valid branch ref file.
export function isBranchRef(name: string): boolean {
  // This is not strictly precise because this allows for any 100-bit value,
  // while icechunk only allows for 96-bits.
  return name.match(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}\.json$/) !== null;
}
