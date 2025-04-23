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

import "#src/layer/single_mesh/style.css";

import type { ManagedUserLayer } from "#src/layer/index.js";
import {
  registerLayerType,
  registerLayerTypeDetector,
  UserLayer,
} from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { Overlay } from "#src/overlay.js";
import type { VertexAttributeInfo } from "#src/single_mesh/base.js";
import {
  getShaderAttributeType,
  pickAttributeNames,
  SingleMeshDisplayState,
  SingleMeshLayer,
} from "#src/single_mesh/frontend.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren, removeFromParent } from "#src/util/dom.js";
import {
  makeShaderCodeWidgetTopRow,
  ShaderCodeWidget,
} from "#src/widget/shader_code_widget.js";
import {
  registerLayerShaderControlsTool,
  ShaderControls,
} from "#src/widget/shader_controls.js";
import { Tab } from "#src/widget/tab_view.js";

const SHADER_JSON_KEY = "shader";
const SHADER_CONTROLS_JSON_KEY = "shaderControls";
const CODE_VISIBLE_KEY = "codeVisible";

export class SingleMeshUserLayer extends UserLayer {
  displayState = new SingleMeshDisplayState();
  codeVisible = new TrackableBoolean(true);

  vertexAttributes = new WatchableValue<VertexAttributeInfo[] | undefined>(
    undefined,
  );
  constructor(public managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.codeVisible.changed.add(this.specificationChanged.dispatch);
    this.registerDisposer(
      this.displayState.shaderControlState.changed.add(
        this.specificationChanged.dispatch,
      ),
    );
    this.registerDisposer(
      this.displayState.fragmentMain.changed.add(
        this.specificationChanged.dispatch,
      ),
    );
    this.tabs.add("rendering", {
      label: "Rendering",
      order: -100,
      getter: () => new DisplayOptionsTab(this),
    });
    this.tabs.default = "rendering";
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.codeVisible.restoreState(specification[CODE_VISIBLE_KEY]);
    this.displayState.fragmentMain.restoreState(specification[SHADER_JSON_KEY]);
    this.displayState.shaderControlState.restoreState(
      specification[SHADER_CONTROLS_JSON_KEY],
    );
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    let hasSource = false;
    for (const loadedSubsource of subsources) {
      const { subsourceEntry } = loadedSubsource;
      const { subsource } = subsourceEntry;
      const { singleMesh } = subsource;
      if (singleMesh !== undefined) {
        if (hasSource) {
          loadedSubsource.deactivate("Only one single-mesh source supported");
          continue;
        }
        hasSource = true;
        loadedSubsource.activate((refCounted) => {
          loadedSubsource.addRenderLayer(
            new SingleMeshLayer(
              singleMesh,
              this.displayState,
              loadedSubsource.getRenderLayerTransform(),
            ),
          );
          this.vertexAttributes.value = singleMesh.info.vertexAttributes;
          refCounted.registerDisposer(() => {
            this.vertexAttributes.value = undefined;
          });
        });
        continue;
      }
      loadedSubsource.deactivate("Not compatible with image layer");
    }
  }

  toJSON() {
    const x = super.toJSON();
    x[SHADER_JSON_KEY] = this.displayState.fragmentMain.toJSON();
    x[SHADER_CONTROLS_JSON_KEY] = this.displayState.shaderControlState.toJSON();
    x[CODE_VISIBLE_KEY] = this.codeVisible.toJSON();
    return x;
  }

  static type = "mesh";
  static typeAbbreviation = "msh";
}

function makeShaderCodeWidget(layer: SingleMeshUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.fragmentMain,
    shaderError: layer.displayState.shaderError,
    shaderControlState: layer.displayState.shaderControlState,
  });
}

class VertexAttributeWidget extends RefCounted {
  element = document.createElement("div");
  constructor(
    public attributes: WatchableValueInterface<
      VertexAttributeInfo[] | undefined
    >,
  ) {
    super();
    this.element.className = "neuroglancer-single-mesh-attribute-widget";
    this.updateView();
    this.registerDisposer(
      attributes.changed.add(() => {
        this.updateView();
      }),
    );
  }

  private updateView() {
    const { element } = this;
    const attributeInfo = this.attributes.value;
    if (attributeInfo === undefined) {
      removeChildren(element);
      return;
    }
    const attributeNames = pickAttributeNames(attributeInfo.map((a) => a.name));
    const numAttributes = attributeInfo.length;
    for (let i = 0; i < numAttributes; ++i) {
      const info = attributeInfo[i];
      const div = document.createElement("div");
      div.className = "neuroglancer-single-mesh-attribute";
      const typeElement = document.createElement("div");
      typeElement.className = "neuroglancer-single-mesh-attribute-type";
      typeElement.textContent = getShaderAttributeType(info);
      const nameElement = document.createElement("div");
      nameElement.className = "neuroglancer-single-mesh-attribute-name";
      nameElement.textContent = attributeNames[i];
      div.appendChild(typeElement);
      div.appendChild(nameElement);
      if (info.min !== undefined && info.max !== undefined) {
        const minMaxElement = document.createElement(
          "neuroglancer-single-mesh-attribute-minmax",
        );
        minMaxElement.className = "neuroglancer-single-mesh-attribute-range";
        minMaxElement.textContent = `[${info.min.toPrecision(
          6,
        )}, ${info.max.toPrecision(6)}]`;
        div.appendChild(minMaxElement);
      }
      element.appendChild(div);
    }
  }

  disposed() {
    removeFromParent(this.element);
  }
}

function makeVertexAttributeWidget(layer: SingleMeshUserLayer) {
  return new VertexAttributeWidget(layer.vertexAttributes);
}

class DisplayOptionsTab extends Tab {
  attributeWidget: VertexAttributeWidget;
  codeWidget: ShaderCodeWidget;

  constructor(public layer: SingleMeshUserLayer) {
    super();
    const { element } = this;
    this.attributeWidget = this.registerDisposer(
      makeVertexAttributeWidget(layer),
    );
    this.codeWidget = this.registerDisposer(makeShaderCodeWidget(layer));
    element.classList.add("neuroglancer-single-mesh-dropdown");
    element.appendChild(
      makeShaderCodeWidgetTopRow(
        this.layer,
        this.codeWidget,
        ShaderCodeOverlay,
        {
          title: "Documentation on image layer rendering",
          href: "https://github.com/google/neuroglancer/blob/master/src/sliceview/image_layer_rendering.md",
        },
        "neuroglancer-single-mesh-dropdown-top-row",
      ),
    );
    element.appendChild(this.attributeWidget.element);
    element.appendChild(this.codeWidget.element);
    element.appendChild(
      this.registerDisposer(
        new ShaderControls(
          layer.displayState.shaderControlState,
          this.layer.manager.root.display,
          this.layer,
          { visibility: this.visibility },
        ),
      ).element,
    );
  }
}

class ShaderCodeOverlay extends Overlay {
  attributeWidget: VertexAttributeWidget;
  codeWidget: ShaderCodeWidget;
  constructor(public layer: SingleMeshUserLayer) {
    super();
    this.attributeWidget = this.registerDisposer(
      makeVertexAttributeWidget(layer),
    );
    this.codeWidget = this.registerDisposer(makeShaderCodeWidget(layer));
    this.content.classList.add("neuroglancer-single-mesh-layer-shader-overlay");
    this.content.appendChild(this.attributeWidget.element);
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType(SingleMeshUserLayer);
registerLayerTypeDetector((subsource) => {
  if (subsource.singleMesh !== undefined) {
    return { layerConstructor: SingleMeshUserLayer, priority: 2 };
  }
  return undefined;
});

registerLayerShaderControlsTool(SingleMeshUserLayer, (layer) => ({
  shaderControlState: layer.displayState.shaderControlState,
}));
