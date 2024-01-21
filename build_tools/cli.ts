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

import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "path";
import * as vite from "vite";
import checkerPlugin from "vite-plugin-checker";
import yargs from "yargs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// yargs strips quotes from string values in config objects
// (https://github.com/yargs/yargs-parser/issues/385).  As a workaround, we add
// in extra quotes.
// function mungeConfig(config) {
//   if (Array.isArray(config)) {
//     return config.map(mungeConfig);
//   }
//   if (typeof config === "object") {
//     const result = {};
//     for (const key of Object.keys(config)) {
//       result[key] = mungeConfig(config[key]);
//     }
//     return result;
//   }
//   if (typeof config !== "string") {
//     return config;
//   }
//   return `"${config}"`;
// }

function parseDefines(
  definesArg:
    | Record<string, string>
    | string
    | string[]
    | Record<string, string>[],
): Record<string, string> {
  const defines: Record<string, string> = {};
  if (typeof definesArg === "object" && !Array.isArray(definesArg)) {
    definesArg = [definesArg];
  }
  let defineList = definesArg || [];
  if (typeof defineList === "string") {
    defineList = [defineList];
  }
  for (const entry of defineList) {
    if (typeof entry !== "string") {
      Object.assign(defines, entry);
      continue;
    }
    const splitPoint = entry.indexOf("=");
    let key;
    let value;
    if (splitPoint === -1) {
      key = entry;
      value = "true";
    } else {
      key = entry.substring(0, splitPoint);
      value = entry.substring(splitPoint + 1);
    }
    defines[key] = value;
  }
  for (const key of Object.keys(defines)) {
    const value = defines[key];
    if (typeof value !== "string") {
      defines[key] = JSON.stringify(value);
    }
  }
  return defines;
}

type Argv = Awaited<ReturnType<typeof parseArgs>>;

async function getViteConfig(argv: Argv): Promise<vite.UserConfig> {
  let config: vite.UserConfig = {};
  for (const configPath of argv.config) {
    const loadedConfig = (await import(pathToFileURL(configPath).href)).default;
    config = vite.mergeConfig(config, loadedConfig);
  }

  const conditions = argv.conditions;
  if (argv.python) conditions.push("neuroglancer/python");
  const outDir =
    (argv.output as string | undefined) ??
    (argv.python
      ? path.resolve(
          __dirname,
          "..",
          "python",
          "neuroglancer",
          "static",
          "client",
        )
      : undefined);
  const inlineConfig = {
    root: path.resolve(__dirname, ".."),
    base: argv.base,
    define: argv.define,
    ...(argv.mode !== undefined ? { mode: argv.mode } : {}),
    build: {
      watch: argv.watch ? {} : undefined,
      outDir,
    },
    plugins: [
      argv.typecheck || argv.lint
        ? checkerPlugin({
            typescript: argv.typecheck ?? false,
            eslint: argv.lint
              ? {
                  lintCommand: "eslint .",
                }
              : undefined,
          })
        : undefined,
    ],
    resolve: {
      conditions,
    },
  } satisfies vite.UserConfig;
  return vite.mergeConfig(config, inlineConfig);
}

function parseArgs() {
  return yargs(process.argv.slice(2))
    .options({
      typecheck: {
        type: "boolean",
        default: true,
        description: "Typecheck the TypeScript code.",
      },
      lint: {
        type: "boolean",
        default: true,
        description: "Run eslint.",
      },
      python: {
        type: "boolean",
        description:
          "Build Python client, equivalent to --conditions=neuroglancer/python",
        default: false,
      },
      conditions: {
        type: "array",
        coerce: (arg: string[]) => arg.map((x) => x.split(",")).flat(),
        nargs: 1,
        default: [],
        description:
          "Comma-separated list of additional custom Node.js package import/export conditions.",
      },
      define: {
        type: "array",
        coerce: parseDefines,
        nargs: 1,
        default: [],
        description:
          "JavaScript global identifiers to define when building.  Usage: `--define VARIABLE=EXPR`.",
      },
      mode: {
        description: "Build mode",
        type: "string",
      },
      base: {
        type: "string",
        description: "Base path to assume.",
      },
      config: {
        array: true,
        string: true,
        nargs: 1,
        default: [],
        description:
          "Additional vite config module to merge into configuration.",
      },
    })
    .command({
      command: "serve",
      aliases: ["$0"],
      describe: "Run the development server.",
      builder: (parser) =>
        parser.options({
          mode: {
            default: "development",
          },
          port: {
            group: "Development server options",
            type: "number",
            nargs: 1,
            default: 8080,
            description: "Port number for the development server",
          },
          host: {
            group: "Development server options",
            type: "string",
            nargs: 1,
            description: "Specifies bind address for development server.",
            default: "localhost",
          },
        }),
      handler: async (argv) => {
        const server = await vite.createServer(
          vite.mergeConfig(await getViteConfig(argv), {
            server: {
              port: argv.port,
              host: argv.host,
            },
          }),
        );
        await server.listen();

        server.printUrls();
        server.bindCLIShortcuts({ print: true });
      },
    })
    .command({
      command: "build",
      describe: "Build the client.",
      builder: (parser) =>
        parser.options({
          output: {
            group: "Build options",
            type: "string",
            nargs: 1,
            description: "Output directory.",
          },
          watch: {
            type: "boolean",
            default: false,
            description: "Watch for changes.",
          },
          mode: {
            default: "production",
          },
        }),
      handler: async (argv) => {
        await vite.build(vite.mergeConfig(await getViteConfig(argv), {}));
      },
    })
    .strict()
    .version(false)
    .help()
    .parse();
}

async function parseArgsAndRunMain() {
  parseArgs();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  parseArgsAndRunMain();
}
