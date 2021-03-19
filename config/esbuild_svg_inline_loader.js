/**
 * @license
 * Copyright 2020 Google LLC
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

// esbuild equivalent of webpack's svg-inline-loader

const fs = require('fs');

module.exports = function(options) {
  const getExtractedSVG = require('svg-inline-loader').getExtractedSVG;
  return {
    name: 'svg-inline-loader',
    setup(build) {
      build.onLoad({filter: /.*\.svg$/, namespace: 'file'}, async (args) => {
        const text = await fs.promises.readFile(args.path, 'utf8');
        const converted = getExtractedSVG(text, options);
        return {
          contents: `export default ${JSON.stringify(converted)};`,
        };
      });
    },
  };
};
