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

/**
 * @file Monkey patches ts-loader to allow configFileName to be treated as an absolute path rather
 * than just a file name.
 */

/**
 * The below code is derived from dist/config.js in ts-loader@1.3.3, which is subject to the
 * following copyright license:
 *
 * Copyright (c) 2015 TypeStrong
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const tsLoaderConfigModule = require('ts-loader/dist/config.js');
const tsLoaderUtilsModule = require('ts-loader/dist/utils.js');

tsLoaderConfigModule.getConfigFile = function getConfigFile(compiler, loader, loaderOptions, compilerCompatible, log, compilerDetailsLogMessage) {
  let configFilePath = loaderOptions.configFileName;
  var configFileError;
  log.logInfo(("ts-loader: Using config file at " + configFilePath).green);
  let configFile = compiler.readConfigFile(configFilePath, compiler.sys.readFile);
  if (configFile.error) {
    configFileError = tsLoaderUtilsModule.formatErrors([configFile.error], loaderOptions, compiler, { file: configFilePath })[0];
  }
  if (!configFileError) {
    configFile.config.compilerOptions = Object.assign({}, configFile.config.compilerOptions, loaderOptions.compilerOptions);
    // do any necessary config massaging
    if (loaderOptions.transpileOnly) {
      configFile.config.compilerOptions.isolatedModules = true;
    }
  }
  return {
    configFilePath: configFilePath,
    configFile: configFile,
    configFileError: configFileError
  };
};
