/**
 * @license
 * Copyright 2016-2020 Google LLC
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
const {getEntryPointConfig, getEsbuildConfig} = require('./karma-entry-points');

module.exports = function(config) {
  config.set({
    ...getEntryPointConfig(path.resolve(__dirname, '..', 'src', '**', '*.benchmark.ts')),
    esbuild: getEsbuildConfig(),
    frameworks: ['benchmark'],
    browsers: [
      'ChromeHeadless',
      // 'Chrome',
      // 'ChromeCanary',
    ],
    colors: true,
    browserNoActivityTimeout: 60000,
    reporters: ['benchmark'],
    // logLevel: config.LOG_DEBUG,
    singleRun: true,
    plugins: [
      'karma-benchmark',
      'karma-benchmark-reporter',
      'karma-chrome-launcher',
      'karma-firefox-launcher',
      require('./karma-esbuild'),
    ],
  });
};
