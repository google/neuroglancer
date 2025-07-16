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

import { DataType } from "#src/util/data_type.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";
import { numberToStringFixed } from "#src/util/number_to_string.js";

export interface NumberDisplayConfig {
  numDecimals?: number;
  className?: string;
  readonly?: boolean;
  dataType?: DataType;
  min?: number;
  max?: number;
  step?: number;
}

export function createBoundedNumberInputElement(
  inputValue: number,
  config: NumberDisplayConfig,
): HTMLInputElement {
  const input = document.createElement("input");
  const hasNumberConfig =
    config.min !== undefined ||
    config.max !== undefined ||
    config.step !== undefined ||
    config.dataType !== undefined;
  if (!config.readonly && hasNumberConfig) {
    let min;
    let max;
    let step;
    // If the dataType is provided, we can set min, max, and step based on it
    const dataType = config.dataType;
    if (dataType !== undefined) {
      step = dataType === DataType.FLOAT32 ? 0.1 : 1;
      const bounds =
        dataType === DataType.FLOAT32
          ? [undefined, undefined]
          : defaultDataTypeRange[dataType];
      min = bounds[0] as number | undefined;
      max = bounds[1] as number | undefined;
    }
    // Config overrides dataType bounds
    min = config.min ?? min;
    max = config.max ?? max;
    step = config.step ?? step;
    input.min = min !== undefined ? String(min) : "";
    input.max = max !== undefined ? String(max) : "";
    step = step ?? 1;
    input.step = String(step);
    const withinBounds = (value: number) => {
      return (
        (min === undefined || value >= min) &&
        (max === undefined || value <= max)
      );
    };
    input.addEventListener("change", (event: Event) => {
      if (!event.target) return;
      const inputValue = (event.target as HTMLInputElement).value;
      const newValue = parseFloat(inputValue);
      // Ensure the new value is within bounds
      if (!withinBounds(newValue)) {
        // reset to the closest bound
        if (min !== undefined && newValue < min) {
          input.value = String(min);
        } else if (max !== undefined && newValue > max) {
          input.value = String(max);
        }
      }
    });
  }
  input.type = "number";
  input.value = numberToStringFixed(inputValue, config.numDecimals || 4);
  input.autocomplete = "off";
  input.spellcheck = false;
  if (config.className) input.classList.add(config.className);
  return input;
}
