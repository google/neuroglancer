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

import "#src/widget/layer_type_indicator.css";
import { layerTypes, type ManagedUserLayer } from "#src/layer/index.js";
import { RefCounted } from "#src/util/disposable.js";

function capitalizeFirstLetter(type: string): string {
  return type ? type[0].toUpperCase() + type.slice(1) : "";
}

export class LayerTypeIndicatorWidget extends RefCounted {
  element = document.createElement("div");
  constructor(public layer: ManagedUserLayer) {
    super();
    this.element.classList.add("neuroglancer-layer-type-indicator");
    this.registerDisposer(layer.layerChanged.add(() => this.updateView()));
    this.updateView();
  }
  updateView() {
    const layerType = this.layer.layer?.type ?? "unknown";
    this.element.textContent =
      layerTypes.get(layerType)?.typeAbbreviation ?? "—";
    this.element.title = `${capitalizeFirstLetter(layerType)} layer (modifiable in the layer settings)`;
  }
}
