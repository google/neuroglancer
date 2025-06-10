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
import svg_close from "ikonate/icons/close.svg?raw";
import type { UserLayer } from "#src/layer/index.js";
import type { VertexAttributeWidget } from "#src/layer/single_mesh/index.js";
import { Overlay } from "#src/overlay.js";
import { makeIcon } from "#src/widget/icon.js";
import type { ShaderCodeWidget } from "#src/widget/shader_code_widget.js";

export class CodeEditorDialog extends Overlay {
  header: HTMLDivElement;
  body: HTMLDivElement;
  footer: HTMLDivElement;
  constructor(title: string = "Code editor") {
    super();
    this.content.classList.add("neuroglancer-code-editor-dialog");

    const header = (this.header = document.createElement("div"));
    const closeMenuIcon = makeIcon({ svg: svg_close });
    closeMenuIcon.addEventListener("click", () => this.close());
    closeMenuIcon.classList.add("neuroglancer-code-editor-dialog-close-icon");
    const titleText = document.createElement("p");
    titleText.textContent = title;
    titleText.classList.add("neuroglancer-code-editor-dialog-title");
    header.classList.add("neuroglancer-code-editor-dialog-header");
    header.appendChild(titleText);
    header.appendChild(closeMenuIcon);
    this.content.appendChild(header);

    const body = (this.body = document.createElement("div"));
    body.classList.add("neuroglancer-code-editor-dialog-body");
    this.content.appendChild(body);

    const footer = (this.footer = document.createElement("div"));
    footer.classList.add("neuroglancer-code-editor-dialog-footer");
    this.content.appendChild(this.footer);
  }
}

export class ShaderCodeEditorDialog extends CodeEditorDialog {
  footerActionsBtnContainer: HTMLDivElement;
  footerBtnsWrapper: HTMLDivElement;
  constructor(
    public layer: UserLayer,
    private makeShaderCodeWidget: (layer: UserLayer) => ShaderCodeWidget,
    title: string = "Shader editor",
    makeVertexAttributeWidget?: (layer: UserLayer) => VertexAttributeWidget,
  ) {
    super(title);

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

    const closeButton = document.createElement("button");
    closeButton.classList.add(
      "neuroglancer-shader-code-editor-dialog-close-button",
    );
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => this.close());
    this.footer.appendChild(closeButton);

    codeWidget.textEditor.refresh();
  }
}
