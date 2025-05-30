// Builds the library package.
//
// This involves transpiling the TypeScript to JavaScript using esbuild.
//
// By default, the built package is staged in `dist/package`, with a
// `package.json` suitable for publishing to the NPM registry.
//
// If --inplace is specfied, the package is instead built in-place, and
// `package.json` is modified in place to be suitable for packing.  The original
// `package.json` is saved as `package.json.prepack` and is restored
// automatically by `postpack.ts` (which is run as a postpack script).

import fs from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";
import { glob } from "glob";
import ts from "typescript";
import yargs from "yargs";

const rootDir = path.resolve(import.meta.dirname, "..");

function buildDeclarationFiles(
  fileNames: string[],
  options: ts.CompilerOptions,
): void {
  options = {
    ...options,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const program = ts.createProgram(fileNames, options);
  program.emit();
}

export async function buildPackage(options: {
  inplace?: boolean;
  skipDeclarations?: boolean;
}) {
  const { inplace = false, skipDeclarations = false } = options;

  const srcDir = path.resolve(rootDir, "src");
  const outDir = inplace ? rootDir : path.resolve(rootDir, "dist", "package");
  const libDir = path.resolve(outDir, "lib");

  const packageJsonPath = path.resolve(rootDir, "package.json");

  if (inplace) {
    await fs.rm(libDir, { recursive: true, force: true });

    // Save backup that can be restored by `postpack` script.
    await fs.copyFile(
      packageJsonPath,
      path.resolve(rootDir, "package.json.prepack"),
    );
  } else {
    await fs.rm(outDir, { recursive: true, force: true });
  }

  const typescriptSources = await glob(["**/*.ts"], {
    cwd: srcDir,
    ignore: ["**/*.spec.ts", "**/*.browser_test.ts"],
    nodir: true,
  });

  const entryPoints = typescriptSources.map((name) =>
    path.resolve(srcDir, name),
  );

  await esbuild.build({
    entryPoints,
    outbase: srcDir,
    bundle: false,
    outdir: libDir,
    target: "es2022",
  });

  let compilerOptionsFromConfigFile: ts.CompilerOptions = {};
  const configFileName = ts.findConfigFile("../", ts.sys.fileExists);
  if (configFileName) {
    const configFile = ts.readConfigFile(configFileName, ts.sys.readFile);
    compilerOptionsFromConfigFile = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      "./",
    ).options;
  }
  if (!skipDeclarations) {
    buildDeclarationFiles(entryPoints, {
      ...compilerOptionsFromConfigFile,
      outDir: libDir,
    });
  }

  const otherSources = await glob(["**/*.{css,js,html,wasm}"], {
    cwd: srcDir,
    nodir: true,
  });
  await Promise.all(
    otherSources.map((name) =>
      fs.copyFile(path.resolve(srcDir, name), path.resolve(libDir, name)),
    ),
  );

  if (!inplace) {
    const otherFiles = ["README.md", "LICENSE"];
    await Promise.all(
      otherFiles.map((name) =>
        fs.copyFile(path.resolve(rootDir, name), path.resolve(outDir, name)),
      ),
    );
  }

  const packageJson = JSON.parse(
    await fs.readFile(packageJsonPath, {
      encoding: "utf-8",
    }),
  );
  delete packageJson["devDependencies"];
  if (inplace) {
    // Delete all scripts except `postpack`.  If the `postpack` script (which is
    // needed to restore `package.json.prepack`) were removed, then `npm` does
    // not run it, because it re-reads `package.json` to resolve each script.  The residual postpack script won't work, but
    const { postpack } = packageJson["scripts"];
    delete packageJson["scripts"];
    packageJson["scripts"] = { postpack };
    packageJson["files"] = ["lib/**/*"];
  } else {
    delete packageJson["private"];
    packageJson["scripts"] = {};
    delete packageJson["files"];
  }

  const EXCLUDED_EXPORT_KEYS = /^#test/;

  function convertExportMap(
    map: Record<string, any>,
    isConditions: boolean = false,
  ) {
    const entries = Object.entries(map);
    map = {};
    for (const [key, value] of entries) {
      if (!isConditions && key.match(EXCLUDED_EXPORT_KEYS) !== null) {
        continue;
      }
      if (isConditions && key === "node") {
        continue;
      }
      if (typeof value === "string") {
        map[key] = value
          .replace(/\.ts$/, ".js")
          .replace(/^\.\/src\//, "./lib/");
      } else {
        map[key] = convertExportMap(value, /*isConditions=*/ true);
      }
    }
    return map;
  }

  packageJson["imports"] = convertExportMap(packageJson["imports"]);
  packageJson["exports"] = convertExportMap(packageJson["exports"]);

  const outputPackageJson = path.resolve(outDir, "package.json");
  const tempPackageJsonPath = outputPackageJson + ".tmp";
  await fs.writeFile(
    tempPackageJsonPath,
    JSON.stringify(packageJson, undefined, 2) + "\n",
    { encoding: "utf-8" },
  );
  await fs.rename(tempPackageJsonPath, outputPackageJson);
}

async function parseArgsAndRunMain() {
  const argv = await yargs(process.argv.slice(2))
    .options({
      inplace: {
        type: "boolean",
        default: false,
        description: "Convert package to built format inplace.",
      },
      ["skip-declarations"]: {
        type: "boolean",
        default: false,
        description: "Skip generating .d.ts files.",
      },
      ["if-not-toplevel"]: {
        type: "boolean",
        default: false,
        description: "Skip building if invoked on a top-level npm repository.",
        implies: "inplace",
      },
    })
    .strict()
    .demandCommand(0, 0)
    .version(false)
    .help()
    .parse();

  if (argv.ifNotToplevel) {
    // https://stackoverflow.com/a/53239387

    // When invoked as a run script, CWD always equals `rootDir`, and
    // `process.env.INIT_CWD` indicates the CWD of the original command.
    //
    // - When running `npm install` with no arguments within a git checkout of
    //   this repository, `INIT_CWD` will be equal to `rootDir` or a descendant.
    //
    // - When running `npm install git+...`, `INIT_CWD` will equal the original
    //   path, and `rootDir` will be some cache directory containing the git -
    //   checkout, and will never be an ancestor of `INIT_CWD`.
    const initCwd = process.env.INIT_CWD,
      cwd = process.cwd();
    if (
      initCwd !== undefined &&
      (initCwd === cwd || initCwd.startsWith(cwd + path.sep))
    ) {
      console.warn(
        `Not building package due to --if-not-toplevel: cwd=${JSON.stringify(cwd)}, INIT_CWD=${JSON.stringify(initCwd)}`,
      );
      return;
    }
  }
  buildPackage({
    inplace: argv.inplace,
    skipDeclarations: argv.skipDeclarations,
  });
}

if (process.argv[1] === import.meta.filename) {
  parseArgsAndRunMain();
}
