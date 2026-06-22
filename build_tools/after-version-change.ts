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

// Update lockfiles in examples.
for (const examplePackageJsonPath of await glob("examples/*/*/package.json", {
  absolute: true,
  cwd: rootDir,
})) {
  const exampleDir = path.dirname(examplePackageJsonPath);
  await execFileAsync("pnpm", ["install"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      COREPACK_ENABLE_AUTO_PIN: "0",
    },
  });
}

await execFileAsync(
  "git",
  [
    "add",
    ...(await glob("examples/*/*/pnpm-lock.yaml", {
      absolute: false,
      cwd: rootDir,
    })),
  ],
  { cwd: rootDir },
);
