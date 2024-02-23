import fs from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");

await fs.rename(
  path.resolve(rootDir, "package.json.prepack"),
  path.resolve(rootDir, "package.json"),
);
