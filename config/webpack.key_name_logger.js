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

const HtmlWebpackPlugin = require('html-webpack-plugin');
const path = require('path');
const webpack_helpers = require('./webpack_helpers');

let baseConfig =
    webpack_helpers.getBaseConfig({outputPath: path.resolve(__dirname, '../dist/key_name_logger')});
module.exports = Object.assign(
    {
      entry: {'key_name_logger': path.resolve(__dirname, '../src/key_name_logger')},
      plugins: [
        new HtmlWebpackPlugin({
          title: 'Key Name Logger',
          filename: 'key_name_logger.html',
        }),
      ],
    },
    baseConfig);
