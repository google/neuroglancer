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
const path = require('path');
const webpack = require('webpack');

module.exports = function(config) {

  let webpackConfig = webpack_helpers.getBaseConfig({useBabel: false, noOutput: true});
  webpackConfig.devtool = 'inline-source-map';
  webpackConfig.module.postLoaders = [{
    test: /\.ts$/,
    exclude: [/\.spec\.ts$/, /node_modules/],
    loader: 'istanbul-instrumenter-loader',
  }];
  webpackConfig.plugins = [
    new webpack.DefinePlugin({
      'WORKER': false,
    }),
  ];

  config.set({
    files: [
      '../src/spec.js',
    ],
    frameworks: ['jasmine'],
    preprocessors: {
      '../src/spec.js': ['coverage', 'webpack', 'sourcemap'],
    },

    webpack: webpackConfig,
    webpackServer: {noInfo: true},
    browsers: [
      'Chrome',
      // 'ChromeCanary',
    ],
    colors: true,
    browserNoActivityTimeout: 60000,
    reporters: ['mocha', 'coverage'],
    coverageReporter: {
      dir: path.resolve(__dirname, '../coverage/'),
      reporters: [{type: 'text-summary'}, {type: 'json'}, {type: 'html'}]
    },
    // logLevel: config.LOG_DEBUG,
    // singleRun: true,
  });
};
