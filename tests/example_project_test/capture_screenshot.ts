/**
 * @license
 * Copyright 2025 Google Inc.
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

import crypto from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";
import { sendScreenshotServerCommand } from "#tests/example_project_test/screenshot_comparison_server.js";

const TEST_FRAGMENT =
  "#!%7B%22dimensions%22:%7B%22x%22:%5B8e-9%2C%22m%22%5D%2C%22y%22:%5B8e-9%2C%22m%22%5D%2C%22z%22:%5B8e-9%2C%22m%22%5D%7D%2C%22position%22:%5B22316.904296875%2C21921.87890625%2C24029.763671875%5D%2C%22crossSectionScale%22:1%2C%22crossSectionDepth%22:-37.62185354999912%2C%22projectionOrientation%22:%5B-0.1470303237438202%2C0.5691322684288025%2C0.19562694430351257%2C0.7849844694137573%5D%2C%22projectionScale%22:118020.30607575581%2C%22layers%22:%5B%7B%22type%22:%22image%22%2C%22source%22:%22precomputed://gs://neuroglancer-janelia-flyem-hemibrain/emdata/clahe_yz/jpeg%22%2C%22tab%22:%22rendering%22%2C%22crossSectionRenderScale%22:4%2C%22name%22:%22emdata%22%7D%2C%7B%22type%22:%22segmentation%22%2C%22source%22:%22precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.0/segmentation%22%2C%22tab%22:%22rendering%22%2C%22segments%22:%5B%221944507292%22%5D%2C%22name%22:%22segmentation%22%7D%5D%2C%22showSlices%22:false%2C%22selectedLayer%22:%7B%22layer%22:%22emdata%22%7D%2C%22layout%22:%22xy-3d%22%2C%22statistics%22:%7B%22size%22:232%7D%7D";

async function postScreenshotResult(screenshot: Buffer, projectName: string) {
  const hash = crypto.createHash("sha256");
  hash.update(screenshot);
  const digest = hash.digest("hex");
  await sendScreenshotServerCommand(`/${projectName}/${digest}`, {
    method: "PUT",
  });
}

export async function captureNeuroglancerScreenshot(
  page: Page,
  url: string,
  testInfo: TestInfo,
  testFragment: string = TEST_FRAGMENT,
) {
  await page.goto(url + testFragment);

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          try {
            const viewer = (globalThis as any).viewer;
            return typeof viewer !== "undefined" && viewer.isReady();
          } catch {
            return false;
          }
        }),
      { message: "Waiting for data to load in Neuroglancer", timeout: 30000 },
    )
    .toBeTruthy();

  const screenshot = await page.screenshot();
  testInfo.attach("screenshot", { body: screenshot, contentType: "image/png" });
  await postScreenshotResult(screenshot, testInfo.project.name);
}
