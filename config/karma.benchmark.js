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

let webpack_helpers = require('./webpack_helpers');
const webpack = require('webpack');
const minimist = require('minimist');

module.exports = function(config) {
  let webpackConfig = webpack_helpers.getBaseConfig({useBabel: false, noOutput: true});
  webpackConfig.mode = 'development';

  const argv = minimist(process.argv);
  let pattern = argv['pattern'] || '';
  let patternSuffix = '\\.benchmark\\.ts$';
  let newRegExp = new RegExp(pattern + patternSuffix);

  webpackConfig.plugins = [
    new webpack.ContextReplacementPlugin(
        /.*/,
        result => {
          if (result.regExp.source === patternSuffix) {
            result.regExp = newRegExp;
          }
        }),
  ];

  config.set({
    files: [
      '../src/benchmark.js',
    ],
    frameworks: ['benchmark'],
    preprocessors: {
      '../src/benchmark.js': ['webpack'],
    },

    webpack: webpackConfig,
    webpackServer: {noInfo: true},
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
  });
};
