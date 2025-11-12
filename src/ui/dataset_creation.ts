// src/ui/dataset_creation.ts

import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type { LayerListSpecification } from "#src/layer/index.js";
import { LayerReference } from "#src/layer/index.js";
import { Overlay } from "#src/overlay.js";
import { StatusMessage } from "#src/status.js";
import { TrackableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import type { Owned } from "#src/util/disposable.js";
import { LayerReferenceWidget } from "#src/widget/layer_reference.js";

export class DatasetCreationDialog extends Overlay {
  private format = new TrackableValue<"precomputed" | "zarr" | "n5">(
    "precomputed",
    (x) => x as any,
  );
  private copySource = new TrackableValue<"manual" | "copy">(
    "manual",
    (x) => x,
  );

  private dataType = new TrackableValue<DataType>(DataType.UINT8, (x) => x);
  private bounds = new TrackableValue<string>("128,128,128", (x) => x);
  private resolution = new TrackableValue<string>("4,4,40", (x) => x);
  private chunkSize = new TrackableValue<string>("64,64,64", (x) => x);

  private layerReference: Owned<LayerReference>;

  constructor(
    public manager: LayerListSpecification,
    public url: string,
  ) {
    super();

    this.layerReference = this.registerDisposer(
      new LayerReference(this.manager.rootLayers.addRef(), () => true),
    );
    this.registerDisposer(
      this.layerReference.changed.add(() => this.copyLayerConfig()),
    );

    const { content } = this;
    content.classList.add("neuroglancer-dataset-creation-dialog");

    content.innerHTML = `
      <h2>Create New Dataset</h2>
      <div style="font-size: smaller; color: #ccc;">At: ${this.url}</div>
      <div class="neuroglancer-dataset-creation-row">
        <label>Format</label>
        <select id="format-select">
          <option value="precomputed">Precomputed</option>
          <option value="zarr">Zarr</option>
          <option value="n5">N5</option>
        </select>
      </div>
      <div class="neuroglancer-dataset-creation-row">
        <label>Configuration</label>
        <div>
          <input type="radio" name="config-source" value="manual" id="config-manual" checked> <label for="config-manual">Manual</label>
          <input type="radio" name="config-source" value="copy" id="config-copy"> <label for="config-copy">Copy from Layer</label>
        </div>
      </div>
      <div id="copy-layer-widget-container" style="display: none; padding-left: 20px;"></div>
      <fieldset>
        <legend>Dataset Properties</legend>
        <div class="neuroglancer-dataset-creation-row">
          <label>Data Type</label>
          <select id="data-type-select">
            ${Object.keys(DataType)
              .filter((k) => !isNaN(Number(k)))
              .map(
                (k) =>
                  `<option value="${k}">${DataType[Number(k)]
                    .toLowerCase()
                    .replace("_", "")}</option>`,
              )
              .join("")}
          </select>
        </div>
        <div class="neuroglancer-dataset-creation-row">
          <label>Volume Size (voxels)</label>
          <input type="text" id="bounds-input" placeholder="e.g. 128,128,128">
        </div>
        <div class="neuroglancer-dataset-creation-row">
          <label>Resolution (nm)</label>
          <input type="text" id="resolution-input" placeholder="e.g. 4,4,40">
        </div>
        <div class="neuroglancer-dataset-creation-row">
          <label>Chunk Size (voxels)</label>
          <input type="text" id="chunk-size-input" placeholder="e.g. 64,64,64">
        </div>
      </fieldset>
      <div class="neuroglancer-dataset-creation-actions">
        <button id="create-button">Create</button>
        <button id="cancel-button">Cancel</button>
      </div>
    `;

    // Bindings and event listeners
    const formatSelect =
      content.querySelector<HTMLSelectElement>("#format-select")!;
    formatSelect.addEventListener("change", () => {
      this.format.value = formatSelect.value as any;
    });

    const configSourceRadios = content.querySelectorAll<HTMLInputElement>(
      'input[name="config-source"]',
    );
    const copyLayerContainer = content.querySelector<HTMLElement>(
      "#copy-layer-widget-container",
    )!;
    configSourceRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        this.copySource.value = radio.value as any;
        copyLayerContainer.style.display =
          this.copySource.value === "copy" ? "block" : "none";
      });
    });

    const layerRefWidget = this.registerDisposer(
      new LayerReferenceWidget(this.layerReference),
    );
    copyLayerContainer.appendChild(layerRefWidget.element);

    const dataTypeSelect =
      content.querySelector<HTMLSelectElement>("#data-type-select")!;
    dataTypeSelect.addEventListener("change", () => {
      this.dataType.value = parseInt(dataTypeSelect.value, 10);
    });
    this.dataType.changed.add(
      () => (dataTypeSelect.value = this.dataType.value.toString()),
    );

    const boundsInput =
      content.querySelector<HTMLInputElement>("#bounds-input")!;
    boundsInput.addEventListener(
      "input",
      () => (this.bounds.value = boundsInput.value),
    );
    this.bounds.changed.add(() => (boundsInput.value = this.bounds.value));
    boundsInput.value = this.bounds.value;

    const resolutionInput =
      content.querySelector<HTMLInputElement>("#resolution-input")!;
    resolutionInput.addEventListener(
      "input",
      () => (this.resolution.value = resolutionInput.value),
    );
    this.resolution.changed.add(
      () => (resolutionInput.value = this.resolution.value),
    );
    resolutionInput.value = this.resolution.value;

    const chunkSizeInput =
      content.querySelector<HTMLInputElement>("#chunk-size-input")!;
    chunkSizeInput.addEventListener(
      "input",
      () => (this.chunkSize.value = chunkSizeInput.value),
    );
    this.chunkSize.changed.add(
      () => (chunkSizeInput.value = this.chunkSize.value),
    );
    chunkSizeInput.value = this.chunkSize.value;

    content
      .querySelector("#create-button")!
      .addEventListener("click", () => this.createDataset());
    content
      .querySelector("#cancel-button")!
      .addEventListener("click", () => this.dispose());
  }

  private copyLayerConfig() {
    const layer = this.layerReference.layer?.layer;
    if (!layer || !layer.dataSources[0]) return;

    const source = layer.dataSources[0];
    const { loadState } = source;
    if (loadState === undefined || loadState.error) return;

    const { subsourceEntry } = loadState.subsources[0];
    if (!subsourceEntry.subsource.volume) return;
    const multiscaleSource = subsourceEntry.subsource.volume;
    if (!multiscaleSource) return;

    const finestResolutionSource = multiscaleSource.getSources({
      displayRank: 3,
      multiscaleToViewTransform: new Float32Array(9),
      modelChannelDimensionIndices: [],
    })[0][0];

    if (!finestResolutionSource) return;
    const spec = finestResolutionSource.chunkSource.spec;

    this.dataType.value = spec.dataType;
    this.bounds.value = spec.upperVoxelBound.join(",");
    this.chunkSize.value = spec.chunkDataSize.join(",");

    const coordSpace = loadState.transform.value.inputSpace;
    this.resolution.value = coordSpace.scales.map((s) => s * 1e9).join(",");
  }

  private createDataset() {
    try {
      const parseVec = (input: string) => {
        const parts = input.split(",").map((s) => parseFloat(s.trim()));
        if (parts.length !== 3 || parts.some(isNaN)) {
          throw new Error(`Invalid vector format: "${input}"`);
        }
        return new Float32Array(parts);
      };

      const boundsVec = parseVec(this.bounds.value);
      const resolutionVec = parseVec(this.resolution.value).map((s) => s / 1e9); // nm to m
      const chunkSizeVec = parseVec(this.chunkSize.value);

      const coordinateSpace = makeCoordinateSpace({
        rank: 3,
        names: ["x", "y", "z"],
        units: ["m", "m", "m"],
        scales: new Float64Array(resolutionVec),
        bounds: {
          lowerBounds: new Float64Array([0, 0, 0]),
          upperBounds: new Float64Array(boundsVec),
          voxelCenterAtIntegerCoordinates: [false, false, false],
        },
      });

      const configuration = {
        dataType: this.dataType.value,
        coordinateSpace,
        chunkSize: new Uint32Array(chunkSizeVec),
        format: this.format.value,
      };

      const dataSourceProvider = this.manager.dataSourceProviderRegistry;
      const provider = dataSourceProvider.getKvStoreBasedProvider(
        configuration.format,
      );

      if (provider?.create === undefined) {
        throw new Error(
          `Dataset creation not supported for format: "${configuration}"`,
        );
      }

      const promise = provider.create({
        registry: dataSourceProvider,
        kvStoreUrl: this.url,
        metadata: configuration,
      });

      StatusMessage.forPromise(promise, {
        initialMessage: `Creating ${this.format.value} dataset at ${this.url}`,
        errorPrefix: "Creation failed: ",
        delay: true,
      });

      promise.then(() => {
        for (const layer of this.manager.rootLayers.managedLayers) {
          const dataSource = layer.layer?.dataSources.find(
            (ds) => ds.spec.url === this.url,
          );
          if (dataSource) {
            dataSource.spec = { ...dataSource.spec };
            break;
          }
        }
        this.dispose();
      });
    } catch (e) {
      StatusMessage.showTemporaryMessage(`Error: ${(e as Error).message}`);
    }
  }
}
