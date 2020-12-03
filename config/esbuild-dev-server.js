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

// Live reload development server for static site bundled using esbuild

'use strict';

const chokidar = require('chokidar');
const LiveServer = require('./static-site-live-server');
const path = require('path');

async function tryBuild(builder) {
  try {
    await builder.build();
    return true;
  } catch (e) {
    console.log(`Build failed: ${e}`, e.stack);
    return false;
  }
}

async function main(builder, options) {
  if (!options.skipTypeCheck) {
    builder.typeCheckWatch();
  }
  await tryBuild(builder);

  const {serve = false} = options;

  var liveServer = undefined;
  if (serve) {
    liveServer = new LiveServer();
    liveServer.start({
      host: options.host,
      port: options.port,
      root: builder.outDir,
      file: 'index.html',
    });
  }

  let building = false;
  let needBuild = false;
  const sourceWatcher =
      chokidar.watch(path.resolve(builder.srcDir, '**')).on('change', async function(filePath) {
        if (building) {
          needBuild = true;
          return;
        }
        do {
          needBuild = false;
          try {
            let result = await tryBuild(builder);
            if (serve) {
              if (result) {
                liveServer.reload();
              } else {
                console.log('Not reloading due to errors');
              }
            }
          } catch (e) {
            console.log(`Error building: ${e.message}`);
          }
        } while (needBuild);
        building = false;
      });
}
module.exports = main;
