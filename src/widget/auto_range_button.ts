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

import "#src/widget/auto_range_button.css";

export function makeAutoRangeButtons(
  parent: HTMLDivElement,
  minMaxHandler: () => void,
  oneTo99Handler: () => void,
  fiveTo95Handler: () => void,
) {
  const buttonContainer = document.createElement("div");
  buttonContainer.classList.add("neuroglancer-auto-range-button-container");
  parent.appendChild(buttonContainer);

  const minMaxButton = document.createElement("button");
  minMaxButton.textContent = "Min-Max";
  minMaxButton.title = "Set range to the minimum and maximum values.";
  minMaxButton.classList.add("neuroglancer-auto-range-button");
  minMaxButton.addEventListener("click", minMaxHandler);
  buttonContainer.appendChild(minMaxButton);

  const midButton = document.createElement("button");
  midButton.textContent = "1-99%";
  midButton.title = "Set range to the 1st and 99th percentiles.";
  midButton.classList.add("neuroglancer-auto-range-button");
  midButton.addEventListener("click", oneTo99Handler);
  buttonContainer.appendChild(midButton);

  const highButton = document.createElement("button");
  highButton.textContent = "5-95%";
  highButton.title = "Set range to the 5th and 95th percentiles.";
  highButton.classList.add("neuroglancer-auto-range-button");
  highButton.addEventListener("click", fiveTo95Handler);
  buttonContainer.appendChild(highButton);
}
