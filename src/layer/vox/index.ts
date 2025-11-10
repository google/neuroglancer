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

import type { CoordinateTransformSpecification } from "#src/coordinate_transform.js";
import type { DataSourceSpecification } from "#src/datasource/index.js";
import { LocalDataSource, localVoxelAnnotationsUrl } from "#src/datasource/local.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { registerLayerType, registerLayerTypeDetector, UserLayer } from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { makeToolButton } from "#src/ui/tool.js";
import { PIXEL_TOOL_ID, VoxelPixelLegacyTool, registerVoxelAnnotationTools } from "#src/ui/voxel_annotations.js";
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

class VoxToolTab extends Tab {
  constructor(public layer: VoxUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-vox-tools-tab");
    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-vox-toolbox";
    const legacyButton = document.createElement("button");
    legacyButton.textContent = "Pixel (annotate)";
    legacyButton.title = "Select legacy pixel tool for ctrl+click annotate";
    legacyButton.addEventListener("click", () => {
      this.layer.tool.value = new VoxelPixelLegacyTool(this.layer);
    });
    toolbox.appendChild(legacyButton);
    element.appendChild(toolbox);
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
    this.tabs.add("vox_tools", {
      label: "Draw",
      order: 1,
      getter: () => new VoxToolTab(this),
    });
    this.tabs.default = "vox";
  }

  getLegacyDataSourceSpecifications(
    sourceSpec: string | undefined,
    layerSpec: any,
    legacyTransform: CoordinateTransformSpecification | undefined,
    explicitSpecs: DataSourceSpecification[],
  ): DataSourceSpecification[] {
    if (Object.prototype.hasOwnProperty.call(layerSpec, "source")) {
      // Respect explicit source definitions.
      return super.getLegacyDataSourceSpecifications(
        sourceSpec,
        layerSpec,
        legacyTransform,
        explicitSpecs,
      );
    }
    // Default to the special local voxel annotations data source.
    return [
      {
        url: localVoxelAnnotationsUrl,
        transform: legacyTransform,
        enableDefaultSubsources: true,
        subsources: new Map(),
      },
    ];
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>): void {
    for (const loadedSubsource of subsources) {
      const { subsourceEntry } = loadedSubsource;
      const { subsource } = subsourceEntry;
      if (subsource.local === LocalDataSource.voxelAnnotations) {
        // Accept this data source; no render layers yet.
        loadedSubsource.activate(() => {});
        continue;
      }
      loadedSubsource.deactivate(
        "Not compatible with vox layer; only local://voxel-annotations is supported",
      );
    }
  }
}

registerVoxelAnnotationTools();
registerLayerType(VoxUserLayer);
registerLayerTypeDetector((subsource) => {
  if (subsource.local === LocalDataSource.voxelAnnotations) {
    return { layerConstructor: VoxUserLayer, priority: 100 };
  }
  return undefined;
});
