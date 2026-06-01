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

import { debounce } from "lodash-es";
import type { DisplayContext } from "#src/display_context.js";
import type { UserLayer, UserLayerConstructor } from "#src/layer/index.js";
import { TrackableBooleanCheckbox } from "#src/trackable_boolean.js";
import { registerTool } from "#src/ui/tool.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import { verifyObjectProperty, verifyString } from "#src/util/json.js";
import type { AnyConstructor } from "#src/util/mixin.js";
import type { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";
import type {
  ParameterizedEmitterDependentShaderOptions,
  ParameterizedShaderGetterResult,
} from "#src/webgl/dynamic_shader.js";
import type { ShaderControlState } from "#src/webgl/shader_ui_controls.js";
import type {
  LayerControlDefinition,
  LayerControlFactory,
} from "#src/widget/layer_control.js";
import {
  addLayerControlToOptionsTab,
  LayerControlTool,
} from "#src/widget/layer_control.js";
import { channelInvlerpLayerControl } from "#src/widget/layer_control_channel_invlerp.js";
import { checkboxLayerControl } from "#src/widget/layer_control_checkbox.js";
import { colorLayerControl } from "#src/widget/layer_control_color.js";
import { propertyInvlerpLayerControl } from "#src/widget/layer_control_property_invlerp.js";
import { rangeLayerControl } from "#src/widget/layer_control_range.js";
import { Tab } from "#src/widget/tab_view.js";
import { transferFunctionLayerControl } from "#src/widget/transfer_function.js";

export interface LegendShaderOptions
  extends ParameterizedEmitterDependentShaderOptions {
  initializeShader: (shaderResult: ParameterizedShaderGetterResult) => void;
}

export interface ShaderControlsOptions {
  legendShaderOptions?: LegendShaderOptions;
  visibility?: WatchableVisibilityPriority;
  toolId?: string;
}

function getShaderLayerControlFactory<LayerType extends UserLayer>(
  layerShaderControls: LayerShaderControls,
  controlId: string,
): LayerControlFactory<LayerType> | undefined {
  const { shaderControlState } = layerShaderControls;
  const controlState = shaderControlState.state.get(controlId);
  if (controlState === undefined) return undefined;
  const { control } = controlState;
  switch (control.type) {
    case "slider":
      return rangeLayerControl(() => ({
        value: controlState.trackable,
        options: { min: control.min, max: control.max, step: control.step },
      }));
    case "color":
      return colorLayerControl(() => controlState.trackable);
    case "checkbox":
      return checkboxLayerControl(() => controlState.trackable);
    case "imageInvlerp": {
      return channelInvlerpLayerControl(() => ({
        dataType: control.dataType,
        defaultChannel: control.default.channel,
        watchableValue: controlState.trackable,
        channelCoordinateSpaceCombiner:
          shaderControlState.channelCoordinateSpaceCombiner,
        histogramSpecifications: shaderControlState.histogramSpecifications,
        histogramIndex: calculateHistogramIndex(),
        legendShaderOptions: layerShaderControls.legendShaderOptions,
      }));
    }
    case "propertyInvlerp": {
      return propertyInvlerpLayerControl(() => ({
        properties: control.properties,
        watchableValue: controlState.trackable,
        histogramSpecifications: shaderControlState.histogramSpecifications,
        histogramIndex: calculateHistogramIndex(),
        legendShaderOptions: layerShaderControls.legendShaderOptions,
      }));
    }
    case "transferFunction": {
      return transferFunctionLayerControl(() => ({
        dataType: control.dataType,
        watchableValue: controlState.trackable,
        channelCoordinateSpaceCombiner:
          shaderControlState.channelCoordinateSpaceCombiner,
        defaultChannel: control.default.channel,
        histogramSpecifications: shaderControlState.histogramSpecifications,
        histogramIndex: calculateHistogramIndex(),
      }));
    }
  }

  function calculateHistogramIndex(controlType: string = control.type) {
    const isMatchingControlType = (otherControlType: string) => {
      if (
        controlType === "imageInvlerp" ||
        controlType === "transferFunction"
      ) {
        return (
          otherControlType === "imageInvlerp" ||
          otherControlType === "transferFunction"
        );
      } else if (controlType === "propertyInvlerp") {
        return otherControlType === "propertyInvlerp";
      } else {
        throw new Error(`${controlType} does not support histogram index.`);
      }
    };
    let histogramIndex = 0;
    for (const [
      otherName,
      {
        control: { type: otherType },
      },
    ] of shaderControlState.state) {
      if (otherName === controlId) break;
      if (isMatchingControlType(otherType)) histogramIndex++;
    }
    return histogramIndex;
  }
}

function getShaderLayerControlDefinition<LayerType extends UserLayer>(
  getter: (layer: LayerType) => LayerShaderControls,
  toolId: string,
  controlId: string,
): LayerControlDefinition<LayerType> {
  return {
    label: controlId,
    toolJson: shaderControlToolJson(controlId, toolId),
    makeControl: (layer, context, options) => {
      const layerShaderControls = getter(layer);
      return getShaderLayerControlFactory(
        layerShaderControls,
        controlId,
      )!.makeControl(layer, context, options);
    },
    activateTool: (activation, control) => {
      const layerShaderControls = getter(activation.tool.layer);
      return getShaderLayerControlFactory(
        layerShaderControls,
        controlId,
      )!.activateTool(activation, control);
    },
  };
}

export class ShaderControls extends Tab {
  private controlDisposer: RefCounted | undefined = undefined;
  private controlsContainer: HTMLDivElement;
  private hiddenCountElement: HTMLSpanElement;
  private toolId: string;
  constructor(
    public state: ShaderControlState,
    public display: DisplayContext,
    public layer: UserLayer,
    public options: ShaderControlsOptions = {},
  ) {
    super(options.visibility);
    const { toolId = SHADER_CONTROL_TOOL_ID } = options;
    this.toolId = toolId;
    const { element } = this;
    element.style.display = "contents";

    // Header row with the "Hide inactive controls" toggle. Built once and
    // never torn down by `updateControls()`, so its UI state is stable
    // across shader recompiles.
    const header = document.createElement("label");
    header.className = "neuroglancer-shader-controls-hide-inactive";
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "4px";
    header.style.fontSize = "smaller";
    const checkbox = this.registerDisposer(
      new TrackableBooleanCheckbox(state.hideInactiveControls, {
        enabledTitle:
          "Show all #uicontrols (including ones with no effect on the current render).",
        disabledTitle:
          "Hide #uicontrols whose uniforms are eliminated by the GLSL compiler" +
          " for the current shader (e.g. controls only referenced inside an" +
          " `if (checkbox)` branch that's currently false).",
      }),
    );
    header.appendChild(checkbox.element);
    header.appendChild(document.createTextNode("Hide inactive controls"));
    // Trailing "(X hidden)" annotation, updated by `updateControls()`.
    const hiddenCountElement = (this.hiddenCountElement =
      document.createElement("span"));
    hiddenCountElement.className =
      "neuroglancer-shader-controls-hidden-count";
    header.appendChild(hiddenCountElement);
    element.appendChild(header);

    // Separate container so the rebuild loop only tears down the controls,
    // not the header.
    const controlsContainer = (this.controlsContainer =
      document.createElement("div"));
    controlsContainer.style.display = "contents";
    element.appendChild(controlsContainer);

    const { controls } = state;
    const scheduleUpdate = this.registerCancellable(
      debounce(() => this.updateControls(), 0),
    );
    this.registerDisposer(controls.changed.add(scheduleUpdate));
    this.registerDisposer(state.activeControls.changed.add(scheduleUpdate));
    this.registerDisposer(
      state.hideInactiveControls.changed.add(scheduleUpdate),
    );
    this.updateControls();
  }

  updateControls() {
    const container = this.controlsContainer;
    if (this.controlDisposer !== undefined) {
      this.controlDisposer.dispose();
      removeChildren(container);
    }
    const controlDisposer = (this.controlDisposer = new RefCounted());
    const layerShaderControlsGetter = () => ({
      shaderControlState: this.state,
      legendShaderOptions: this.options.legendShaderOptions,
    });
    const hideInactive = this.state.hideInactiveControls.value;
    const activeControls = this.state.activeControls.value;
    let hiddenCount = 0;
    for (const name of this.state.state.keys()) {
      // Skip when the user has opted in and we have a known active set
      // (computed from the last linked shader) that does not include `name`.
      // `activeControls === undefined` means we haven't rendered yet; show
      // everything in that case to avoid hiding controls prematurely.
      if (
        hideInactive &&
        activeControls !== undefined &&
        !activeControls.has(name)
      ) {
        ++hiddenCount;
        continue;
      }
      container.appendChild(
        addLayerControlToOptionsTab(
          controlDisposer,
          this.layer,
          this.visibility,
          getShaderLayerControlDefinition(
            layerShaderControlsGetter,
            this.toolId,
            name,
          ),
        ),
      );
    }
    this.hiddenCountElement.textContent =
      hiddenCount > 0 ? ` (${hiddenCount} hidden)` : "";
  }

  disposed() {
    this.controlDisposer?.dispose();
    super.disposed();
  }
}

interface LayerShaderControls {
  shaderControlState: ShaderControlState;
  legendShaderOptions?: LegendShaderOptions;
}

export const SHADER_CONTROL_TOOL_ID = "shaderControl";
const CONTROL_JSON_KEY = "control";

function shaderControlToolJson(control: string, toolId: string) {
  return { type: toolId, [CONTROL_JSON_KEY]: control };
}

class ShaderControlTool extends LayerControlTool {
  constructor(
    layer: UserLayer,
    private layerShaderControls: LayerShaderControls,
    toolId: string,
    private control: string,
  ) {
    super(
      layer,
      getShaderLayerControlDefinition(
        () => layerShaderControls,
        toolId,
        control,
      ),
    );
    const debounceCheckValidity = this.registerCancellable(
      debounce(() => {
        if (
          layerShaderControls.shaderControlState.state.get(control) ===
          undefined
        ) {
          this.unbind();
        }
      }),
    );
    this.registerDisposer(
      layerShaderControls.shaderControlState.controls.changed.add(
        debounceCheckValidity,
      ),
    );
  }

  isLoading() {
    const { shaderControlState } = this.layerShaderControls;
    const controlState = shaderControlState.state.get(this.control);
    return controlState === undefined;
  }
}

export function registerLayerShaderControlsTool<LayerType extends UserLayer>(
  layerType: UserLayerConstructor & AnyConstructor<LayerType>,
  getter: (layer: LayerType) => LayerShaderControls,
  toolId: string = SHADER_CONTROL_TOOL_ID,
) {
  registerTool(
    layerType,
    toolId,
    (layer, options) => {
      const control = verifyObjectProperty(
        options,
        CONTROL_JSON_KEY,
        verifyString,
      );
      return new ShaderControlTool(layer, getter(layer), toolId, control);
    },
    (layer, onChange) => {
      const layerShaderControls = getter(layer);
      const { shaderControlState } = layerShaderControls;
      if (onChange !== undefined) {
        shaderControlState.controls.changed.addOnce(onChange);
      }
      const map = shaderControlState.state;
      return Array.from(map.keys(), (key) => ({
        type: SHADER_CONTROL_TOOL_ID,
        [CONTROL_JSON_KEY]: key,
      }));
    },
  );
}
