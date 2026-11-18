/**
 * @license
 * Copyright 2026 Google Inc.
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

import svg_camera from "ikonate/icons/camera.svg?raw";
import svg_controls_alt from "ikonate/icons/controls-alt.svg?raw";
import svg_layers from "ikonate/icons/layers.svg?raw";
import svg_list from "ikonate/icons/list.svg?raw";
import svg_settings from "ikonate/icons/settings.svg?raw";
import { StateShare, stateShareEnabled } from "#src/datasource/state_share.js";
import { InputEventBindingHelpDialog } from "#src/help/input_event_bindings.js";
import { ElementVisibilityFromTrackableBoolean } from "#src/trackable_boolean.js";
import { makeDerivedWatchableValue } from "#src/trackable_value.js";
import {
  LayerArchiveCountWidget,
  LayerListPanel,
} from "#src/ui/layer_list_panel.js";
import { LayerSidePanelManager } from "#src/ui/layer_side_panel.js";
import { SelectionDetailsPanel } from "#src/ui/selection_details.js";
import { SidePanelManager } from "#src/ui/side_panel.js";
import { StatisticsPanel } from "#src/ui/statistics.js";
import {
  MultiToolPaletteDropdownButton,
  MultiToolPaletteManager,
} from "#src/ui/tool_palette.js";
import { ViewerSettingsPanel } from "#src/ui/viewer_settings.js";
import type { Borrowed } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { Viewer } from "#src/viewer.js";
import { VIEWER_TOP_ROW_CONFIG_OPTIONS } from "#src/viewer.js";
import { AnnotationToolStatusWidget } from "#src/widget/annotation_tool_status.js";
import { CheckboxIcon } from "#src/widget/checkbox_icon.js";
import { makeCopyUrlButton } from "#src/widget/copy_button.js";
import { makeIcon } from "#src/widget/icon.js";
import {
  MousePositionWidget,
  PositionWidget,
} from "#src/widget/position_widget.js";

interface CreditLink {
  url: string;
  text: string;
}

declare let NEUROGLANCER_CREDIT_LINK: CreditLink | CreditLink[] | undefined;

/**
 * Builds the chrome of a viewer: the top bar, the side panels and the tool
 * palettes.
 *
 * The chrome is a view of the viewer state. The `Viewer` constructor attaches
 * one unless the `chrome` option is false. A viewer with no chrome keeps the
 * same state, and its layout fills the viewer element.
 */
export class ViewerChrome extends RefCounted {
  sidePanelManager: SidePanelManager;

  constructor(public viewer: Borrowed<Viewer>) {
    super();
    const gridContainer = viewer.element;

    const topRow = document.createElement("div");
    topRow.classList.add("neuroglancer-viewer-top-row");
    topRow.style.display = "flex";
    topRow.style.flexDirection = "row";
    topRow.style.alignItems = "stretch";

    const positionWidget = this.registerDisposer(
      new PositionWidget(
        viewer.navigationState.position,
        viewer.layerSpecification.coordinateSpaceCombiner,
        {
          velocity: viewer.velocity,
          getToolBinder: () => viewer.toolBinder,
          showAllPlotBounds: viewer.uiConfiguration.showAllDimensionPlotBounds,
        },
      ),
    );
    this.registerDisposer(
      new ElementVisibilityFromTrackableBoolean(
        viewer.uiControlVisibility.showLocation,
        positionWidget.element,
      ),
    );
    topRow.appendChild(positionWidget.element);

    const mousePositionWidget = this.registerDisposer(
      new MousePositionWidget(
        document.createElement("div"),
        viewer.mouseState,
        viewer.navigationState.coordinateSpace,
      ),
    );
    mousePositionWidget.element.style.flex = "1";
    mousePositionWidget.element.style.alignSelf = "center";
    this.registerDisposer(
      new ElementVisibilityFromTrackableBoolean(
        viewer.uiControlVisibility.showLocation,
        mousePositionWidget.element,
      ),
    );
    topRow.appendChild(mousePositionWidget.element);

    if (typeof NEUROGLANCER_CREDIT_LINK !== "undefined") {
      let creditInfo = NEUROGLANCER_CREDIT_LINK!;
      if (!Array.isArray(creditInfo)) {
        creditInfo = [creditInfo];
      }
      for (const { url, text } of creditInfo) {
        const creditLink = document.createElement("a");
        creditLink.style.marginRight = "5px";
        creditLink.href = url;
        creditLink.textContent = text;
        creditLink.style.fontFamily = "sans-serif";
        creditLink.style.color = "yellow";
        creditLink.target = "_blank";
        topRow.appendChild(creditLink);
      }
    }

    const annotationToolStatus = this.registerDisposer(
      new AnnotationToolStatusWidget(
        viewer.selectedLayer,
        viewer.globalToolBinder,
      ),
    );
    topRow.appendChild(annotationToolStatus.element);
    this.registerDisposer(
      new ElementVisibilityFromTrackableBoolean(
        viewer.uiControlVisibility.showAnnotationToolStatus,
        annotationToolStatus.element,
      ),
    );

    if (stateShareEnabled) {
      const stateShare = this.registerDisposer(new StateShare(viewer));
      topRow.appendChild(stateShare.element);
    }

    {
      const button = this.registerDisposer(
        new MultiToolPaletteDropdownButton(viewer.toolPalettes),
      ).element;

      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showToolPaletteButton,
          button,
        ),
      );
      topRow.appendChild(button);
    }

    {
      const { layerListPanelState } = viewer;
      const button = this.registerDisposer(
        new CheckboxIcon(layerListPanelState.location.watchableVisible, {
          svg: svg_layers,
          backgroundScheme: "dark",
          enableTitle: "Show layer list panel",
          disableTitle: "Hide layer list panel",
        }),
      );
      button.element.insertAdjacentElement(
        "afterbegin",
        this.registerDisposer(new LayerArchiveCountWidget(viewer.layerManager))
          .element,
      );
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showLayerListPanelButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    {
      const { selectionDetailsState } = viewer;
      const button = this.registerDisposer(
        new CheckboxIcon(selectionDetailsState.location.watchableVisible, {
          svg: svg_list,
          backgroundScheme: "dark",
          enableTitle: "Show selection details panel",
          disableTitle: "Hide selection details panel",
        }),
      );
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showSelectionPanelButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    {
      const { selectedLayer } = viewer;
      const button = this.registerDisposer(
        new CheckboxIcon(
          {
            get value() {
              return selectedLayer.visible;
            },
            set value(visible: boolean) {
              selectedLayer.visible = visible;
            },
            changed: selectedLayer.location.locationChanged,
          },
          {
            svg: svg_controls_alt,
            backgroundScheme: "dark",
            enableTitle: "Show layer side panel",
            disableTitle: "Hide layer side panel",
          },
        ),
      );
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showLayerSidePanelButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    {
      const button = makeIcon({ text: "{}", title: "Edit JSON state" });
      this.registerEventListener(button, "click", () => {
        viewer.editJsonState();
      });
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showEditStateButton,
          button,
        ),
      );
      topRow.appendChild(button);
    }

    {
      const button = makeIcon({ svg: svg_camera, title: "Screenshot" });
      this.registerEventListener(button, "click", () => {
        viewer.showScreenshotDialog();
      });
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showScreenshotButton,
          button,
        ),
      );
      topRow.appendChild(button);
    }
    {
      const button = makeCopyUrlButton({
        title: "Copy URL to clipboard",
        onClick: () => viewer.copyUrlToClipboard(),
      });
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showCopyUrlButton,
          button,
        ),
      );
      topRow.appendChild(button);
    }
    {
      const { helpPanelState } = viewer;
      const button = this.registerDisposer(
        new CheckboxIcon(helpPanelState.location.watchableVisible, {
          text: "?",
          backgroundScheme: "dark",
          enableTitle: "Show help panel",
          disableTitle: "Hide help panel",
        }),
      );
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showHelpButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    {
      const { settingsPanelState } = viewer;
      const button = this.registerDisposer(
        new CheckboxIcon(settingsPanelState.location.watchableVisible, {
          svg: svg_settings,
          backgroundScheme: "dark",
          enableTitle: "Show settings panel",
          disableTitle: "Hide settings panel",
        }),
      );
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          viewer.uiControlVisibility.showSettingsButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    this.registerDisposer(
      new ElementVisibilityFromTrackableBoolean(
        makeDerivedWatchableValue(
          (...values: boolean[]) => values.reduce((a, b) => a || b, false),
          ...VIEWER_TOP_ROW_CONFIG_OPTIONS.map(
            (key) => viewer.uiControlVisibility[key],
          ),
        ),
        topRow,
      ),
    );

    gridContainer.appendChild(topRow);

    this.sidePanelManager = this.registerDisposer(
      new SidePanelManager(
        viewer.display,
        viewer.layout.element,
        viewer.visibility,
      ),
    );
    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: viewer.layerListPanelState.location,
        makePanel: () =>
          new LayerListPanel(
            this.sidePanelManager,
            viewer.layerSpecification,
            viewer.layerListPanelState,
            viewer.layerPanelVisibility,
            viewer.uiControlVisibility.showLayerPanel,
          ),
      }),
    );
    this.registerDisposer(
      new LayerSidePanelManager(
        this.sidePanelManager,
        viewer.selectedLayer.addRef(),
      ),
    );
    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: viewer.selectionDetailsState.location,
        makePanel: () =>
          new SelectionDetailsPanel(
            this.sidePanelManager,
            viewer.selectionDetailsState,
            viewer.layerSpecification,
            viewer.selectedLayer,
          ),
      }),
    );
    gridContainer.appendChild(this.sidePanelManager.element);

    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: viewer.statisticsDisplayState.location,
        makePanel: () =>
          new StatisticsPanel(
            this.sidePanelManager,
            viewer.chunkQueueManager,
            viewer.statisticsDisplayState,
          ),
      }),
    );

    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: viewer.helpPanelState.location,
        makePanel: () => {
          const { inputEventBindings } = viewer;
          return new InputEventBindingHelpDialog(
            this.sidePanelManager,
            viewer.helpPanelState,
            [
              ["Global", inputEventBindings.global],
              ["Cross section view", inputEventBindings.sliceView],
              ["3-D projection view", inputEventBindings.perspectiveView],
            ],
            viewer.layerManager,
            viewer.globalToolBinder,
          );
        },
      }),
    );

    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: viewer.settingsPanelState.location,
        makePanel: () =>
          new ViewerSettingsPanel(
            this.sidePanelManager,
            viewer.settingsPanelState,
            viewer,
          ),
      }),
    );

    this.registerDisposer(
      new MultiToolPaletteManager(this.sidePanelManager, viewer.toolPalettes),
    );

    this.registerDisposer(
      viewer.state.stateReset.add(() => this.sidePanelManager.reset()),
    );
  }
}
