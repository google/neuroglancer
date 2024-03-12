// Script to run after bumping the version.
//
// Runs `npm install` on all examples to ensure their lockfiles have the updated
// version.

import childProcess from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { glob } from "glob";

const execFileAsync = promisify(childProcess.execFile);

const rootDir = path.resolve(import.meta.dirname, "..");

await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
  cwd: rootDir,
});

await execFileAsync("npm", ["run", "build-package"], {
  cwd: rootDir,
});

// Update package-lock.json files in examples.
await Promise.all(
  (await glob("examples/*/*/package.json", { absolute: true, cwd: rootDir }))
    .map((examplePackageJsonPath) => path.dirname(examplePackageJsonPath))
    .map(async (exampleDir: string) => {
      await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: exampleDir,
      });
      await execFileAsync("git", ["add", "package-lock.json"], {
        cwd: exampleDir,
      });
    }),
);
