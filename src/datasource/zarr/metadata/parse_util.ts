/**
 * @license
 * Copyright 2023 Google Inc.
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

export function parseNameAndConfiguration<Name, Configuration>(
  obj: unknown,
  parseName: (name: string) => Name,
  parseConfiguration: (configuration: unknown, name: Name) => Configuration,
): { name: Name; configuration: Configuration } {
  verifyObject(obj);
  const name = verifyObjectProperty(obj, "name", (value) =>
    parseName(verifyString(value)),
  );
  const configuration = verifyObjectProperty(obj, "configuration", (value) => {
    if (value === undefined) {
      value = {};
    } else {
      verifyObject(value);
    }
    return parseConfiguration(value, name);
  });
  return { name, configuration };
}
