/**
 * @license
 * Copyright 2026 Google Inc.
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

/**
 * @file Serves the viewer beside the mock CATMAID server. Prints a viewer URL
 * that opens the mock skeletons ready for editing.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { startCatmaidMockServer } from "./catmaid_mock_server.js";

const viewerPort = 8080;
const repositoryRoot = path.join(import.meta.dirname, "..", "..", "..");

const mockServer = await startCatmaidMockServer();
const viewerState = {
  dimensions: { x: [1e-9, "m"], y: [1e-9, "m"], z: [1e-9, "m"] },
  position: [2000, 2000, 1000],
  crossSectionScale: 10,
  projectionScale: 10000,
  layout: "4panel",
  showSlices: false,
  layers: [
    {
      type: "segmentation",
      name: "skeletons",
      source: mockServer.sourceUrl,
      segments: ["10", "20"],
      tab: "skeleton",
      skeletonBrowse: { nodeFilter: "none" },
      toolBindings: { E: "skeletonEditMode" },
    },
  ],
  selectedLayer: { layer: "skeletons", visible: true },
};

const viewer = spawn(
  process.execPath,
  [
    path.join(repositoryRoot, "build_tools/cli.ts"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(viewerPort),
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

console.log(
  `\nMock CATMAID (in memory, reset on restart): ${mockServer.url}\n` +
    `Open once the viewer reports it has compiled, then press E to edit:\n` +
    `http://127.0.0.1:${viewerPort}/#!${encodeURIComponent(JSON.stringify(viewerState))}\n`,
);

viewer.on("exit", () => {
  void mockServer.close().then(() => process.exit());
});
process.on("SIGINT", () => viewer.kill("SIGINT"));
