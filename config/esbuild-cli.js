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

// yargs strips quotes from string values in config objects
// (https://github.com/yargs/yargs-parser/issues/385).  As a workaround, we add
// in extra quotes.
function mungeConfig(config) {
  if (Array.isArray(config)) {
    return config.map(mungeConfig);
  }
  if (typeof config === 'object') {
    const result = {};
    for (const key of Object.keys(config)) {
      result[key] = mungeConfig(config[key]);
    }
    return result;
  }
  if (typeof config !== 'string') {
    return config;
  }
  return `"${config}"`;
}

function parseDefines(definesArg) {
  const defines = {};
  if (typeof definesArg === 'object' && !Array.isArray(definesArg)) {
    definesArg = [definesArg];
  }
  let defineList = definesArg || [];
  if (typeof defineList === 'string') {
    defineList = [defineList];
  }
  for (const entry of defineList) {
    if (typeof entry !== 'string') {
      Object.assign(defines, entry);
      continue;
    }
    const splitPoint = entry.indexOf('=');
    let key, value;
    if (splitPoint === -1) {
      key = entry;
      value = 'true';
    } else {
      key = entry.substring(0, splitPoint);
      value = entry.substring(splitPoint + 1);
    }
    defines[key] = value;
  }
  for (const key of Object.keys(defines)) {
    const value = defines[key];
    if (typeof value !== 'string') {
      defines[key] = JSON.stringify(value);
    }
  }
  return defines;
}
exports.parseDefines = parseDefines;

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
  const builder = new Builder({
    outDir,
    id,
    minify,
    python,
    module: moduleBuild,
    define: argv.define,
    inject: argv.inject,
    googleTagManager: argv.googleTagManager,
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
  const argv =
      require('yargs')
          .options({
            config: {
              description: 'Build configuration identifier',
              type: 'string',
              nargs: 1,
              choices: ['min', 'dev', 'python-min', 'python-dev', 'module'],
              default: 'min',
            },
            typecheck: {
              type: 'boolean',
              default: true,
              description: 'Typecheck the TypeScript code.',
            },
            define: {
              type: 'array',
              coerce: parseDefines,
              default: [],
              description:
                  'JavaScript global identifiers to define when building.  Usage: `--define VARIABLE=EXPR`.',
            },
            inject: {
              type: 'array',
              default: [],
              description: 'Additional modules to inject into global scope.',
            },
            watch: {
              type: 'boolean',
              default: false,
              description: 'Watch sources for changes and rebuild automatically.',
            },
            serve: {
              group: 'Development server options:',
              type: 'boolean',
              default: false,
              description: 'Run a development server.',
            },
            host: {
              group: 'Development server options:',
              type: 'string',
              nargs: 1,
              description:
                  'Specifies bind address for development server, e.g. 0.0.0.0 or 127.0.0.1',
              default: '127.0.0.1',
            },
            port: {
              group: 'Development server options:',
              type: 'number',
              nargs: 1,
              default: 8080,
              description: 'Port number for the development server',
            },
            configfile: {
              config: true,
              description: 'Additional JSON/JavaScript config file to load.',
              configParser: x => mungeConfig(require(x)),
            },
            ['google-tag-manager']: {
              group: 'Customization',
              type: 'string',
              nargs: 1,
              description: 'Google tag manager id to include in index.html',
            },
          })
          .strict()
          .config(mungeConfig(require('./config.js')))
          .demandCommand(0, 0)
          .version(false)
          .env('NEUROGLANCER')
          .help()
          .parse();
  if (argv.serve) {
    argv.watch = true;
  }
  main(argv);
}
