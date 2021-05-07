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

// karma preprocessor that uses esbuild for bundling.
//
// Also watches dependencies for changes.

'use strict';

const path = require('path');
const esbuild = require('esbuild');
const chokidar = require('chokidar');

function createPreprocessor(config, emitter, logger) {
  const log = logger.create('preprocessor.esbuild');

  // Maps each reference file to a Set of entry point files.
  const reverseDependencies = new Map();

  let registerDependencies = undefined;

  if (!config.singleRun && config.autoWatch) {
    const watcher = chokidar.watch();
    watcher.on('change', changedPath => {
      const entryPoints = reverseDependencies.get(changedPath);
      if (entryPoints === undefined) return;
      for (const entryPoint of entryPoints) {
        if (path.sep !== '/') {
          entryPoint = entryPoint.replace(/\\/g, '/');
        }
        emitter._fileList.changeFile(entryPoint, true);
      }
    });
    registerDependencies = (entryPoint, dependencies) => {
      for (const dep of dependencies) {
        let revDeps = reverseDependencies.get(dep);
        if (revDeps === undefined) {
          watcher.add(dep);
          revDeps = new Set();
          reverseDependencies.set(dep, revDeps);
        }
        revDeps.add(entryPoint);
      }
    };
  }

  const esbuildConfig = config.esbuild;

  return async function preprocess(original, file, done) {
    const originalPath = file.originalPath;
    const outFileKey = 'out.js';
    try {
      log.info('Generating bundle for ./%s', originalPath);
      const results = await esbuild.build({
        sourcemap: 'inline',
        ...esbuildConfig,
        entryPoints: [originalPath],
        outfile: outFileKey,
        bundle: true,
        write: false,
        metafile: true,
      });
      const metaEntry = results.metafile;
      const dependencies = Object.keys(metaEntry.inputs);
      if (registerDependencies !== undefined) {
        registerDependencies(originalPath, dependencies);
      }
      const outputEntry = results.outputFiles.find(entry => entry.path.endsWith(outFileKey));
      done(undefined, '\'use strict\';\n' + outputEntry.text);
    } catch (error) {
      log.error('Failed to process ./%s\n\n%s\n', originalPath, error.stack);
      done(error, null);
    }
  };
}

createPreprocessor.$inject = ['config', 'emitter', 'logger'];

module.exports = {
  'preprocessor:esbuild': ['factory', createPreprocessor],
};
