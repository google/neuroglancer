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

import "#src/ui/shader_code_dialog.css";
import type { UserLayer } from "#src/layer/index.js";
import type { VertexAttributeWidget } from "#src/layer/single_mesh/index.js";
import { FramedDialog } from "#src/overlay.js";
import type { ShaderCodeWidget } from "#src/widget/shader_code_widget.js";

export class ShaderCodeEditorDialog extends FramedDialog {
  constructor(
    public layer: UserLayer,
    private makeShaderCodeWidget: (layer: UserLayer) => ShaderCodeWidget,
    title: string = "Shader editor",
    makeVertexAttributeWidget?: (layer: UserLayer) => VertexAttributeWidget,
  ) {
    super(title, "Close editor", "neuroglancer-shader-code-editor-dialog");

    const codeWidget = this.registerDisposer(
      this.makeShaderCodeWidget(this.layer),
    );
    if (makeVertexAttributeWidget) {
      const attributeWidget = this.registerDisposer(
        makeVertexAttributeWidget(this.layer),
      );
      this.body.appendChild(attributeWidget.element);
    }
    this.body.appendChild(codeWidget.element);

    codeWidget.textEditor.refresh();
  }
}
