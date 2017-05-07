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

let webpackHelpers = require('./webpack_helpers');
const path = require('path');
const webpack = require('webpack');
const minimist = require('minimist');

module.exports = function(config) {

  const argv = minimist(process.argv);
  let pattern = argv['pattern'] || '';
  let patternSuffix = '\\.spec\\.ts$';
  let newRegExp = new RegExp(pattern + patternSuffix);

  let webpackConfig = webpackHelpers.getBaseConfig({
    useBabel: true,
    babelPlugins: [...webpackHelpers.DEFAULT_BABEL_PLUGINS, 'babel-plugin-istanbul'],
    noOutput: true
  });
  webpackConfig.devtool = 'inline-source-map';
  webpackConfig.plugins = [
    new webpack.DefinePlugin({
      'WORKER': false,
    }),
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
      '../src/spec.js',
    ],
    frameworks: ['jasmine'],
    preprocessors: {
      '../src/spec.js': ['webpack', 'sourcemap'],
    },

    webpack: webpackConfig,
    webpackServer: {noInfo: true},
    browserStack: {
      // This empty object is required to work around a bug in karma-browserstack-launcher.
    },
    browsers: [
      'Chrome',
      // 'ChromeCanary',
    ],
    customLaunchers: {
      browserstack_chrome55_osx_sierra: {
        base: 'BrowserStack',
        browser: 'chrome',
        browser_version: '55.0',
        os: 'OS X',
        os_version: 'Sierra',
      },
      browserstack_chrome57_windows_10: {
        base: 'BrowserStack',
        browser: 'chrome',
        browser_version: '57.0',
        os: 'Windows',
        os_version: '10',
      }
    },
    colors: true,
    browserNoActivityTimeout: 60000,
    reporters: ['mocha', 'coverage'],
    coverageReporter: {
      dir: path.resolve(__dirname, '../coverage/'),
      reporters: [
        {type: 'text-summary'}, {type: 'json'},
        // HTML reporter not compatible with babel-plugin-istanbul 3.0.0
        // {type: 'html'},
      ]
    },
    // logLevel: config.LOG_DEBUG,
    // singleRun: true,
  });
};
