import { DataType } from "#src/util/data_type.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";
import { numberToStringFixed } from "#src/util/number_to_string.js";

interface InputConfig {
  inputValue?: number;
  numDecimals?: number;
  className?: string;
  readonly?: boolean;
}

interface NumberConfig {
  dataType?: DataType;
  min?: number;
  max?: number;
  step?: number;
}

export function createBoundedNumberInputElement(
  config: InputConfig,
  numberConfig?: NumberConfig,
): HTMLInputElement {
  const input = document.createElement("input");
  if (numberConfig && !config.readonly) {
    let { min, max, step } = numberConfig;
    // If the dataType is provided, we can set min, max, and step based on it
    const dataType = numberConfig.dataType;
    if (dataType !== undefined) {
      step = dataType === DataType.FLOAT32 ? 0.1 : 1;
      const bounds =
        dataType === DataType.FLOAT32
          ? [undefined, undefined]
          : defaultDataTypeRange[dataType];
      min = bounds[0] as number | undefined;
      max = bounds[1] as number | undefined;
    }
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
  input.value = numberToStringFixed(
    config.inputValue || 0,
    config.numDecimals || 4,
  );
  input.autocomplete = "off";
  input.spellcheck = false;
  if (config.className) input.classList.add(config.className);
  return input;
}
