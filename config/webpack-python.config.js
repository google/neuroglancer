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
const webpack_helpers = require('./webpack_helpers');
const resolveReal = require('./resolve_real');

module.exports = env => {
  let outputSuffix = 'dev';
  let srcDir = resolveReal(__dirname, '../src');
  let options = {
    dataSources: [
      ...webpack_helpers.DEFAULT_DATA_SOURCES,
      'neuroglancer/datasource/python',
    ],
    frontendModules: [resolveReal(srcDir, 'main_python.ts')],
    registerCredentials: false,
  };
  if (env === 'min') {
    outputSuffix = 'min';
    options.minify = true;
  }
  options.outputPath = path.resolve(__dirname, '../dist/python-' + outputSuffix);
  return webpack_helpers.getViewerConfig(options);
};
