import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const rootDir = path.resolve(__dirname, "..");

await fs.rename(
  path.resolve(rootDir, "package.json.prepack"),
  path.resolve(rootDir, "package.json"),
);
