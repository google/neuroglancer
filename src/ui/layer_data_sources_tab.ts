/**
 * @license
 * Copyright 2019 Google Inc.
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

/**
 * @file Tab for showing layer data sources and coordinate transforms.
 */

import "#src/ui/layer_data_sources_tab.css";
import { LocalDataSource } from "#src/datasource/local.js";
import type { UserLayer, UserLayerConstructor } from "#src/layer/index.js";
import {
  changeLayerName,
  changeLayerType,
  makeLayer,
  NewUserLayer,
  USER_LAYER_TABS,
} from "#src/layer/index.js";
import type {
  LayerDataSource,
  LoadedDataSubsource,
} from "#src/layer/layer_data_source.js";
import { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import { createImageLayerAsMultiChannel } from "#src/layer/multi_channel_setup.js";
import { getVoxelEditingIncompatibility } from "#src/layer/voxel_editing/eligibility.js";
import { MeshSource, MultiscaleMeshSource } from "#src/mesh/frontend.js";
import { SkeletonSource } from "#src/skeleton/frontend.js";
import { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import {
  ElementVisibilityFromTrackableBoolean,
  TrackableBooleanCheckbox,
} from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeCachedDerivedWatchableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import type { DebouncedFunction } from "#src/util/animation_frame_debounce.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { DataType } from "#src/util/data_type.js";
import type { Borrowed } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  removeChildren,
  removeFromParent,
  updateChildren,
} from "#src/util/dom.js";
import type { MessageList } from "#src/util/message_list.js";
import { MessageSeverity } from "#src/util/message_list.js";
import type { ProgressListener } from "#src/util/progress_listener.js";
import { makeAddButton } from "#src/widget/add_button.js";
import { CoordinateSpaceTransformWidget } from "#src/widget/coordinate_transform.js";
import type {
  Completer,
  SyntaxHighlighter,
} from "#src/widget/multiline_autocomplete.js";
import {
  AutocompleteTextInput,
  makeCompletionElementWithDescription,
} from "#src/widget/multiline_autocomplete.js";
import { ProgressListenerWidget } from "#src/widget/progress_listener.js";
import { Tab } from "#src/widget/tab_view.js";

const dataSourceUrlSyntaxHighlighter: SyntaxHighlighter = {
  splitPattern: /\|?[^|:/_]*(?:[:/_]+)?/g,
  getSeparatorNode: (text: string) => {
    if (text.startsWith("|") && text.length > 1) {
      // Create an empty span with CSS class that adds `::after` node with
      // content "\a". This prevents the linebreak from affecting text selection.
      const node = document.createElement("span");
      node.classList.add("neuroglancer-multiline-autocomplete-linebreak");
      return node;
    } else {
      return document.createElement("wbr");
    }
  },
};

class SourceUrlAutocomplete extends AutocompleteTextInput {
  dataSourceView: DataSourceView;
  dirty: WatchableValueInterface<boolean>;
  constructor(dataSourceView: DataSourceView) {
    const { manager } = dataSourceView.source.layer;
    const sourceCompleter: Completer = async (
      { value },
      signal: AbortSignal,
      progressListener: ProgressListener,
    ) => {
      const originalResult =
        await manager.dataSourceProviderRegistry.completeUrl({
          url: value,
          signal,
          progressListener,
        });
      return {
        ...originalResult,
        makeElement: makeCompletionElementWithDescription,
        showSingleResult: true,
      };
    };
    super({
      completer: sourceCompleter,
      syntaxHighlighter: dataSourceUrlSyntaxHighlighter,
      delay: 0,
    });
    this.placeholder = "Data source URL";
    this.dataSourceView = dataSourceView;
    this.element.classList.add("neuroglancer-layer-data-source-url-input");
    this.dirty = new WatchableValue(false);
    const updateDirty = (value: string) => {
      if (value !== this.dataSourceView.source.spec.url) {
        this.dirty.value = true;
      }
    };
    updateDirty("");
    this.onInput.add(updateDirty);
  }

  cancel() {
    this.value = this.dataSourceView.source.spec.url;
    this.dirty.value = false;
    this.inputElement.blur();
    return true;
  }
}

/**
 * The data source's transform source ("transformSource"): the URL of an
 * OME-Zarr transformation (a scene, a group of transformations, an image, or
 * a JSON file of such metadata) or of a displacement field. Shown and wrapped
 * like the source URL. Committing a new value (Enter or leaving the field)
 * reloads the source; an empty value removes it. Escape reverts to the
 * current value.
 */
class TransformSourceUrlInput extends AutocompleteTextInput {
  row = document.createElement("div");

  constructor(public source: Borrowed<LayerDataSource>) {
    super({
      completer: () => null,
      syntaxHighlighter: dataSourceUrlSyntaxHighlighter,
      delay: 0,
    });
    this.placeholder = "Transform source URL (none)";
    const { row, element } = this;
    row.classList.add("neuroglancer-layer-data-source-transform-source-url");
    row.title =
      "The transformation from this source's space to the layer's: the URL " +
      "of an OME-Zarr transformation (a scene, a group of transformations, " +
      "an image, or a JSON file of OME-Zarr metadata) of linear " +
      "transformations and at most one displacement field, or of a " +
      'displacement field alone (the layer JSON source "transformSource"). ' +
      "Its last linear part becomes the transform below. Leave empty for " +
      "none.";
    const label = document.createElement("span");
    label.classList.add(
      "neuroglancer-layer-data-source-transform-source-label",
    );
    label.textContent = "transform";
    row.appendChild(label);
    element.classList.add("neuroglancer-layer-data-source-url-input");
    row.appendChild(element);
    this.onCommit.add((value) => this.commit(value));
    this.registerDisposer(() => removeFromParent(row));
    this.updateView();
  }

  private commit(value: string) {
    const trimmed = value.trim();
    const { source } = this;
    const spec = source.spec;
    if ((spec.transformSource?.url ?? "") === trimmed) return;
    const prepend = spec.prependTransform === true;
    source.spec = {
      ...spec,
      transformSource: trimmed.length === 0 ? undefined : { url: trimmed },
      // The transform starts as the new transform source's last linear part;
      // a prepended one places the source and is kept.
      transform: prepend ? spec.transform : undefined,
      prependTransform:
        trimmed.length === 0 ? undefined : spec.prependTransform,
    };
  }

  cancel() {
    this.value = this.source.spec.transformSource?.url ?? "";
    this.inputElement.blur();
    return true;
  }

  updateView() {
    const { spec } = this.source;
    // A transformation from the source's own metadata applies unless one is
    // given.
    const ownChain = getOwnTransformChain(this.source);
    this.placeholder =
      ownChain === undefined
        ? "Transform source URL (none)"
        : `${ownChain.field?.url ?? "linear transformation"} (from the ` +
          "source's metadata)";
    if (document.activeElement !== this.inputElement) {
      this.value = spec.transformSource?.url ?? "";
    }
  }
}

function getOwnTransformChain(source: LayerDataSource) {
  const { loadState } = source;
  return loadState !== undefined && loadState.error === undefined
    ? loadState.dataSource.transformChain
    : undefined;
}

/**
 * The transform source's URL and whether the source's transform is applied
 * before it ("prependTransform") instead of after. Placed just above the
 * transform.
 */
class TransformSourceView extends RefCounted {
  element = document.createElement("div");
  urlInput: TransformSourceUrlInput;
  private prependLabel = document.createElement("label");
  private prependCheckbox = document.createElement("input");

  constructor(public source: Borrowed<LayerDataSource>) {
    super();
    const { element, prependLabel, prependCheckbox } = this;
    element.classList.add("neuroglancer-layer-data-source-transform-source");
    this.urlInput = this.registerDisposer(new TransformSourceUrlInput(source));
    element.appendChild(this.urlInput.row);
    prependCheckbox.type = "checkbox";
    prependLabel.classList.add(
      "neuroglancer-layer-data-source-transform-source-prepend",
    );
    prependLabel.title =
      "Apply the transform below before the transform source (to the " +
      "source's own coordinates), instead of after it. The transform then " +
      "starts as the source's own placement, and the transform source's " +
      "last linear part is applied as is. Changing this resets the " +
      "transform.";
    prependLabel.appendChild(prependCheckbox);
    prependLabel.appendChild(
      document.createTextNode("Prepend the transform (apply it first)"),
    );
    element.appendChild(prependLabel);
    prependCheckbox.addEventListener("change", () => {
      const { spec } = this.source;
      const prepend = prependCheckbox.checked;
      if ((spec.prependTransform === true) === prepend) return;
      this.source.spec = {
        ...spec,
        prependTransform: prepend ? true : undefined,
        transform: undefined,
      };
    });
    this.registerDisposer(() => removeFromParent(element));
    this.updateView();
  }

  updateView() {
    const { spec } = this.source;
    this.element.style.display = spec.url.length === 0 ? "none" : "";
    this.urlInput.updateView();
    this.prependCheckbox.checked = spec.prependTransform === true;
    this.prependLabel.style.display =
      spec.transformSource !== undefined ||
      getOwnTransformChain(this.source) !== undefined
        ? ""
        : "none";
  }
}

export class MessagesView extends RefCounted {
  element = document.createElement("ul");
  generation = -1;

  constructor(public model: MessageList) {
    super();
    this.element.classList.add(
      "neuroglancer-layer-data-sources-source-messages",
    );
    const debouncedUpdateView = this.registerCancellable(
      animationFrameDebounce(() => this.updateView()),
    );
    this.registerDisposer(model.changed.add(debouncedUpdateView));
    this.registerDisposer(() => removeFromParent(this.element));
    this.updateView();
  }

  updateView() {
    const { model } = this;
    const generation = model.changed.count;
    if (generation === this.generation) return;
    this.generation = generation;
    const { element } = this;
    removeChildren(element);
    const seen = new Set<string>();
    for (const message of model) {
      const key = `${message.severity} ${message.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const li = document.createElement("li");
      element.appendChild(li);
      li.classList.add("neuroglancer-message");
      li.classList.add(
        `neuroglancer-message-${MessageSeverity[message.severity]}`,
      );
      li.textContent = message.message;
    }
  }
}

export class DataSourceSubsourceView extends RefCounted {
  element = document.createElement("div");

  constructor(
    loadedSource: LoadedLayerDataSource,
    public loadedSubsource: LoadedDataSubsource,
  ) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-layer-data-source-subsource");
    const sourceInfoLine = document.createElement("label");
    const sourceType = document.createElement("span");
    const updateActiveAttribute = () => {
      sourceInfoLine.dataset.isActive = (
        loadedSubsource.activated !== undefined || !loadedSubsource.enabled
      ).toString();
    };
    updateActiveAttribute();
    this.registerDisposer(
      loadedSubsource.isActiveChanged.add(updateActiveAttribute),
    );
    this.registerDisposer(
      loadedSource.enabledSubsourcesChanged.add(updateActiveAttribute),
    );
    const enabledState: WatchableValueInterface<boolean> & {
      set value(v: boolean);
    } = {
      get value() {
        return loadedSubsource.enabled;
      },
      set value(value: boolean) {
        if (loadedSubsource.enabled === value) return;
        loadedSubsource.enabled = value;
        loadedSource.enableDefaultSubsources = false;
        loadedSource.enabledSubsourcesChanged.dispatch();
      },
      changed: loadedSource.enabledSubsourcesChanged,
    };
    const enabledCheckbox = this.registerDisposer(
      new TrackableBooleanCheckbox(enabledState),
    );
    sourceInfoLine.classList.add("neuroglancer-layer-data-sources-info-line");
    sourceInfoLine.appendChild(enabledCheckbox.element);

    const { subsource } = loadedSubsource.subsourceEntry;
    if (subsource.volume instanceof MultiscaleVolumeChunkSource) {
      const writableCheckbox = this.registerDisposer(
        new TrackableBooleanCheckbox(loadedSubsource.writingEnabled),
      );
      writableCheckbox.element.title = "Enable voxel editing for this source";
      const writableLabel = document.createElement("label");
      writableLabel.className = "neuroglancer-layer-data-source-writable-label";
      writableLabel.appendChild(writableCheckbox.element);
      writableLabel.appendChild(document.createTextNode("[Enable writing?]"));

      const incompatibility =
        subsource.writingIncompatibility ??
        getVoxelEditingIncompatibility(subsource.volume);
      if (incompatibility !== undefined) {
        writableCheckbox.element.disabled = true;
        writableLabel.title = incompatibility;
        writableLabel.classList.add(
          "neuroglancer-layer-data-source-writable-label-disabled",
        );
      }

      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          makeCachedDerivedWatchableValue(
            (enabled, supportsWriting) => enabled && supportsWriting,
            [
              enabledState,
              new WatchableValue(subsource.supportsWriting ?? false),
            ],
          ),
          writableLabel,
        ),
      );

      sourceInfoLine.appendChild(writableLabel);
    }

    const sourceId = document.createElement("span");
    sourceId.classList.add("neuroglancer-layer-data-sources-source-id");
    const { id } = loadedSubsource.subsourceEntry;
    if (id !== "default") {
      sourceId.textContent = id;
    }
    sourceInfoLine.appendChild(sourceId);
    sourceType.classList.add("neuroglancer-layer-data-sources-source-type");
    const messagesView = this.registerDisposer(
      new MessagesView(this.loadedSubsource.messages),
    );
    element.appendChild(sourceInfoLine);
    sourceInfoLine.appendChild(sourceType);
    element.appendChild(messagesView.element);
    let sourceTypeStr = "";
    const { volume } = subsource;
    if (volume instanceof MultiscaleVolumeChunkSource) {
      sourceTypeStr = `${DataType[volume.dataType].toLowerCase()} volume`;
    } else if (subsource.mesh instanceof MeshSource) {
      sourceTypeStr = "meshes (single-res.)";
    } else if (subsource.mesh instanceof MultiscaleMeshSource) {
      sourceTypeStr = "meshes (multi-res.)";
    } else if (subsource.mesh instanceof SkeletonSource) {
      sourceTypeStr = "skeletons";
    } else if (subsource.segmentPropertyMap !== undefined) {
      sourceTypeStr = "segment property map";
    } else if (subsource.local !== undefined) {
      switch (subsource.local) {
        case LocalDataSource.annotations:
          sourceTypeStr = "Local annotations";
          break;
        case LocalDataSource.equivalences:
          sourceTypeStr = "local segmentation graph";
          break;
      }
    } else if (subsource.staticAnnotations !== undefined) {
      sourceTypeStr = "default annotations";
    } else if (subsource.annotation !== undefined) {
      sourceTypeStr = "annotations";
    } else if (subsource.singleMesh !== undefined) {
      sourceTypeStr = "single mesh";
    } else if (subsource.segmentationGraph !== undefined) {
      sourceTypeStr = "segmentation graph";
    }
    sourceType.textContent = sourceTypeStr;
  }
}

export class LoadedDataSourceView extends RefCounted {
  element = document.createElement("div");
  // The transform's widget, if shown: the transform source goes above it.
  transformElement: HTMLElement | null = null;

  constructor(public source: Borrowed<LoadedLayerDataSource>) {
    super();
    const { element } = this;
    const enableDefaultSubsourcesLabel = document.createElement("label");
    enableDefaultSubsourcesLabel.classList.add(
      "neuroglancer-layer-data-sources-source-default",
    );
    enableDefaultSubsourcesLabel.appendChild(
      this.registerDisposer(
        new TrackableBooleanCheckbox({
          changed: source.enabledSubsourcesChanged,
          get value() {
            return source.enableDefaultSubsources;
          },
          set value(value: boolean) {
            if (source.enableDefaultSubsources === value) return;
            source.enableDefaultSubsources = value;
            if (value) {
              for (const subsource of source.subsources) {
                subsource.enabled = subsource.subsourceEntry.default;
              }
            }
            source.enabledSubsourcesChanged.dispatch();
          },
        }),
      ).element,
    );
    enableDefaultSubsourcesLabel.appendChild(
      document.createTextNode("Enable default subsource set"),
    );
    enableDefaultSubsourcesLabel.title =
      "Enable the default set of subsources for this data source.";
    element.appendChild(enableDefaultSubsourcesLabel);
    for (const subsource of source.subsources) {
      element.appendChild(
        this.registerDisposer(new DataSourceSubsourceView(source, subsource))
          .element,
      );
    }
    const { transform, movingTransform } = source;
    if (movingTransform !== undefined) {
      // A prepended transform: the editable transform places the source
      // before the transform source (the layer JSON "transform").
      const transformWidget = this.registerDisposer(
        new CoordinateSpaceTransformWidget(
          movingTransform,
          source.layer.localCoordinateSpaceCombiner,
          source.layer.manager.root.coordinateSpaceCombiner,
        ),
      );
      this.element.appendChild(transformWidget.element);
      this.transformElement = transformWidget.element;
    } else if (
      transform.mutableSourceRank ||
      transform.value.sourceRank !== 0
    ) {
      const transformWidget = this.registerDisposer(
        new CoordinateSpaceTransformWidget(
          source.transform,
          source.layer.localCoordinateSpaceCombiner,
          source.layer.manager.root.coordinateSpaceCombiner,
        ),
      );
      this.element.appendChild(transformWidget.element);
      this.transformElement = transformWidget.element;
    }
    this.registerDisposer(() => removeFromParent(this.element));
  }
}

export class DataSourceView extends RefCounted {
  element = document.createElement("div");
  urlInput: SourceUrlAutocomplete;
  transformSourceView: TransformSourceView;

  seenGeneration = 0;
  generation = -1;
  private loadedView: LoadedDataSourceView | undefined;

  constructor(
    public tab: Borrowed<LayerDataSourcesTab>,
    public source: Borrowed<LayerDataSource>,
  ) {
    super();
    const urlInput = (this.urlInput = this.registerDisposer(
      new SourceUrlAutocomplete(this),
    ));

    const updateUrlFromView = (url: string, explicit: boolean) => {
      const { source } = this;
      const existingSpec = source.spec;
      const userLayer = this.source.layer;
      urlInput.dirty.value = false;
      // If url is non-empty and unchanged, don't set spec, as that would trigger a reload of the
      // data source.  If the url is empty, always set spec in order to possible remove the empty
      // data source.
      if (url && url === existingSpec.url) {
        if (explicit) {
          if (tab.detectedLayerConstructor !== undefined) {
            changeLayerTypeToDetected(source.layer);
          }
        }
        return;
      }
      if (userLayer instanceof NewUserLayer) {
        try {
          const newName =
            userLayer.manager.dataSourceProviderRegistry.suggestLayerName(url);
          if (newName) {
            changeLayerName(userLayer.managedLayer, newName);
          }
        } catch {
          // Ignore errors obtaining a suggested layer name.
        }
      }
      source.spec = { ...existingSpec, url, setManually: true };
    };
    urlInput.onCommit.add(updateUrlFromView);

    const { element } = this;
    element.classList.add("neuroglancer-layer-data-source");
    element.appendChild(urlInput.element);
    this.transformSourceView = this.registerDisposer(
      new TransformSourceView(source),
    );
    element.appendChild(
      this.registerDisposer(new MessagesView(source.messages)).element,
    );
    const progressListenerWidget = new ProgressListenerWidget();
    element.appendChild(progressListenerWidget.element);
    source.progressListener.addListener(progressListenerWidget);
    this.registerDisposer(() =>
      source.progressListener.removeListener(progressListenerWidget),
    );
    this.updateView();
  }

  updateView() {
    const generation = this.source.changed.count;
    if (generation === this.generation) return;
    this.generation = generation;
    this.urlInput.value = this.source.spec.url;
    this.urlInput.dirty.value = false;
    this.transformSourceView.updateView();
    const { loadState } = this.source;
    let { loadedView } = this;
    if (loadedView !== undefined) {
      if (loadedView.source === loadState) {
        return;
      }
      loadedView.dispose();
      loadedView = this.loadedView = undefined;
    }
    // The transform source goes just above the transform, or at the end
    // while the source is not loaded (so that it can be changed when it
    // fails to load).
    const transformSourceElement = this.transformSourceView.element;
    if (loadState instanceof LoadedLayerDataSource) {
      loadedView = this.loadedView = new LoadedDataSourceView(loadState);
      this.element.appendChild(loadedView.element);
      loadedView.element.insertBefore(
        transformSourceElement,
        loadedView.transformElement,
      );
    } else {
      this.element.appendChild(transformSourceElement);
    }
  }

  disposed() {
    const { loadedView } = this;
    if (loadedView !== undefined) {
      loadedView.dispose();
    }
    removeFromParent(this.element);
    super.disposed();
  }
}

function changeLayerTypeToDetected(userLayer: UserLayer) {
  if (userLayer instanceof NewUserLayer) {
    const layerConstructor = userLayer.detectedLayerConstructor;
    if (layerConstructor !== undefined) {
      changeLayerType(userLayer.managedLayer, layerConstructor);
      return true;
    }
  }
  return false;
}

export class LayerDataSourcesTab extends Tab {
  generation = -1;
  private sourceViews = new Map<LayerDataSource, DataSourceView>();
  private addDataSourceIcon = makeAddButton({
    title: "Add additional data source",
  });
  private layerTypeDetection = document.createElement("div");
  private multiChannelLayerCreate = document.createElement("div");
  private layerTypeElement = document.createElement("span");
  private dataSourcesContainer = document.createElement("div");
  private reRender: DebouncedFunction;

  constructor(public layer: Borrowed<UserLayer>) {
    super();
    const { element, dataSourcesContainer } = this;
    element.classList.add("neuroglancer-layer-data-sources-tab");
    dataSourcesContainer.classList.add(
      "neuroglancer-layer-data-sources-container",
    );
    const { addDataSourceIcon } = this;
    addDataSourceIcon.style.alignSelf = "start";
    addDataSourceIcon.addEventListener("click", () => {
      const layerDataSource = this.layer.addDataSource(undefined);
      this.updateView();
      const view = this.sourceViews.get(layerDataSource);
      if (view === undefined) return;
      view.urlInput.inputElement.focus();
    });
    element.appendChild(this.dataSourcesContainer);
    if (layer instanceof NewUserLayer) {
      const { layerTypeDetection, layerTypeElement, multiChannelLayerCreate } =
        this;
      layerTypeDetection.style.display = "none";
      layerTypeElement.classList.add(
        "neuroglancer-layer-data-sources-tab-type-detection-type",
      );
      layerTypeDetection.appendChild(document.createTextNode("Create as "));
      layerTypeDetection.appendChild(layerTypeElement);
      layerTypeDetection.appendChild(document.createTextNode(" layer"));
      element.appendChild(layerTypeDetection);
      layerTypeDetection.classList.add(
        "neuroglancer-layer-data-sources-tab-type-detection",
      );
      layerTypeDetection.addEventListener("click", () => {
        changeLayerTypeToDetected(layer);
      });
      // Image layers provide a second option
      multiChannelLayerCreate.classList.add(
        "neuroglancer-layer-data-sources-tab-type-detection",
      );
      const multiChannelLayerCreateLabel = document.createElement("span");
      multiChannelLayerCreateLabel.classList.add(
        "neuroglancer-layer-data-sources-tab-type-detection-type",
      );
      multiChannelLayerCreateLabel.textContent = "multi-channel image";
      multiChannelLayerCreate.appendChild(
        document.createTextNode("Create as "),
      );
      multiChannelLayerCreate.appendChild(multiChannelLayerCreateLabel);
      multiChannelLayerCreate.appendChild(document.createTextNode(" layer"));
      multiChannelLayerCreate.addEventListener("click", () => {
        changeLayerTypeToDetected(layer);
        layer.managedLayer.registerDisposer(
          layer.managedLayer.readyStateChanged.add(() => {
            if (layer.managedLayer.isReady()) {
              createImageLayerAsMultiChannel(layer.managedLayer, makeLayer);
            }
          }),
        );
      });
      multiChannelLayerCreate.style.display = "none";
      multiChannelLayerCreate.style.marginTop = "0.5em";
      element.appendChild(multiChannelLayerCreate);
    }
    const reRender = (this.reRender = animationFrameDebounce(() =>
      this.updateView(),
    ));
    this.registerDisposer(layer.dataSourcesChanged.add(reRender));
    this.registerDisposer(this.visibility.changed.add(reRender));
    this.updateView();
  }

  detectedLayerConstructor: UserLayerConstructor | undefined = undefined;

  updateLayerTypeDetection() {
    const layerConstructor = (() => {
      const userLayer = this.layer;
      if (!(userLayer instanceof NewUserLayer)) return undefined;
      const layerConstructor = userLayer.detectedLayerConstructor;
      if (layerConstructor === undefined) return undefined;
      for (const view of this.sourceViews.values()) {
        if (view.urlInput.dirty.value) return undefined;
      }
      return layerConstructor;
    })();
    if (layerConstructor === this.detectedLayerConstructor) return;
    const { layerTypeDetection, multiChannelLayerCreate } = this;
    this.detectedLayerConstructor = layerConstructor;
    if (layerConstructor !== undefined) {
      const { layerTypeElement } = this;
      layerTypeElement.textContent = layerConstructor.type;
      layerTypeDetection.title =
        "Click here or press enter in the data source URL input box to create as " +
        `${layerConstructor.type} layer`;
      layerTypeDetection.style.display = "";
      multiChannelLayerCreate.style.display =
        layerConstructor.type === "image" ? "" : "none";
    } else {
      layerTypeDetection.style.display = "none";
      multiChannelLayerCreate.style.display = "none";
    }
  }

  disposed() {
    const { sourceViews } = this;
    for (const dataSource of sourceViews.values()) {
      dataSource.dispose();
    }
    sourceViews.clear();
    super.disposed();
  }

  private updateView() {
    if (!this.visible) return;
    const generation = this.layer.dataSourcesChanged.count;
    if (generation !== this.generation) {
      this.generation = generation;
      const curSeenGeneration = Date.now();
      const { sourceViews } = this;
      const { layer } = this;
      function* getChildNodes(this: LayerDataSourcesTab) {
        let lastSourceUrlEmpty = true;
        const { dataSources } = layer;
        for (const source of dataSources) {
          let view = sourceViews.get(source);
          if (view === undefined) {
            view = new DataSourceView(this, source);
            view.registerDisposer(
              view.urlInput.dirty.changed.add(this.reRender),
            );
            sourceViews.set(source, view);
          }
          view.seenGeneration = curSeenGeneration;
          view.updateView();
          const url = source.spec.url;
          if (dataSources.length === 1 && url === "") {
            setTimeout(() => {
              view!.urlInput.inputElement.focus();
            }, 0);
          }
          lastSourceUrlEmpty = source.spec.url.length === 0;
          yield view.element;
        }
        if (!lastSourceUrlEmpty) {
          yield this.addDataSourceIcon;
        }
      }
      updateChildren(this.dataSourcesContainer, getChildNodes.call(this));
      for (const [source, view] of sourceViews) {
        if (view.seenGeneration !== curSeenGeneration) {
          view.dispose();
          sourceViews.delete(source);
        }
      }
    }
    this.updateLayerTypeDetection();
  }
}

USER_LAYER_TABS.push({
  id: "source",
  label: "Source",
  order: -100,
  getter: (layer) => new LayerDataSourcesTab(layer),
});
