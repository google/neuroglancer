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

/// <reference types="webpack-dev-server" />

import process from "node:process";
import { pathToFileURL } from "node:url";
import path from "path";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import type { Configuration } from "webpack";
import webpackCli from "webpack-cli/lib/bootstrap.js"; // eslint-disable-line import/default
import * as webpackMerge from "webpack-merge";
import yargs from "yargs";
import { normalizeConfigurationWithDefine } from "./webpack/configuration_with_define.js";
import { setConfig } from "./webpack/webpack_config_from_cli.cjs";

export interface WebpackConfigurationWithDefine extends Configuration {
  define?: Record<string, any> | undefined;
}

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

async function getWebpackConfig(
  argv: Argv,
  ...extraConfigs: WebpackConfigurationWithDefine[]
): Promise<(...args: any[]) => Configuration> {
  const configPaths = [
    pathToFileURL(path.resolve(import.meta.dirname, "../webpack.config.js"))
      .href,
    ...argv.config.map((configPath) => pathToFileURL(configPath).href),
  ];
  const allConfigs = await Promise.all(
    configPaths.map(async (configPath) => (await import(configPath)).default),
  );
  allConfigs.push(...extraConfigs);
  return (webpackEnv, webpackArgs) => {
    webpackEnv = { ...webpackEnv, NEUROGLANCER_CLI: true };
    const conditions = argv.conditions;
    if (argv.python) conditions.push("neuroglancer/python");
    let outDir =
      (argv.output as string | undefined) ??
      (argv.python
        ? path.resolve(
            import.meta.dirname,
            "..",
            "python",
            "neuroglancer",
            "static",
            "client",
          )
        : undefined);
    if (outDir !== undefined) {
      outDir = path.resolve(outDir);
    }
    const plugins = [];
    if (argv.typecheck || argv.lint) {
      plugins.push(
        new ForkTsCheckerWebpackPlugin({
          typescript: argv.typecheck,
          eslint: argv.lint
            ? {
                files: ".",
              }
            : undefined,
        }),
      );
    }
    const inlineConfig = {
      define: argv.define,
      plugins,
      output: {
        path: outDir,
      },
      resolve: {
        conditionNames: ["...", ...conditions],
      },
    } satisfies WebpackConfigurationWithDefine;
    const resolvedConfigs = allConfigs.map((config) =>
      typeof config === "function" ? config(webpackEnv, webpackArgs) : config,
    );
    return normalizeConfigurationWithDefine(
      webpackMerge.merge([...resolvedConfigs, inlineConfig]),
    );
  };
}

async function runWebpack(...args: string[]) {
  // @ts-expect-error: no typings available
  await webpackCli([
    ...process.argv.slice(0, 2),
    ...args,
    "--config",
    path.resolve(import.meta.dirname, "webpack", "webpack_config_from_cli.cjs"),
  ]);
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
      config: {
        array: true,
        string: true,
        nargs: 1,
        default: [],
        description:
          "Additional webpack config module to merge into configuration.",
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
        setConfig(
          await getWebpackConfig(argv, {
            devServer: {
              port: argv.port === 0 ? "auto" : argv.port,
              host: argv.host,
            },
          }),
        );
        await runWebpack("serve", `--mode=${argv.mode}`);
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
        setConfig(await getWebpackConfig(argv, { watch: argv.watch }));
        await runWebpack("build", `--mode=${argv.mode}`);
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
if (process.argv[1] === import.meta.filename) {
  parseArgsAndRunMain();
}
