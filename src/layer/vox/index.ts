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
import { makeCoordinateSpace, makeIdentityTransform, WatchableCoordinateSpaceTransform } from "#src/coordinate_transform.js";
import type { DataSourceSpecification } from "#src/datasource/index.js";
import { LocalDataSource, localVoxelAnnotationsUrl } from "#src/datasource/local.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { registerLayerType, registerLayerTypeDetector, UserLayer } from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { getWatchableRenderLayerTransform } from "#src/render_coordinate_transform.js";
import { RenderScaleHistogram, trackableRenderScaleTarget } from "#src/render_scale_statistics.js";
import { VoxelPixelLegacyTool, registerVoxelAnnotationTools } from "#src/ui/voxel_annotations.js";
import type { Borrowed } from "#src/util/disposable.js";
import { DummyMultiscaleVolumeChunkSource } from "#src/voxel_annotation/dummy_volume_chunk_source.js";
import { VoxelAnnotationRenderLayer } from "#src/voxel_annotation/renderlayer.js";
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
    legacyButton.textContent = "Pixel";
    legacyButton.title = "ctrl+click to paint a pixel";
    legacyButton.addEventListener("click", () => {
      this.layer.tool.value = new VoxelPixelLegacyTool(this.layer);
    });
    toolbox.appendChild(legacyButton);
    element.appendChild(toolbox);
  }
}


export class VoxUserLayer extends UserLayer {
  // Match Image/Segmentation layers: provide a per-layer cross-section render scale target/histogram.
  sliceViewRenderScaleHistogram = new RenderScaleHistogram();
  sliceViewRenderScaleTarget = trackableRenderScaleTarget(1);
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
        loadedSubsource.activate(() => {
          console.log('Activating voxel annotation data subsource.');
          const dummySource = new DummyMultiscaleVolumeChunkSource(
            this.manager.chunkManager,
          );
          loadedSubsource.addRenderLayer(
            new VoxelAnnotationRenderLayer(
              dummySource,
              {
                // IMPORTANT: Use an explicit 3D identity model transform, then convert it to a
                // WatchableRenderLayerTransform. In this project, relying on the subsource-provided
                // transform for local://voxel-annotations can yield a rank-0/ambiguous mapping and
                // hide the chunk sources, meaning the checkerboard shader is never invoked. The
                // identity 3D model space ensures proper detection and visibility of our dummy
                // volume chunks while still integrating with global/local spaces.
                transform: ((): any => {
                  const identity3D = new WatchableCoordinateSpaceTransform(
                    makeIdentityTransform(
                      makeCoordinateSpace({
                        rank: 3,
                        names: ["x", "y", "z"],
                        units: ["", "", ""],
                        scales: new Float64Array([0.000001, 0.000001, 0.000001]),
                      }),
                    ),
                  );
                  return getWatchableRenderLayerTransform(
                    this.manager.root.coordinateSpace,
                    this.localPosition.coordinateSpace,
                    identity3D,
                    undefined,
                  );
                })(),
                renderScaleTarget: this.sliceViewRenderScaleTarget,
                renderScaleHistogram: undefined,
                localPosition: this.localPosition,
              } as any,
            ),
          );
        });
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
