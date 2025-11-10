/**
 * @license
 * Copyright 2025.
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

import type { ManagedUserLayer } from "#src/layer/index.js";
import { registerLayerType, UserLayer } from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import type { Borrowed } from "#src/util/disposable.js";
import { Tab } from "#src/widget/tab_view.js";

class VoxHelloTab extends Tab {
  constructor() {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-vox-hello-tab");
    element.textContent = "Hello world";
  }
}

export class VoxUserLayer extends UserLayer {
  static type = "vox";
  static typeAbbreviation = "vox";

  constructor(managedLayer: Borrowed<ManagedUserLayer>) {
    super(managedLayer);
    this.tabs.add("vox", {
      label: "Voxel",
      order: 0,
      getter: () => new VoxHelloTab(),
    });
    this.tabs.default = "vox";
  }

  // For now, this layer does not consume data sources.
  activateDataSubsources(_subsources: Iterable<LoadedDataSubsource>): void {
    // No-op: voxel annotation UI only (initial stub).
    for (const sub of _subsources) {
      // Disable all subsources as not compatible (stub layer for now).
      sub.deactivate("Not compatible with vox layer (stub)");
    }
  }
}

registerLayerType(VoxUserLayer);
