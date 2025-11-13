/**
 * @license
 * Copyright 2025 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may not use this file except in compliance with the License.
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  CreateDataSourceOptions,
  CommonCreationMetadata,
  DataSourceCreationState,
} from "#src/datasource/index.js";
import type { LayerListSpecification } from "#src/layer/index.js";
import { Overlay } from "#src/overlay.js";
import { StatusMessage } from "#src/status.js";
import { TrackableValue } from "#src/trackable_value.js";
import { TrackableVec3 } from "#src/trackable_vec3.js";
import { DataType } from "#src/util/data_type.js";
import { removeChildren } from "#src/util/dom.js";
import { vec3 } from "#src/util/geom.js";
import { verifyInt, verifyString } from "#src/util/json.js";
import { CompoundTrackable, type Trackable } from "#src/util/trackable.js";
import { TrackableEnum } from "#src/util/trackable_enum.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { EnumSelectWidget } from "#src/widget/enum_widget.js";
import { NumberInputWidget } from "#src/widget/number_input_widget.js";
import { TextInputWidget } from "#src/widget/text_input.js";
import { Vec3Widget } from "#src/widget/vec3_entry_widget.js";

function createControlForTrackable(trackable: Trackable): HTMLElement {
  if (trackable instanceof TrackableVec3) {
    return new Vec3Widget(trackable).element;
  }
  if (trackable instanceof TrackableEnum) {
    return new EnumSelectWidget(trackable).element;
  }
  if (trackable instanceof TrackableValue) {
    const value = trackable.value;
    if (typeof value === "number") {
      return new NumberInputWidget(trackable as TrackableValue<number>).element;
    }
    if (typeof value === "string") {
      return new TextInputWidget(trackable as TrackableValue<string>).element;
    }
  }
  const unsupportedElement = document.createElement("div");
  unsupportedElement.textContent = `Unsupported control type`;
  return unsupportedElement;
}

class CommonMetadataState extends CompoundTrackable {
  shape = new TrackableVec3(
    vec3.fromValues(42000, 42000, 42000),
    vec3.fromValues(42000, 42000, 42000),
  );
  dataType = new TrackableEnum(DataType, DataType.UINT32);
  voxelSize = new TrackableVec3(
    vec3.fromValues(8, 8, 8),
    vec3.fromValues(8, 8, 8),
  );
  voxelUnit = new TrackableValue<string>("nm", verifyString);
  numScales = new TrackableValue<number>(6, verifyInt);
  downsamplingFactor = new TrackableVec3(
    vec3.fromValues(2, 2, 2),
    vec3.fromValues(2, 2, 2),
  );
  name = new TrackableValue<string>("new-dataset", verifyString);

  constructor() {
    super();
    this.add("shape", this.shape);
    this.add("dataType", this.dataType);
    this.add("voxelSize", this.voxelSize);
    this.add("voxelUnit", this.voxelUnit);
    this.add("numScales", this.numScales);
    this.add("downsamplingFactor", this.downsamplingFactor);
    this.add("name", this.name);
  }

  toJSON(): CommonCreationMetadata {
    return {
      shape: Array.from(this.shape.value),
      dataType: this.dataType.value,
      voxelSize: Array.from(this.voxelSize.value),
      voxelUnit: this.voxelUnit.value,
      numScales: this.numScales.value,
      downsamplingFactor: Array.from(this.downsamplingFactor.value),
      name: this.name.value,
    };
  }

  restoreState(_obj: any) {}
  reset() {}
}

export class DatasetCreationDialog extends Overlay {
  state = new CommonMetadataState();
  dataSourceType = new TrackableValue<string>("", verifyString);
  private dataSourceOptions: DataSourceCreationState | undefined;

  addControl = (trackable: Trackable, label: string, parent: HTMLElement) => {
    const container = document.createElement("div");
    container.style.display = "flex";
    const labelElement = document.createElement("label");
    labelElement.textContent = label + ": ";
    container.appendChild(labelElement);
    const ctrl = createControlForTrackable(trackable);
    const ctrlContainer = document.createElement("div");
    ctrlContainer.style.display = "flex";
    ctrlContainer.style.flexGrow = "1";
    ctrlContainer.style.justifyContent = "flex-end";
    ctrlContainer.appendChild(ctrl);
    container.appendChild(ctrlContainer);
    parent.appendChild(container);
  };

  constructor(
    public manager: LayerListSpecification,
    public url: string,
  ) {
    super();

    const { content } = this;

    const titleElement = document.createElement("h2");
    titleElement.textContent = "Create New Dataset";
    content.appendChild(titleElement);

    const topControls = document.createElement("div");
    topControls.style.display = "flex";
    topControls.style.flexDirection = "column";

    content.appendChild(topControls);

    const dataSourceSelect = document.createElement("select");
    const creatableProviders = Array.from(
      this.manager.dataSourceProviderRegistry.kvStoreBasedDataSources.values(),
    ).filter((p) => p.creationState !== undefined);

    creatableProviders.forEach((p) => {
      const option = document.createElement("option");
      option.value = p.scheme;
      option.textContent = p.description || p.scheme;
      dataSourceSelect.appendChild(option);
    });

    if (creatableProviders.length > 0) {
      this.dataSourceType.value = creatableProviders[0].scheme;
    } else {
      const noProviderMessage = document.createElement("div");
      noProviderMessage.textContent =
        "No creatable data source types are configured.";
      content.appendChild(noProviderMessage);
    }

    const dsLabel = document.createElement("label");
    dsLabel.textContent = "Data Source Type: ";
    topControls.appendChild(dsLabel);
    topControls.appendChild(dataSourceSelect);

    this.registerEventListener(dataSourceSelect, "change", () => {
      this.dataSourceType.value = dataSourceSelect.value;
    });

    topControls.appendChild(
      this.registerDisposer(
        new DependentViewWidget(
          {
            changed: this.manager.rootLayers.layersChanged,
            get value() {
              return null;
            },
          },
          (_value, parentElement) => {
            const compatibleLayers =
              this.manager.rootLayers.managedLayers.filter(
                (layer) => layer.getCreationMetadata() !== undefined,
              );
            if (compatibleLayers.length === 0) return;

            const label = document.createElement("label");
            label.textContent = "Copy settings from layer: ";
            parentElement.appendChild(label);

            const select = document.createElement("select");
            const defaultOption = document.createElement("option");
            defaultOption.textContent = "None";
            defaultOption.value = "";
            select.appendChild(defaultOption);

            compatibleLayers.forEach((layer) => {
              const option = document.createElement("option");
              option.textContent = layer.name;
              option.value = layer.name;
              select.appendChild(option);
            });

            this.registerEventListener(select, "change", () => {
              if (!select.value) return;
              const layer = this.manager.rootLayers.getLayerByName(
                select.value,
              );
              if (layer) {
                const metadata = layer.getCreationMetadata();
                if (metadata) {
                  this.state.shape.value = vec3.fromValues(
                    metadata.shape[0],
                    metadata.shape[1],
                    metadata.shape[2],
                  );
                  (this.state.dataType as TrackableEnum<DataType>).value =
                    metadata.dataType;
                  this.state.voxelSize.value = vec3.fromValues(
                    metadata.voxelSize[0],
                    metadata.voxelSize[1],
                    metadata.voxelSize[2],
                  );
                  this.state.voxelUnit.value = metadata.voxelUnit;
                  this.state.name.value = metadata.name;
                }
              }
            });
            parentElement.appendChild(select);
          },
        ),
      ).element,
    );

    const commonFields = document.createElement("fieldset");
    const commonLegend = document.createElement("legend");
    commonLegend.textContent = "Common Metadata";
    commonFields.appendChild(commonLegend);
    content.appendChild(commonFields);

    this.addControl(this.state.name, "Name", commonFields);
    this.addControl(this.state.shape, "Shape", commonFields);
    this.addControl(this.state.dataType, "Data Type", commonFields);
    this.addControl(this.state.voxelSize, "Voxel Size", commonFields);
    this.addControl(this.state.voxelUnit, "Voxel Unit", commonFields);
    this.addControl(this.state.numScales, "Number of Scales", commonFields);
    this.addControl(
      this.state.downsamplingFactor,
      "Downsampling Factor",
      commonFields,
    );

    const optionsContainer = document.createElement("fieldset");
    const optionsLegend = document.createElement("legend");
    optionsContainer.appendChild(optionsLegend);
    const optionsGrid = document.createElement("div");
    optionsContainer.appendChild(optionsGrid);
    content.appendChild(optionsContainer);

    this.registerDisposer(
      this.dataSourceType.changed.add(() => {
        this.updateDataSourceOptions(optionsGrid, optionsLegend);
      }),
    );
    this.updateDataSourceOptions(optionsGrid, optionsLegend);

    const actions = document.createElement("div");
    const createButton = document.createElement("button");
    createButton.textContent = "Create";
    this.registerEventListener(createButton, "click", () =>
      this.createDataset(),
    );
    actions.appendChild(createButton);
    content.appendChild(actions);
  }

  private updateDataSourceOptions(
    container: HTMLElement,
    legend: HTMLLegendElement,
  ) {
    if (this.dataSourceOptions) {
      this.dataSourceOptions.dispose();
      this.dataSourceOptions = undefined;
    }
    removeChildren(container);
    const provider =
      this.manager.dataSourceProviderRegistry.getKvStoreBasedProvider(
        this.dataSourceType.value,
      );
    legend.textContent = `${provider?.description || this.dataSourceType.value} Metadata`;
    const creationState = provider?.creationState as
      | DataSourceCreationState
      | undefined;
    if (creationState) {
      this.dataSourceOptions = creationState;
      for (const key of Object.keys(creationState)) {
        if (
          key === "changed" ||
          key === "toJSON" ||
          key === "restoreState" ||
          key === "reset"
        )
          continue;
        const trackable = (creationState as any)[key];
        if (trackable && typeof trackable.changed?.add === "function") {
          this.addControl(trackable, key, container);
        }
      }
    }
  }

  private async createDataset() {
    const provider =
      this.manager.dataSourceProviderRegistry.getKvStoreBasedProvider(
        this.dataSourceType.value,
      );
    if (!provider?.create) {
      StatusMessage.showTemporaryMessage(
        `Data source '${this.dataSourceType.value}' does not support creation.`,
        5000,
      );
      return;
    }

    const options: CreateDataSourceOptions = {
      kvStoreUrl: this.url,
      registry: this.manager.dataSourceProviderRegistry,
      metadata: {
        common: this.state.toJSON(),
        sourceRelated: this.dataSourceOptions,
      },
    };

    StatusMessage.forPromise(provider.create(options), {
      initialMessage: `Creating dataset at ${this.url}...`,
      delay: true,
      errorPrefix: "Creation failed: ",
    }).then(() => {
      StatusMessage.showTemporaryMessage("Dataset created successfully.", 3000);
      for (const layer of this.manager.rootLayers.managedLayers) {
        if (layer.layer) {
          for (const ds of layer.layer.dataSources) {
            if (ds.spec.url === this.url) {
              ds.spec = { ...ds.spec };
              this.dispose();
              return;
            }
          }
        }
      }
    });
  }
}
