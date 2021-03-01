/**
 * @license
 * Copyright 2016 Google Inc.
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

'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Resolve a path to an absolute path, expanding all symbolic links.  This is
 * used to ensure that the same file is not seen under multiple paths by the
 * TypeScript compiler, leading to the same file being compiled more than once,
 * which can result in various errors.
 */
function resolveReal() {
  return fs.realpathSync(path.resolve.apply(undefined, arguments));
}
module.exports = resolveReal;
