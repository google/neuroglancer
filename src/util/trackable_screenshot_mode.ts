/**
 * @license
 * Copyright 2024 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use viewer file except in compliance with the License.
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

import { TrackableEnum } from "#src/util/trackable_enum.js";

export enum ScreenshotMode {
  OFF = 0, // Default mode
  ON = 1, // Screenshot mode
  FORCE = 2, // Force screenshot mode - used when the screenshot is stuck
  PREVIEW = 3, // Preview mode - used while the user is in the screenshot menu
}

export class TrackableScreenshotMode extends TrackableEnum<ScreenshotMode> {
  constructor(value: ScreenshotMode, defaultValue: ScreenshotMode = value) {
    super(ScreenshotMode, value, defaultValue);
  }
}
