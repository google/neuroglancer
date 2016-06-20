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

const typescript = require('typescript');

/**
 * Modifies the config file parse result to exclude from fileNames
 * non-declaration files.
 *
 * This ensures that TypeScript's path walking doesn't result in duplicate files
 * being compiled due to the presence of symlinks and absolute vs. relative path
 * issues.
 */
function postprocessConfigFile(result) {
  let fileNames = result.fileNames;
  fileNames = fileNames.filter(x => x.endsWith('.d.ts'));
  return Object.assign({}, result, {fileNames: fileNames});
}

function parseJsonConfigFileContent() {
  return postprocessConfigFile(typescript.parseJsonConfigFileContent.apply(typescript, arguments));
}
module.exports =
    Object.assign({}, typescript, {parseJsonConfigFileContent: parseJsonConfigFileContent});
