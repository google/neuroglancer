/**
 * @license
 * Copyright 2019 Google Inc.
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

import "#src/widget/display_dimensions_widget.css";

import { debounce } from "lodash-es";
import {
  getDimensionNameValidity,
  validateDimensionNames,
} from "#src/coordinate_transform.js";
import type {
  TrackableDepthRange,
  TrackableZoomInterface,
  WatchableDisplayDimensionRenderInfo,
} from "#src/navigation_state.js";
import { registerNested } from "#src/trackable_value.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { arraysEqual } from "#src/util/array.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  removeChildren,
  removeFromParent,
  updateInputFieldWidth,
} from "#src/util/dom.js";
import {
  KeyboardEventBinder,
  registerActionListener,
} from "#src/util/keyboard_bindings.js";
import { EventActionMap, MouseEventBinder } from "#src/util/mouse_bindings.js";
import { numberToStringFixed } from "#src/util/number_to_string.js";
import { formatScaleWithUnitAsString, parseScale } from "#src/util/si_units.js";
import { NullarySignal } from "#src/util/signal.js";
import { RenderViewport } from "#src/display_context.js";

const dimensionColors = ["#f00", "#0f0", "#99f"];

export type NamedAxes = "xy" | "xz" | "yz";

enum Axis {
  x = 0,
  y = 1,
  z = 2,
}

interface DimensionWidget {
  container: HTMLDivElement;
  name: HTMLInputElement;
  scaleFactor: HTMLInputElement;
  scale: HTMLInputElement;
  scaleFactorModified: boolean;
}

const inputEventMap = EventActionMap.fromObject({
  arrowup: { action: "move-up" },
  arrowdown: { action: "move-down" },
  wheel: { action: "adjust-via-wheel" },
  enter: { action: "commit" },
  escape: { action: "cancel" },
});

function formatScaleFactor(x: number) {
  if (x < 1 || x > 1024) {
    const exponent = Math.log2(x) | 0;
    const coeff = x / 2 ** exponent;
    return `${numberToStringFixed(coeff, 1)}p${exponent}`;
  }
  return x.toString();
}

const widgetFieldGetters: ((
  dimElements: DimensionWidget,
) => HTMLInputElement)[] = [(x) => x.name, (x) => x.scaleFactor];

/**
 * Time in milliseconds to display widget after zoom or depth range changes.
 */
const postActivityDisplayPeriod = 2000;

/**
 * Time in milliseconds to delay updating zoom after input is changed.
 * To avoid updating zoom while user is typing.
 */
const zoomUpdateDelay = 1500;

// In regular typing, the input event is fired in a debounced manner
// If the user presses enter, the input event is fired immediately
function debouncedZoomUpdate(input: HTMLInputElement, callback: () => void) {
  const debouncedCallback = debounce(callback, zoomUpdateDelay);
  input.addEventListener("input", () => {
    debouncedCallback();
  });
  input.addEventListener("keyup", ({ key }) => {
    if (key === "Enter") {
      debouncedCallback.flush();
    }
  });
  // And the same if the user leaves the input field if needed
  //input.addEventListener("blur", () => {
  //  debouncedCallback.flush();
  // });
}

export class DisplayDimensionsWidget extends RefCounted {
  element = document.createElement("div");

  dimensionGridContainer = document.createElement("div");
  depthGridContainer = document.createElement("div");
  fovGridContainer = document.createElement("div");
  defaultCheckbox = document.createElement("input");

  fovInputElements: HTMLInputElement[] = [];
  fovNameElements: HTMLSpanElement[] = [];

  axes: NamedAxes | undefined | "zy";

  dimensionElements = Array.from(Array(3), (_, i): DimensionWidget => {
    const container = document.createElement("div");
    container.classList.add("neuroglancer-display-dimensions-widget-dimension");
    container.style.display = "contents";
    registerActionListener<WheelEvent>(
      container,
      "adjust-via-wheel",
      (actionEvent) => {
        const event = actionEvent.detail;
        const { deltaY } = event;
        if (deltaY === 0) {
          return;
        }
        this.zoomDimension(i, Math.sign(deltaY));
      },
    );

    const name = document.createElement("input");
    name.classList.add("neuroglancer-display-dimensions-widget-name");
    name.title = "Change display dimensions";
    name.spellcheck = false;
    name.autocomplete = "off";
    name.style.color = dimensionColors[i];
    name.style.gridColumn = "1";
    name.style.gridRow = `${i + 1}`;
    name.addEventListener("focus", () => {
      name.select();
    });
    container.appendChild(name);

    const scaleFactorContainer = document.createElement("span");
    scaleFactorContainer.classList.add(
      "neuroglancer-display-dimensions-widget-scale-factor",
    );
    const scaleFactor = document.createElement("input");
    scaleFactor.spellcheck = false;
    scaleFactor.title = "Change relative scale at which dimension is displayed";
    scaleFactor.autocomplete = "off";
    scaleFactorContainer.style.gridColumn = "2";
    scaleFactorContainer.style.gridRow = `${i + 1}`;
    scaleFactor.addEventListener("focus", () => {
      scaleFactor.select();
    });
    scaleFactorContainer.appendChild(scaleFactor);
    container.appendChild(scaleFactorContainer);

    const scale = document.createElement("input");
    scale.classList.add("neuroglancer-display-dimensions-widget-scale");
    scale.style.gridColumn = "3";
    scale.style.gridRow = `${i + 1}`;
    container.appendChild(scale);
    this.dimensionGridContainer.appendChild(container);

    debouncedZoomUpdate(scale, () => {
      const {
        canonicalVoxelFactors,
        displayDimensionScales,
        displayDimensionUnits,
      } = this.displayDimensionRenderInfo.value;
      // If the scale ends with /px or /vh, remove it
      const formattedScale = scale.value.replace(`/${this.displayUnit}`, "");
      const parsedScale = parseScale(formattedScale);
      if (!parsedScale || parsedScale.unit !== displayDimensionUnits[i]) {
        // If the input is invalid, reset the scale to the current value
        this.updateView();
        return;
      }
      const desiredZoomLevel =
        (parsedScale.scale * canonicalVoxelFactors[i]) /
        displayDimensionScales[i];
      this.zoom.value = desiredZoomLevel;
    });

    const dimWidget: DimensionWidget = {
      name,
      container,
      scaleFactor,
      scale,
      scaleFactorModified: false,
    };
    name.addEventListener("input", () => {
      updateInputFieldWidth(name);
      this.updateNameValidity();
    });
    registerActionListener(name, "commit", () => {
      this.updateNames();
    });
    name.addEventListener("blur", (event: FocusEvent) => {
      const { relatedTarget } = event;
      if (this.dimensionElements.some((x) => x.name === relatedTarget)) {
        return;
      }
      if (!this.updateNames()) {
        this.updateView();
      }
    });
    scaleFactorContainer.addEventListener("click", (event: MouseEvent) => {
      const { target } = event;
      if (target === scaleFactor) return;
      scaleFactor.focus();
      event.preventDefault();
    });
    scaleFactor.addEventListener("input", () => {
      updateInputFieldWidth(scaleFactor);
      dimWidget.scaleFactorModified = true;
    });
    registerActionListener(scaleFactor, "commit", () => {
      this.updateScaleFactors();
    });
    scaleFactor.addEventListener("blur", () => {
      if (!this.updateScaleFactors()) {
        this.updateView();
      }
    });
    for (const getter of widgetFieldGetters) {
      registerActionListener(getter(dimWidget), "move-up", () => {
        if (i !== 0) {
          getter(this.dimensionElements[i - 1]).focus();
        }
      });
      registerActionListener(getter(dimWidget), "move-down", () => {
        if (i !== 2) {
          getter(this.dimensionElements[i + 1]).focus();
        }
      });
    }
    return dimWidget;
  });

  private zoomDimension(i: number, sign: number) {
    this.updateScaleFactors();
    const { displayDimensions } = this;
    const { relativeDisplayScales } = this;
    const { displayDimensionIndices } = displayDimensions.value;
    const dim = displayDimensionIndices[i];
    if (dim === -1) return;
    const { factors } = relativeDisplayScales.value;
    const newFactors = new Float64Array(factors);
    newFactors[dim] *= 2 ** -sign;
    relativeDisplayScales.setFactors(newFactors);
  }

  private updateNameValidity() {
    const { dimensionElements } = this;
    const { displayDimensionIndices } = this.displayDimensions.value;
    const displayDimensionNames = dimensionElements.map((w) => w.name.value);
    const isValid = getDimensionNameValidity(displayDimensionNames);
    const coordinateSpace = this.displayDimensions.coordinateSpace.value;
    const { names } = coordinateSpace;
    const rank = displayDimensionNames.length;
    for (let i = 0; i < rank; ++i) {
      let valid = isValid[i];
      const name = displayDimensionNames[i];
      let newIndex = -1;
      if (name.length === 0) {
        valid = true;
      } else {
        newIndex = names.indexOf(name);
        if (newIndex === -1) {
          valid = false;
        }
      }
      const dimElements = dimensionElements[i];
      dimElements.name.dataset.isValid = valid.toString();
      dimElements.container.dataset.isModified = (
        newIndex !== displayDimensionIndices[i]
      ).toString();
    }
  }

  private scheduleUpdateView = animationFrameDebounce(() => this.updateView());

  get displayDimensions() {
    return this.displayDimensionRenderInfo.displayDimensions;
  }

  get relativeDisplayScales() {
    return this.displayDimensionRenderInfo.relativeDisplayScales;
  }

  /*
   * Switches the axes between yz and zy
   * This is because the conventional ordering is first dimension x-axis
   * second dimension y-axis
   * The xy and xz layouts both follow this ordering, but the yz layout does not
   * in the yz layout, z is the x-axis and y is the y-axis, so its zy in this convention
   */
  normalizeAxes() {
    this.axes = this.axes === "yz" ? "zy" : this.axes;
  }

  constructor(
    public displayDimensionRenderInfo: Owned<WatchableDisplayDimensionRenderInfo>,
    public zoom: TrackableZoomInterface,
    public depthRange: Owned<TrackableDepthRange>,
    inputAxes: NamedAxes | undefined,
    public panelBoundsUpdated: NullarySignal,
    public panelRenderViewport: RenderViewport,
    public displayUnit = "px",
  ) {
    super();
    this.axes = inputAxes;
    this.normalizeAxes();
    const { element, dimensionGridContainer, defaultCheckbox, axes } = this;
    const defaultCheckboxLabel = document.createElement("label");

    const hideWidgetDetails = this.registerCancellable(
      debounce(() => {
        element.dataset.active = "false";
      }, postActivityDisplayPeriod),
    );

    const handleActivity = () => {
      element.dataset.active = "true";
      hideWidgetDetails();
    };

    this.registerDisposer(zoom.changed.add(handleActivity));
    this.registerDisposer(
      displayDimensionRenderInfo.relativeDisplayScales.changed.add(
        handleActivity,
      ),
    );
    this.registerDisposer(depthRange.changed.add(handleActivity));

    element.classList.add("neuroglancer-display-dimensions-widget");
    element.appendChild(dimensionGridContainer);
    dimensionGridContainer.classList.add(
      "neuroglancer-display-dimensions-widget-dimension-grid",
    );
    element.addEventListener("pointerleave", () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && element.contains(focused)) {
        focused.blur();
      }
    });
    defaultCheckbox.type = "checkbox";
    defaultCheckboxLabel.appendChild(defaultCheckbox);
    defaultCheckboxLabel.appendChild(document.createTextNode("Default dims"));
    defaultCheckboxLabel.title = "Display first 3 dimensions";
    defaultCheckboxLabel.classList.add(
      "neuroglancer-display-dimensions-widget-default",
    );
    defaultCheckbox.addEventListener("change", () => {
      this.updateDefault();
    });
    dimensionGridContainer.appendChild(defaultCheckboxLabel);
    this.registerDisposer(displayDimensionRenderInfo);
    this.registerDisposer(depthRange);
    this.registerDisposer(zoom.changed.add(this.scheduleUpdateView));
    this.registerDisposer(
      displayDimensionRenderInfo.changed.add(this.scheduleUpdateView),
    );
    this.registerDisposer(this.panelBoundsUpdated.add(this.scheduleUpdateView));
    const keyboardHandler = this.registerDisposer(
      new KeyboardEventBinder(element, inputEventMap),
    );
    keyboardHandler.allShortcutsAreGlobal = true;
    this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    registerActionListener(dimensionGridContainer, "cancel", () => {
      this.updateView();
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && element.contains(focused)) {
        focused.blur();
      }
    });

    if (axes !== undefined) {
      const { fovGridContainer } = this;
      fovGridContainer.classList.add(
        "neuroglancer-display-dimensions-widget-fov",
      );
      element.appendChild(fovGridContainer);
      const topLevelFOVLabel = document.createElement("div");
      topLevelFOVLabel.textContent = "Field of view:";
      fovGridContainer.appendChild(topLevelFOVLabel);
      for (let i = 0; i < 2; ++i) {
        const container = document.createElement("div");
        container.classList.add(
          "neuroglancer-display-dimensions-widget-fov-container",
        );
        const label = document.createElement("span");
        this.fovNameElements.push(label);
        const axisIndex = Axis[axes[i] as keyof typeof Axis];
        label.textContent = "";
        label.style.color = dimensionColors[axisIndex];
        container.appendChild(label);
        const input = document.createElement("input");
        input.spellcheck = false;
        input.autocomplete = "off";
        input.title = "Field of view";
        this.fovInputElements.push(input);
        container.appendChild(input);
        fovGridContainer.appendChild(container);

        debouncedZoomUpdate(input, () => {
          const {
            displayDimensionScales,
            canonicalVoxelFactors,
            displayDimensionUnits,
          } = this.displayDimensionRenderInfo.value;
          const parsedFov = parseScale(input.value);
          if (!parsedFov || parsedFov.unit !== displayDimensionUnits[i]) {
            // If the input is invalid or the wrong unit
            // reset the input states to the previous values
            this.updateView();
            return;
          }
          const axisIndex = Axis[axes[i] as keyof typeof Axis];
          const { width, height } = this.panelRenderViewport;
          const pixelResolution = i === 0 ? width : height;
          // Determine the desired zoom level
          const parsedScale = parsedFov.scale / pixelResolution;
          const desiredZoomLevel =
            (parsedScale * canonicalVoxelFactors[axisIndex]) /
            displayDimensionScales[axisIndex];
          this.zoom.value = desiredZoomLevel;
        });
      }
    }

    const { depthGridContainer } = this;
    depthGridContainer.classList.add("neuroglancer-depth-range-widget-grid");
    element.appendChild(depthGridContainer);

    const relativeCheckboxLabel = document.createElement("label");
    const relativeCheckbox = document.createElement("input");
    relativeCheckbox.type = "checkbox";
    relativeCheckboxLabel.classList.add(
      "neuroglancer-depth-range-relative-checkbox-label",
    );
    relativeCheckbox.classList.add(
      "neuroglancer-depth-range-relative-checkbox",
    );
    relativeCheckboxLabel.appendChild(relativeCheckbox);
    relativeCheckboxLabel.appendChild(document.createTextNode("Zoom-relative"));
    relativeCheckbox.addEventListener("change", () => {
      const relative = relativeCheckbox.checked;
      let value = this.depthRange.value;
      if (relative === value < 0) return;
      if (relative) {
        value = -value / this.zoom.value;
      } else {
        value = -value * this.zoom.value;
      }
      this.depthRange.value = value;
    });
    relativeCheckboxLabel.title = "Depth range is multiplied by scale";
    element.appendChild(relativeCheckboxLabel);
    registerActionListener<WheelEvent>(
      depthGridContainer,
      "adjust-via-wheel",
      (actionEvent) => {
        const event = actionEvent.detail;
        const { deltaY } = event;
        if (deltaY === 0) {
          return;
        }
        const value = this.depthRange.value;
        this.depthRange.value = value * 2 ** Math.sign(deltaY);
      },
    );

    this.registerDisposer(
      registerNested(
        (context, displayDimensionRenderInfoValue, { factors }) => {
          removeChildren(depthGridContainer);
          interface DepthWidget {
            unit: string;
            factor: number;
            scale: number;
            dimensionNames: string[];
            input: HTMLInputElement;
            label: HTMLSpanElement;
          }
          const {
            displayRank,
            globalDimensionNames,
            displayDimensionIndices,
            displayDimensionUnits,
            displayDimensionScales,
            canonicalVoxelFactors,
          } = displayDimensionRenderInfoValue;
          const widgets: DepthWidget[] = [];

          const updateView = () => {
            relativeCheckbox.checked = this.depthRange.value < 0;
            let rangeValue = this.depthRange.value;
            if (rangeValue < 0) {
              rangeValue *= -this.zoom.value;
            }
            for (const widget of widgets) {
              const { input } = widget;
              input.value = formatScaleWithUnitAsString(
                rangeValue * widget.scale,
                widget.unit,
                { precision: 2, elide1: false },
              );
              updateInputFieldWidth(input);
            }
          };
          const updateModel = (widget: DepthWidget) => {
            const result = parseScale(widget.input.value);
            if (result === undefined || result.unit !== widget.unit)
              return false;
            let value = result.scale / widget.scale;
            if (this.depthRange.value < 0) {
              value = -value / this.zoom.value;
            }
            this.depthRange.value = value;
            return true;
          };

          for (let i = 0; i < displayRank; ++i) {
            const dim = displayDimensionIndices[i];
            const name = globalDimensionNames[dim];
            const unit = displayDimensionUnits[i];
            const factor = factors[dim];
            let widget = widgets.find(
              (w) => w.unit === unit && w.factor === factor,
            );
            if (widget === undefined) {
              const container = document.createElement("div");
              container.title = "Visible depth range";
              container.classList.add("neuroglancer-depth-range-container");
              depthGridContainer.appendChild(container);
              const plusMinus = document.createElement("span");
              plusMinus.textContent = "±";
              container.appendChild(plusMinus);
              const input = document.createElement("input");
              input.spellcheck = false;
              input.autocomplete = "off";
              input.addEventListener("focus", () => {
                input.select();
              });
              registerActionListener(input, "commit", () => {
                updateModel(widget!);
              });
              input.addEventListener("change", () => {
                if (!updateModel(widget!)) {
                  updateView();
                }
              });
              input.addEventListener("input", () => {
                updateInputFieldWidth(input);
              });
              container.appendChild(input);
              const label = document.createElement("span");
              label.classList.add(
                "neuroglancer-depth-range-widget-dimension-names",
              );
              container.appendChild(label);
              widget = {
                unit,
                factor,
                dimensionNames: [],
                input,
                label,
                scale: displayDimensionScales[i] / canonicalVoxelFactors[i],
              };
              widgets.push(widget);
            }
            widget.dimensionNames.push(name);
          }
          for (const widget of widgets) {
            if (widget.dimensionNames.length !== displayRank) {
              widget.label.textContent = widget.dimensionNames.join(" ");
            }
          }

          context.registerDisposer(
            registerActionListener(depthGridContainer, "cancel", () => {
              updateView();
              const focused = document.activeElement;
              if (
                focused instanceof HTMLElement &&
                depthGridContainer.contains(focused)
              ) {
                focused.blur();
              }
            }),
          );
          const debouncedUpdateView = context.registerCancellable(
            animationFrameDebounce(updateView),
          );
          context.registerDisposer(
            this.depthRange.changed.add(debouncedUpdateView),
          );
          context.registerDisposer(this.zoom.changed.add(debouncedUpdateView));
          updateView();
        },
        displayDimensionRenderInfo,
        this.relativeDisplayScales,
      ),
    );

    this.updateView();
  }

  private updateNames(): boolean {
    const displayDimensionNames = this.dimensionElements
      .map((x) => x.name.value)
      .filter((x) => x.length > 0);
    if (!validateDimensionNames(displayDimensionNames)) return false;
    const { displayDimensions } = this.displayDimensionRenderInfo;
    if (displayDimensionNames.length === 0) {
      displayDimensions.reset();
      return true;
    }
    const dimensionIndices = new Int32Array(3);
    dimensionIndices.fill(-1);
    const coordinateSpace = displayDimensions.coordinateSpace.value;
    const { names } = coordinateSpace;
    const rank = displayDimensionNames.length;
    for (let i = 0; i < rank; ++i) {
      const index = names.indexOf(displayDimensionNames[i]);
      if (index === -1) return false;
      dimensionIndices[i] = index;
    }
    if (
      arraysEqual(
        dimensionIndices,
        displayDimensions.value.displayDimensionIndices,
      )
    ) {
      return true;
    }
    displayDimensions.setDimensionIndices(rank, dimensionIndices);
    return true;
  }

  private updateDefault() {
    this.displayDimensions.default = this.defaultCheckbox.checked;
  }

  private updateScaleFactors(): boolean {
    const { displayDimensions } = this;
    const { relativeDisplayScales } = this;
    const { displayDimensionIndices, displayRank } = displayDimensions.value;
    const { factors } = relativeDisplayScales.value;
    const { dimensionElements } = this;
    const newFactors = new Float64Array(factors);
    for (let i = 0; i < displayRank; ++i) {
      const dimElements = dimensionElements[i];
      if (!dimElements.scaleFactorModified) continue;
      const factor = Number(dimElements.scaleFactor.value);
      const dim = displayDimensionIndices[i];
      if (!Number.isFinite(factor) || factor <= 0) continue;
      newFactors[dim] = factor;
    }
    if (!arraysEqual(newFactors, factors)) {
      relativeDisplayScales.setFactors(newFactors);
    }
    return true;
  }

  private updateView() {
    const {
      dimensionElements,
      displayDimensions: { default: isDefault },
    } = this;
    const {
      displayDimensionIndices,
      canonicalVoxelFactors,
      displayDimensionUnits,
      displayDimensionScales,
      globalDimensionNames,
    } = this.displayDimensionRenderInfo.value;
    const { factors } = this.relativeDisplayScales.value;
    this.defaultCheckbox.checked = isDefault;
    const zoom = this.zoom.value;
    // Check if all units and factors are the same.
    const firstDim = displayDimensionIndices[0];
    let singleScale = true;
    if (firstDim !== -1) {
      const unit = displayDimensionUnits[0];
      const factor = factors[firstDim];
      for (let i = 1; i < 3; ++i) {
        const dim = displayDimensionIndices[i];
        if (dim === -1) continue;
        if (displayDimensionUnits[i] !== unit || factors[dim] !== factor) {
          singleScale = false;
          break;
        }
      }
    }
    for (let i = 0; i < 3; ++i) {
      const dim = displayDimensionIndices[i];
      const dimElements = dimensionElements[i];
      dimElements.name.dataset.isValid = undefined;
      dimElements.container.dataset.isModified = (dim === -1).toString();
      if (dim === -1) {
        dimElements.name.value = "";
        dimElements.scale.value = "";
        dimElements.scaleFactor.value = "";
      } else {
        dimElements.name.value = globalDimensionNames[dim];
        const totalScale =
          (displayDimensionScales[i] * zoom) / canonicalVoxelFactors[i];
        if (i === 0 || !singleScale) {
          const formattedScale = formatScaleWithUnitAsString(
            totalScale,
            displayDimensionUnits[i],
            { precision: 2, elide1: false },
          );
          dimElements.scale.value = `${formattedScale}/${this.displayUnit}`;
          dimElements.scale.style.display = "";
        } else {
          dimElements.scale.value = "";
          dimElements.scale.style.display = "none";
        }
        dimElements.scaleFactor.value = formatScaleFactor(factors[dim]);
      }
      updateInputFieldWidth(dimElements.name);
      updateInputFieldWidth(dimElements.scaleFactor);
      updateInputFieldWidth(
        dimElements.scale,
        dimElements.scale.value.length + 1,
      );
    }
    // Update the FOV fields
    if (this.axes !== undefined) {
      const { width, height } = this.panelRenderViewport;
      for (let j = 0; j < 2; j++) {
        const i = Axis[this.axes[j] as keyof typeof Axis];
        const totalScale =
          (displayDimensionScales[i] * zoom) / canonicalVoxelFactors[i];
        const pixelResolution = j === 0 ? width : height;
        const fieldOfView = totalScale * pixelResolution;
        const formattedFieldOfView = formatScaleWithUnitAsString(
          fieldOfView,
          displayDimensionUnits[i],
          { precision: 3, elide1: false },
        );
        this.fovInputElements[j].value = formattedFieldOfView;
        updateInputFieldWidth(
          this.fovInputElements[j],
          formattedFieldOfView.length + 1,
        );
        this.fovNameElements[j].textContent = globalDimensionNames[i];
      }
    }
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
