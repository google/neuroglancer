/**
 * @license
 * Copyright 2016 Google Inc.
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

import CodeMirror from "codemirror";
import svgCode from "ikonate/icons/code-alt.svg?raw";
import "codemirror/addon/lint/lint.js";
import "#src/widget/shader_code_widget.css";
import "codemirror/lib/codemirror.css";
import "codemirror/addon/lint/lint.css";

import { debounce } from "lodash-es";
import type { UserLayer } from "#src/layer/index.js";
import type { Overlay } from "#src/overlay.js";
import glslCodeMirror from "#src/third_party/codemirror-glsl.js";
import {
  ElementVisibilityFromTrackableBoolean,
  type TrackableBoolean,
} from "#src/trackable_boolean.js";
import type { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeFromParent } from "#src/util/dom.js";
import type { WatchableShaderError } from "#src/webgl/dynamic_shader.js";
import type {
  ShaderCompilationError,
  ShaderLinkError,
} from "#src/webgl/shader.js";
import type {
  ShaderControlParseError,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";
import { CheckboxIcon } from "#src/widget/checkbox_icon.js";
import { makeHelpButton } from "#src/widget/help_button.js";
import { makeMaximizeButton } from "#src/widget/maximize_button.js";

// Install glsl support in CodeMirror.
glslCodeMirror(CodeMirror);

/**
 * Time in milliseconds during which the input field must not be modified before the shader is
 * recompiled.
 */
const SHADER_UPDATE_DELAY = 500;

interface ShaderCodeState {
  shaderError: WatchableShaderError;
  shaderControlState?: ShaderControlState;
  fragmentMain: WatchableValue<string>;
  sourceStringNumber?: number;
}

export class ShaderCodeWidget extends RefCounted {
  textEditor: CodeMirror.Editor;
  get element() {
    return this.textEditor.getWrapperElement();
  }
  private changingValue = false;
  private debouncedValueUpdater = debounce(() => {
    this.changingValue = true;
    try {
      this.state.fragmentMain.value = this.textEditor.getValue();
    } finally {
      this.changingValue = false;
    }
  }, SHADER_UPDATE_DELAY);

  constructor(public state: ShaderCodeState) {
    super();
    this.textEditor = CodeMirror((_element) => {}, {
      value: this.state.fragmentMain.value,
      mode: "glsl",
      gutters: ["CodeMirror-lint-markers"],
    });
    this.textEditor.on("change", () => {
      this.setValidState(undefined);
      this.debouncedValueUpdater();
    });
    this.registerDisposer(
      this.state.fragmentMain.changed.add(() => {
        if (!this.changingValue) {
          this.textEditor.setValue(this.state.fragmentMain.value);
        }
      }),
    );
    this.element.classList.add("neuroglancer-shader-code-widget");
    this.registerDisposer(
      this.state.shaderError.changed.add(() => {
        this.updateErrorState();
      }),
    );
    const { shaderControlState } = this.state;
    if (shaderControlState !== undefined) {
      this.registerDisposer(
        shaderControlState.parseErrors.changed.add(() => {
          this.updateErrorState();
        }),
      );
    }
    this.updateErrorState();
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((x) => x.isIntersecting)) {
          this.textEditor.refresh();
        }
      },
      {
        root: document.body,
      },
    );
    intersectionObserver.observe(this.element);
    this.registerDisposer(() => intersectionObserver.disconnect());
  }

  updateErrorState() {
    const { sourceStringNumber = 1 } = this.state;
    const error = this.state.shaderError.value;
    let controlParseErrors: ShaderControlParseError[];
    const { shaderControlState } = this.state;
    if (shaderControlState !== undefined) {
      controlParseErrors = shaderControlState.parseErrors.value;
    } else {
      controlParseErrors = [];
    }
    if (error === undefined && controlParseErrors.length === 0) {
      this.setValidState(undefined);
    } else if (error != null || controlParseErrors.length !== 0) {
      this.textEditor.setOption("lint", {
        getAnnotations: () => {
          const annotations = [];
          for (const e of controlParseErrors) {
            annotations.push({
              message: e.message,
              severity: "error",
              from: CodeMirror.Pos(e.line),
            });
          }
          if (error != null) {
            if (error.name === "ShaderCompilationError") {
              for (const e of (error as ShaderCompilationError).errorMessages) {
                annotations.push({
                  message: e.message,
                  severity: "error",
                  from: CodeMirror.Pos(
                    e.file === sourceStringNumber ? e.line || 0 : 0,
                  ),
                });
              }
            } else if (error!.name === "ShaderLinkError") {
              annotations.push({
                message: (<ShaderLinkError>error).log,
                severity: "error",
                from: CodeMirror.Pos(0),
              });
            } else {
              annotations.push({
                message: error!.message,
                severity: "error",
                from: CodeMirror.Pos(0),
              });
            }
          }
          return annotations;
        },
      });
      this.setValidState(false);
    } else {
      this.textEditor.setOption("lint", undefined);
      this.setValidState(true);
    }
  }

  setValidState(valid?: boolean) {
    const { element } = this;
    element.classList.remove("invalid-input");
    element.classList.remove("valid-input");
    if (valid === true) {
      element.classList.add("valid-input");
    } else if (valid === false) {
      element.classList.add("invalid-input");
    }
  }

  disposed() {
    (<{ flush?: () => void }>this.debouncedValueUpdater).flush!();
    this.debouncedValueUpdater = <any>undefined;
    removeFromParent(this.element);
    this.textEditor = <any>undefined;
    super.disposed();
  }
}

type UserLayerWithCodeEditor = UserLayer & { codeVisible: TrackableBoolean };
type ShaderCodeOverlayConstructor<T extends Overlay> = new (
  layer: UserLayerWithCodeEditor,
) => T;

export function makeShaderCodeWidgetTopRow<T extends Overlay>(
  layer: UserLayerWithCodeEditor,
  codeWidget: ShaderCodeWidget,
  ShaderCodeOverlay: ShaderCodeOverlayConstructor<T>,
  help: {
    title: string;
    href: string;
  },
  className: string,
) {
  const spacer = document.createElement("div");
  spacer.style.flex = "1";

  const topRow = document.createElement("div");
  topRow.className = className;
  topRow.appendChild(document.createTextNode("Shader"));
  topRow.appendChild(spacer);

  layer.registerDisposer(
    new ElementVisibilityFromTrackableBoolean(
      layer.codeVisible,
      codeWidget.element,
    ),
  );

  const codeVisibilityControl = new CheckboxIcon(layer.codeVisible, {
    enableTitle: "Show code",
    disableTitle: "Hide code",
    backgroundScheme: "dark",
    svg: svgCode,
  });
  topRow.appendChild(codeVisibilityControl.element);

  topRow.appendChild(
    makeMaximizeButton({
      title: "Show larger editor view",
      onClick: () => {
        new ShaderCodeOverlay(layer);
      },
    }),
  );
  topRow.appendChild(makeHelpButton(help));
  return topRow;
}
