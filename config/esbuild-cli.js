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

// Command-line interface for building Neuroglancer.

'use strict';

const {Builder} = require('./esbuild');
const path = require('path');
const fs = require('fs');

async function main(argv) {
  let minify = true;
  let python = false;
  let moduleBuild = false;
  let outDir = undefined;
  let id = argv.config;
  const pythonOutDir = path.resolve(__dirname, '..', 'python', 'neuroglancer', 'static');

  switch (id) {
    case 'min':
      break;
    case 'dev':
      minify = false;
      break;
    case 'python-min':
      python = true;
      outDir = pythonOutDir;
      break;
    case 'python-dev':
      python = true;
      minify = false;
      outDir = pythonOutDir;
      break;
    case 'module':
      minify = false;
      moduleBuild = true;
      break;
    default:
      throw new Error(`Unsupported config: ${id}`);
  }
  const skipTypeCheck = !argv.typecheck;
  const defines = {};
  let defineList = argv.define || [];
  if (typeof defineList === 'string') {
    defineList = [defineList];
  }
  for (const entry of defineList) {
    const splitPoint = entry.indexOf('=');
    let key, value;
    if (splitPoint === -1) {
      key = entry;
      value = 'true';
    } else {
      key = entry.substring(0, splitPoint);
      value = entry.substring(splitPoint+1);
    }
    defines[key] = value;
  }
  const builder = new Builder({
    outDir,
    id,
    minify,
    python,
    module: moduleBuild,
    define: defines,
  });
  if (moduleBuild) {
    try {
      if ((await fs.promises.lstat(builder.outDir)).isDirectory()) {
        await fs.promises.rmdir(builder.outDir, {recursive: true});
      }
    } catch (e) {
      // Ignore errors.
    }
  } else {
    await builder.clearOutput();
  }
  if (argv.watch) {
    await require('./esbuild-dev-server')(builder, {
      serve: argv.serve,
      host: argv.host,
      port: argv.port,
      skipTypeCheck,
    });
  } else {
    await builder.buildOrExit({skipTypeCheck});
  }
}
if (require.main === module) {
  const argv = require('minimist')(process.argv.slice(2), {
    string: ['config', 'host', 'define'],
    boolean: ['watch', 'serve', 'typecheck'],
    default: {
      config: 'min',
      port: 8080,
      host: '127.0.0.1',
      watch: false,
      serve: false,
      typecheck: true,
    },
    unknown: arg => {
      console.log(`Unknown option: ${arg}`);
      process.exit(2);
    },
  });
  if (argv._.length > 0) {
    console.log(`Unknown options: ${JSON.stringify(argv._)}`);
    process.exit(2);
  }
  main(argv);
}
