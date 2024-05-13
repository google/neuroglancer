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

import "#src/noselect.css";
import "#src/ui/layer_bar.css";
import svg_plus from "ikonate/icons/plus.svg?raw";
import { GraphConnection } from "#src/datasource/graphene/frontend.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { addNewLayer, deleteLayer, makeLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { LayerGroupViewer } from "#src/layer_group_viewer.js";
import { NavigationLinkType } from "#src/navigation_state.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { DropLayers } from "#src/ui/layer_drag_and_drop.js";
import {
  registerLayerBarDragLeaveHandler,
  registerLayerBarDropHandlers,
  registerLayerDragHandlers,
} from "#src/ui/layer_drag_and_drop.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeFromParent } from "#src/util/dom.js";
import { preventDrag } from "#src/util/drag_and_drop.js";
import { makeCloseButton } from "#src/widget/close_button.js";
import { makeDeleteButton } from "#src/widget/delete_button.js";
import { makeIcon } from "#src/widget/icon.js";
import { PositionWidget } from "#src/widget/position_widget.js";

class LayerWidget extends RefCounted {
  element = document.createElement("div");
  layerNumberElement = document.createElement("div");
  labelElement = document.createElement("div");
  visibleProgress = document.createElement("div");
  prefetchProgress = document.createElement("div");
  labelElementText = document.createTextNode("");
  valueElement = document.createElement("div");
  maxLength = 0;
  prevValueText = "";

  constructor(
    public layer: ManagedUserLayer,
    public panel: LayerBar,
  ) {
    super();
    const {
      element,
      labelElement,
      layerNumberElement,
      valueElement,
      visibleProgress,
      prefetchProgress,
      labelElementText,
    } = this;
    element.className = "neuroglancer-layer-item neuroglancer-noselect";
    element.appendChild(visibleProgress);
    element.appendChild(prefetchProgress);
    labelElement.className = "neuroglancer-layer-item-label";
    labelElement.appendChild(labelElementText);

    this.registerDisposer(
      layer.readyStateChanged.add(() => {
        console.log("layer is ready", layer.isReady());
        if (layer.isReady() && layer.layer instanceof SegmentationUserLayer) {
          const graphConnection = layer.layer.graphConnection;
          const timeElement = document.createElement("div");
          timeElement.innerHTML = "🕘";
          let timeStampDisposer: (() => boolean) | undefined = undefined;
          const graphConnectionChanged = () => {
            if (timeStampDisposer) timeStampDisposer();
            if (graphConnection.value instanceof GraphConnection) {
              element.appendChild(timeElement);
              const { timestamp } = graphConnection.value.state;
              const updateTimeDisplay = () => {
                timeElement.style.display =
                  timestamp.value > 0 ? "inherit" : "none";
              };
              timeStampDisposer = this.registerDisposer(
                timestamp.changed.add(updateTimeDisplay),
              );
              updateTimeDisplay();
            } else {
              if (element.contains(timeElement)) {
                element.removeChild(timeElement);
              }
            }
          };
          graphConnectionChanged();
          this.registerDisposer(
            graphConnection.changed.add(graphConnectionChanged),
          );
        }
      }),
    );

    visibleProgress.className = "neuroglancer-layer-item-visible-progress";
    prefetchProgress.className = "neuroglancer-layer-item-prefetch-progress";
    layerNumberElement.className = "neuroglancer-layer-item-number";
    valueElement.className = "neuroglancer-layer-item-value";

    const valueContainer = document.createElement("div");
    valueContainer.className = "neuroglancer-layer-item-value-container";
    const buttonContainer = document.createElement("div");
    buttonContainer.className = "neuroglancer-layer-item-button-container";
    const closeElement = makeCloseButton();
    closeElement.title = "Remove layer from this layer group";
    closeElement.addEventListener("click", (event: MouseEvent) => {
      if (this.panel.layerManager === this.panel.manager.rootLayers) {
        // The layer bar corresponds to a TopLevelLayerListSpecification.  That means there is just
        // a single layer group, archive the layer unconditionally.
        this.layer.setArchived(true);
      } else {
        // The layer bar corresponds to a LayerSubsetSpecification.  The layer is always contained
        // in the root LayerManager, as well as the LayerManager for each LayerSubsetSpecification.
        if (this.layer.containers.size > 2) {
          // Layer is contained in at least one other layer group, just remove it from this layer
          // group.
          this.panel.layerManager.removeManagedLayer(this.layer);
        } else {
          // Layer is not contained in any other layer group.  Archive it.
          this.layer.setArchived(true);
        }
      }
      event.stopPropagation();
    });
    const deleteElement = makeDeleteButton();
    deleteElement.title = "Delete this layer";
    deleteElement.addEventListener("click", (event: MouseEvent) => {
      deleteLayer(this.layer);
      event.stopPropagation();
    });
    element.appendChild(layerNumberElement);
    valueContainer.appendChild(valueElement);
    valueContainer.appendChild(buttonContainer);
    buttonContainer.appendChild(closeElement);
    buttonContainer.appendChild(deleteElement);
    element.appendChild(labelElement);
    element.appendChild(valueContainer);
    const positionWidget = this.registerDisposer(
      new PositionWidget(
        layer.localPosition,
        layer.localCoordinateSpaceCombiner,
        {
          copyButton: false,
          velocity: layer.localVelocity,
          getToolBinder: () => layer.layer?.toolBinder,
        },
      ),
    );
    element.appendChild(positionWidget.element);
    positionWidget.element.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
    });
    positionWidget.element.addEventListener("dblclick", (event: MouseEvent) => {
      event.stopPropagation();
    });
    element.addEventListener("click", (event: MouseEvent) => {
      if (event.ctrlKey) {
        panel.selectedLayer.toggle(layer);
      } else if (event.altKey) {
        layer.pickEnabled = !layer.pickEnabled;
      } else {
        layer.setVisible(!layer.visible);
      }
    });

    element.addEventListener("contextmenu", (event: MouseEvent) => {
      panel.selectedLayer.layer = layer;
      panel.selectedLayer.visible = true;
      event.stopPropagation();
      event.preventDefault();
    });
    registerLayerDragHandlers(panel, element, layer, {
      getLayoutSpec: () => panel.getLayoutSpecForDrag(),
    });
    registerLayerBarDropHandlers(this.panel, element, this.layer);
  }

  update() {
    const { layer, element } = this;
    this.labelElementText.textContent = layer.name;
    element.dataset.visible = layer.visible.toString();
    element.dataset.selected = (
      layer === this.panel.selectedLayer.layer
    ).toString();
    element.dataset.pick = layer.pickEnabled.toString();
    let title = `Click to ${
      layer.visible ? "hide" : "show"
    }, control+click to show side panel`;
    if (layer.supportsPickOption) {
      title += `, alt+click to ${
        layer.pickEnabled ? "disable" : "enable"
      } spatial object selection`;
    }
    title += ", drag to move, shift+drag to copy";
    element.title = title;
  }

  disposed() {
    this.element.remove();
    super.disposed();
  }
}

export class LayerBar extends RefCounted {
  layerWidgets = new Map<ManagedUserLayer, LayerWidget>();
  element = document.createElement("div");
  private layerUpdateNeeded = true;
  private valueUpdateNeeded = false;
  dropZone: HTMLDivElement;
  private layerWidgetInsertionPoint = document.createElement("div");
  private positionWidget = this.registerDisposer(
    new PositionWidget(
      this.viewerNavigationState.position.value,
      this.manager.root.coordinateSpaceCombiner,
      {
        velocity: this.viewerNavigationState.velocity.velocity,
        getToolBinder: () => this.layerGroupViewer.toolBinder,
      },
    ),
  );
  /**
   * For use within this module only.
   */
  dropLayers: DropLayers | undefined;

  dragEnterCount = 0;

  get layerManager() {
    return this.manager.layerManager;
  }

  get manager() {
    return this.layerGroupViewer.layerSpecification;
  }

  get display() {
    return this.layerGroupViewer.display;
  }

  get selectedLayer() {
    return this.layerGroupViewer.selectedLayer;
  }

  get viewerNavigationState() {
    return this.layerGroupViewer.viewerNavigationState;
  }

  constructor(
    public layerGroupViewer: LayerGroupViewer,
    public getLayoutSpecForDrag: () => any,
    public showLayerHoverValues: WatchableValueInterface<boolean>,
  ) {
    super();
    const { element, manager, selectedLayer } = this;
    element.className = "neuroglancer-layer-panel";
    this.registerDisposer(
      manager.layerSelectedValues.changed.add(() => {
        this.handleLayerValuesChanged();
      }),
    );
    this.registerDisposer(
      manager.layerManager.layersChanged.add(() => {
        this.handleLayersChanged();
      }),
    );
    this.registerDisposer(
      selectedLayer.changed.add(() => {
        this.handleLayersChanged();
      }),
    );
    this.registerDisposer(
      showLayerHoverValues.changed.add(() => {
        this.handleLayerItemValueChanged();
      }),
    );
    this.element.dataset.showHoverValues =
      this.showLayerHoverValues.value.toString();
    this.layerWidgetInsertionPoint.style.display = "none";
    this.element.appendChild(this.layerWidgetInsertionPoint);

    const addButton = makeIcon({
      svg: svg_plus,
      title:
        "Click to add layer, control+click/right click/⌘+click to add local annotation layer.",
    });
    addButton.classList.add("neuroglancer-layer-add-button");

    const dropZone = (this.dropZone = document.createElement("div"));
    dropZone.className = "neuroglancer-layer-panel-drop-zone";

    const addLayer = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.type === "contextmenu") {
        const layer = makeLayer(this.manager, "annotation", {
          type: "annotation",
          source: "local://annotations",
        });
        this.manager.add(layer);
        this.selectedLayer.layer = layer;
        this.selectedLayer.visible = true;
      } else {
        this.addLayerMenu();
      }
    };
    this.registerEventListener(addButton, "click", addLayer);
    this.registerEventListener(addButton, "contextmenu", addLayer);
    element.appendChild(addButton);
    element.appendChild(dropZone);
    this.registerDisposer(preventDrag(addButton));

    element.appendChild(this.positionWidget.element);
    const updatePositionWidgetVisibility = () => {
      const linkValue = this.viewerNavigationState.position.link.value;
      this.positionWidget.element.style.display =
        linkValue === NavigationLinkType.LINKED ? "none" : "";
    };
    this.registerDisposer(
      this.viewerNavigationState.position.link.changed.add(
        updatePositionWidgetVisibility,
      ),
    );
    updatePositionWidgetVisibility();

    this.update();
    this.updateChunkStatistics();

    registerLayerBarDragLeaveHandler(this);
    registerLayerBarDropHandlers(this, dropZone, undefined);

    // Ensure layer widgets are updated before WebGL drawing starts; we don't want the layout to
    // change after WebGL drawing or we will get flicker.
    this.registerDisposer(
      this.display.updateStarted.add(() => this.updateLayers()),
    );

    this.registerDisposer(
      manager.chunkManager.layerChunkStatisticsUpdated.add(
        this.registerCancellable(
          animationFrameDebounce(() => this.updateChunkStatistics()),
        ),
      ),
    );
  }

  disposed() {
    this.layerWidgets.forEach((x) => x.dispose());
    this.layerWidgets = <any>undefined;
    removeFromParent(this.element);
    super.disposed();
  }

  handleLayersChanged() {
    this.layerUpdateNeeded = true;
    this.handleLayerValuesChanged();
  }

  handleLayerValuesChanged() {
    if (!this.valueUpdateNeeded) {
      this.valueUpdateNeeded = true;
      this.scheduleUpdate();
    }
  }

  handleLayerItemValueChanged() {
    this.element.dataset.showHoverValues =
      this.showLayerHoverValues.value.toString();
  }

  private scheduleUpdate = this.registerCancellable(
    animationFrameDebounce(() => this.update()),
  );

  private update() {
    this.valueUpdateNeeded = false;
    this.updateLayers();
    if (this.showLayerHoverValues.value === false) {
      return;
    }
    const values = this.manager.layerSelectedValues;
    for (const [layer, widget] of this.layerWidgets) {
      const userLayer = layer.layer;
      let text = "";
      if (userLayer !== null) {
        const state = values.get(userLayer);
        if (state !== undefined) {
          const { value } = state;
          if (value !== undefined) {
            text = "" + value;
          }
        }
      }
      if (text === widget.prevValueText) continue;
      widget.prevValueText = text;
      if (text.length > widget.maxLength) {
        const length = (widget.maxLength = text.length);
        widget.valueElement.style.width = `${length}ch`;
      }
      widget.valueElement.textContent = text;
    }
  }

  private updateChunkStatistics() {
    for (const [layer, widget] of this.layerWidgets) {
      let numVisibleChunksNeeded = 0;
      let numVisibleChunksAvailable = 0;
      let numPrefetchChunksNeeded = 0;
      let numPrefetchChunksAvailable = 0;
      const userLayer = layer.layer;
      if (userLayer !== null) {
        for (const { layerChunkProgressInfo } of userLayer.renderLayers) {
          numVisibleChunksNeeded +=
            layerChunkProgressInfo.numVisibleChunksNeeded;
          numVisibleChunksAvailable +=
            layerChunkProgressInfo.numVisibleChunksAvailable;
          numPrefetchChunksNeeded +=
            layerChunkProgressInfo.numPrefetchChunksNeeded;
          numPrefetchChunksAvailable +=
            layerChunkProgressInfo.numPrefetchChunksAvailable;
        }
      }
      widget.visibleProgress.style.width = `${
        (numVisibleChunksAvailable / Math.max(1, numVisibleChunksNeeded)) * 100
      }%`;
      widget.prefetchProgress.style.width = `${
        (numPrefetchChunksAvailable / Math.max(1, numPrefetchChunksNeeded)) *
        100
      }%`;
    }
  }

  updateLayers() {
    if (!this.layerUpdateNeeded) {
      return;
    }
    this.layerUpdateNeeded = false;
    const container = this.element;
    const layers = new Set();
    let nextChild = this.layerWidgetInsertionPoint.nextElementSibling;
    this.manager.rootLayers.updateNonArchivedLayerIndices();
    for (const layer of this.manager.layerManager.managedLayers) {
      if (layer.archived && !this.dropLayers?.layers.has(layer)) continue;
      layers.add(layer);
      let widget = this.layerWidgets.get(layer);
      const layerIndex = layer.nonArchivedLayerIndex;
      if (widget === undefined) {
        widget = new LayerWidget(layer, this);
        this.layerWidgets.set(layer, widget);
      }
      widget.layerNumberElement.textContent = "" + (1 + layerIndex);
      widget.update();
      const { element } = widget;
      if (element !== nextChild) {
        container.insertBefore(widget.element, nextChild);
      }
      nextChild = element.nextElementSibling;
    }
    for (const [layer, widget] of this.layerWidgets) {
      if (!layers.has(layer)) {
        this.layerWidgets.delete(layer);
        widget.dispose();
      }
    }
  }
  addLayerMenu() {
    addNewLayer(this.manager, this.selectedLayer);
  }
}
