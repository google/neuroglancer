/**
 * @license
 * Copyright 2024 Google Inc.
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

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export async function getFakeGcsServerBin(): Promise<string> {
  const binDir = path.join(
    import.meta.dirname,
    "..",
    "..",
    "node_modules",
    ".cache",
    "gobin",
  );
  const serverBinPath =
    path.join(binDir, "fake-gcs-server") +
    (process.platform === "win32" ? ".exe" : "");
  if (
    !(await fs.access(serverBinPath).then(
      () => true,
      () => false,
    ))
  ) {
    console.log("Building fake-gcs-server");
    // Note: For unknown reasons, using `await promisify(spawn)` in place of
    // `spawnSync` causes the vitest process to exit as soon as the child
    // process completes.
    spawnSync(
      "go",
      [
        "install",
        "github.com/fsouza/fake-gcs-server@3b3d059cbaade55b480196a51dedb7aa82ec2b0a",
      ],
      {
        env: { ...process.env, GOBIN: binDir },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    console.log("Done building fake-gcs-server");
  }
  return serverBinPath;
}
