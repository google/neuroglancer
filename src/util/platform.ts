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

import type { EventModifierKeyState } from "#src/util/event_action_map.js";

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // `userAgentData` (Client Hints) is preferred where available; `navigator.platform` is
  // deprecated but remains the only option in Firefox and Safari, which do not implement
  // `userAgentData`.
  return /mac/i.test(
    (navigator as any).userAgentData?.platform ?? navigator.platform ?? "",
  );
}

/** Whether the event carries Control, or Command on Mac. */
export function hasCommandOrControl(event: EventModifierKeyState): boolean {
  return event.ctrlKey || (isMacPlatform() && event.metaKey);
}

/** Preferred display name of the modifier tested by {@link hasCommandOrControl}. */
export function commandOrControlLabel(): string {
  return isMacPlatform() ? "command" : "control";
}

/** Display name of the Alt modifier, which Mac keyboards label Option. */
export function altModifierLabel(): string {
  return isMacPlatform() ? "option" : "alt";
}
