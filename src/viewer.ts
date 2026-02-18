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

import "#src/viewer.css";
import "#src/ui/layer_data_sources_tab.js";
import "#src/noselect.css";
import svg_camera from "ikonate/icons/camera.svg?raw";
import svg_controls_alt from "ikonate/icons/controls-alt.svg?raw";
import svg_layers from "ikonate/icons/layers.svg?raw";
import svg_list from "ikonate/icons/list.svg?raw";
import svg_settings from "ikonate/icons/settings.svg?raw";
import { debounce } from "lodash-es";
import {
  makeCoordinateSpace,
  TrackableCoordinateSpace,
} from "#src/coordinate_transform.js";
import { getDefaultCredentialsManager } from "#src/credentials_provider/default_manager.js";
import type { CredentialsManager } from "#src/credentials_provider/index.js";
import { SharedCredentialsManager } from "#src/credentials_provider/shared.js";
import { DataManagementContext } from "#src/data_management_context.js";
import { InputEventBindings as DataPanelInputEventBindings } from "#src/data_panel_layout.js";
import { getDefaultDataSourceProvider } from "#src/datasource/default_provider.js";
import type { DataSourceRegistry } from "#src/datasource/index.js";
import { StateShare, stateShareEnabled } from "#src/datasource/state_share.js";
import type { DisplayContext } from "#src/display_context.js";
import { TrackableWindowedViewport } from "#src/display_context.js";
import {
  HelpPanelState,
  InputEventBindingHelpDialog,
} from "#src/help/input_event_bindings.js";
import { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  addNewLayer,
  LayerManager,
  LayerSelectedValues,
  MouseSelectionState,
  SelectedLayerState,
  TopLevelLayerListSpecification,
  TrackableDataSelectionState,
  UserLayer,
} from "#src/layer/index.js";
import { LayerGroupViewer } from "#src/layer_group_viewer.js";
import { RootLayoutContainer } from "#src/layer_groups_layout.js";
import {
  CoordinateSpacePlaybackVelocity,
  DisplayPose,
  NavigationState,
  OrientationState,
  PlaybackManager,
  Position,
  TrackableCrossSectionZoom,
  TrackableDepthRange,
  TrackableDisplayDimensions,
  TrackableProjectionZoom,
  TrackableRelativeDisplayScales,
  WatchableDisplayDimensionRenderInfo,
} from "#src/navigation_state.js";
import { overlaysOpen } from "#src/overlay.js";
import { ScreenshotHandler } from "#src/python_integration/screenshots.js";
import { allRenderLayerRoles, RenderLayerRole } from "#src/renderlayer.js";
import { StatusMessage } from "#src/status.js";
import {
  ElementVisibilityFromTrackableBoolean,
  TrackableBoolean,
} from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  makeDerivedWatchableValue,
  observeWatchable,
  TrackableValue,
} from "#src/trackable_value.js";
import {
  LayerArchiveCountWidget,
  LayerListPanel,
  LayerListPanelState,
} from "#src/ui/layer_list_panel.js";
import { LayerSidePanelManager } from "#src/ui/layer_side_panel.js";
import { setupPositionDropHandlers } from "#src/ui/position_drag_and_drop.js";
import { ScreenshotDialog } from "#src/ui/screenshot_menu.js";
import { SelectionDetailsPanel } from "#src/ui/selection_details.js";
import { SidePanelManager } from "#src/ui/side_panel.js";
import { StateEditorDialog } from "#src/ui/state_editor.js";
import { StatisticsDisplayState, StatisticsPanel } from "#src/ui/statistics.js";
import { GlobalToolBinder, LocalToolBinder } from "#src/ui/tool.js";
import {
  MultiToolPaletteDropdownButton,
  MultiToolPaletteManager,
  MultiToolPaletteState,
} from "#src/ui/tool_palette.js";
import {
  ViewerSettingsPanel,
  ViewerSettingsPanelState,
} from "#src/ui/viewer_settings.js";
import { AutomaticallyFocusedElement } from "#src/util/automatic_focus.js";
import { TrackableRGB } from "#src/util/color.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeFromParent } from "#src/util/dom.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import { vec3 } from "#src/util/geom.js";
import {
  parseFixedLengthArray,
  verifyFinitePositiveFloat,
  verifyNonnegativeInt,
  verifyObject,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import {
  EventActionMap,
  KeyboardEventBinder,
} from "#src/util/keyboard_bindings.js";
import { ScreenshotManager } from "#src/util/screenshot_manager.js";
import { NullarySignal } from "#src/util/signal.js";
import {
  CompoundTrackable,
  optionallyRestoreFromJsonMember,
} from "#src/util/trackable.js";
import type {
  ViewerState,
  VisibilityPrioritySpecification,
} from "#src/viewer_state.js";
import { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";
import { AnnotationToolStatusWidget } from "#src/widget/annotation_tool_status.js";
import { CheckboxIcon } from "#src/widget/checkbox_icon.js";
import { makeIcon } from "#src/widget/icon.js";
import {
  MousePositionWidget,
  PositionWidget,
  registerDimensionToolForLayerGroupViewer,
  registerDimensionToolForUserLayer,
  registerDimensionToolForViewer,
} from "#src/widget/position_widget.js";
import { TrackableScaleBarOptions } from "#src/widget/scale_bar.js";

declare let NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS: any;

interface CreditLink {
  url: string;
  text: string;
}

declare let NEUROGLANCER_CREDIT_LINK: CreditLink | CreditLink[] | undefined;

export class InputEventBindings extends DataPanelInputEventBindings {
  global = new EventActionMap();
}

export const VIEWER_TOP_ROW_CONFIG_OPTIONS = [
  "showHelpButton",
  "showSettingsButton",
  "showEditStateButton",
  "showScreenshotButton",
  "showToolPaletteButton",
  "showLayerListPanelButton",
  "showSelectionPanelButton",
  "showLayerSidePanelButton",
  "showLocation",
  "showAnnotationToolStatus",
] as const;

export const VIEWER_UI_CONTROL_CONFIG_OPTIONS = [
  ...VIEWER_TOP_ROW_CONFIG_OPTIONS,
  "showLayerPanel",
  "showLayerHoverValues",
] as const;

export const VIEWER_UI_CONFIG_OPTIONS = [
  ...VIEWER_UI_CONTROL_CONFIG_OPTIONS,
  "showTopBar",
  "showUIControls",
  "showPanelBorders",
  "pickRadius",
] as const;

export type ViewerUIConfiguration = {
  [Key in (typeof VIEWER_UI_CONFIG_OPTIONS)[number]]: Key extends "pickRadius"
    ? TrackableValue<number>
    : TrackableBoolean;
};

export type ViewerUIOptions = {
  [Key in keyof ViewerUIConfiguration]: ViewerUIConfiguration[Key]["value"];
};

export function makeViewerUIConfiguration(): ViewerUIConfiguration {
  const config = {} as ViewerUIConfiguration;
  for (const key of VIEWER_UI_CONFIG_OPTIONS) {
    if (key === "pickRadius") {
      (config as any)[key] = new TrackableValue(5, verifyNonnegativeInt);
    } else {
      (config as any)[key] = new TrackableBoolean(true);
    }
  }
  return config;
}

function setViewerUiConfiguration(
  config: ViewerUIConfiguration,
  options: Partial<ViewerUIOptions>,
) {
  for (const key of VIEWER_UI_CONFIG_OPTIONS) {
    const value = options[key];
    if (value !== undefined) {
      config[key].value = value;
    }
  }
}

export interface ViewerOptions
  extends ViewerUIOptions,
    VisibilityPrioritySpecification {
  dataContext: Owned<DataManagementContext>;
  element: HTMLElement;
  credentialsManager: CredentialsManager;
  dataSourceProvider: Borrowed<DataSourceRegistry>;
  uiConfiguration: ViewerUIConfiguration;
  showLayerDialog: boolean;
  inputEventBindings: InputEventBindings;
  resetStateWhenEmpty: boolean;
}

const defaultViewerOptions =
  "undefined" !== typeof NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS
    ? NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS
    : {
        showLayerDialog: true,
        resetStateWhenEmpty: true,
      };

class TrackableViewerState extends CompoundTrackable {
  constructor(public viewer: Borrowed<Viewer>) {
    super();
    this.add("title", viewer.title);
    this.add("dimensions", viewer.coordinateSpace);
    this.add("relativeDisplayScales", viewer.relativeDisplayScales);
    this.add("displayDimensions", viewer.displayDimensions);
    this.add("position", viewer.position);
    this.add("velocity", viewer.velocity);
    this.add("crossSectionOrientation", viewer.crossSectionOrientation);
    this.add("crossSectionScale", viewer.crossSectionScale);
    this.add("crossSectionDepth", viewer.crossSectionDepthRange);
    this.add("projectionOrientation", viewer.projectionOrientation);
    this.add("projectionScale", viewer.projectionScale);
    this.add("projectionDepth", viewer.projectionDepthRange);
    this.add("layers", viewer.layerSpecification);
    this.add("showAxisLines", viewer.showAxisLines);
    this.add("wireFrame", viewer.wireFrame);
    this.add("enableAdaptiveDownsampling", viewer.enableAdaptiveDownsampling);
    this.add("showScaleBar", viewer.showScaleBar);
    this.add("showDefaultAnnotations", viewer.showDefaultAnnotations);

    this.add("showSlices", viewer.showPerspectiveSliceViews);
    this.add(
      "hideCrossSectionBackground3D",
      viewer.hideCrossSectionBackground3D,
    );
    this.add(
      "gpuMemoryLimit",
      viewer.dataContext.chunkQueueManager.capacities.gpuMemory.sizeLimit,
    );
    this.add("prefetch", viewer.dataContext.chunkQueueManager.enablePrefetch);
    this.add(
      "systemMemoryLimit",
      viewer.dataContext.chunkQueueManager.capacities.systemMemory.sizeLimit,
    );
    this.add(
      "concurrentDownloads",
      viewer.dataContext.chunkQueueManager.capacities.download.itemLimit,
    );
    this.add("selectedLayer", viewer.selectedLayer);
    this.add("crossSectionBackgroundColor", viewer.crossSectionBackgroundColor);
    this.add(
      "projectionBackgroundColor",
      viewer.perspectiveViewBackgroundColor,
    );
    this.add("layout", viewer.layout);
    this.add("statistics", viewer.statisticsDisplayState);
    this.add("helpPanel", viewer.helpPanelState);
    this.add("settingsPanel", viewer.settingsPanelState);
    this.add("selection", viewer.selectionDetailsState);
    this.add("layerListPanel", viewer.layerListPanelState);
    this.add("partialViewport", viewer.partialViewport);
    this.add("selectedStateServer", viewer.selectedStateServer);
    this.add("toolBindings", viewer.toolBinder);
    this.add("toolPalettes", viewer.toolPalettes);
  }

  restoreState(obj: any) {
    const { viewer } = this;
    super.restoreState(obj);
    // Handle legacy properties
    verifyOptionalObjectProperty(obj, "navigation", (navObj) => {
      verifyObject(navObj);
      verifyOptionalObjectProperty(navObj, "pose", (poseObj) => {
        verifyObject(poseObj);
        verifyOptionalObjectProperty(poseObj, "position", (positionObj) => {
          verifyObject(positionObj);
          optionallyRestoreFromJsonMember(
            positionObj,
            "voxelCoordinates",
            viewer.position,
          );
          verifyOptionalObjectProperty(
            positionObj,
            "voxelSize",
            (voxelSizeObj) => {
              // Handle legacy voxelSize representation
              const voxelSize = parseFixedLengthArray(
                new Float64Array(3),
                voxelSizeObj,
                verifyFinitePositiveFloat,
              );
              for (let i = 0; i < 3; ++i) {
                voxelSize[i] *= 1e-9;
              }
              viewer.coordinateSpace.value = makeCoordinateSpace({
                valid: false,
                names: ["x", "y", "z"],
                units: ["m", "m", "m"],
                scales: voxelSize,
              });
            },
          );
        });
        optionallyRestoreFromJsonMember(
          poseObj,
          "orientation",
          viewer.crossSectionOrientation,
        );
      });
      optionallyRestoreFromJsonMember(
        navObj,
        "zoomFactor",
        viewer.crossSectionScale.legacyJsonView,
      );
    });
    optionallyRestoreFromJsonMember(
      obj,
      "perspectiveOrientation",
      viewer.projectionOrientation,
    );
    optionallyRestoreFromJsonMember(
      obj,
      "perspectiveZoom",
      viewer.projectionScale.legacyJsonView,
    );
    optionallyRestoreFromJsonMember(
      obj,
      "perspectiveViewBackgroundColor",
      viewer.perspectiveViewBackgroundColor,
    );
  }

  reset() {
    super.reset();
    this.viewer.sidePanelManager.reset();
  }
}

export class Viewer extends RefCounted implements ViewerState {
  title = new TrackableValue<string | undefined>(undefined, verifyString);
  coordinateSpace = new TrackableCoordinateSpace();
  position = this.registerDisposer(new Position(this.coordinateSpace));
  velocity = this.registerDisposer(
    new CoordinateSpacePlaybackVelocity(this.coordinateSpace),
  );
  relativeDisplayScales = this.registerDisposer(
    new TrackableRelativeDisplayScales(this.coordinateSpace),
  );
  displayDimensions = this.registerDisposer(
    new TrackableDisplayDimensions(this.coordinateSpace),
  );
  displayDimensionRenderInfo = this.registerDisposer(
    new WatchableDisplayDimensionRenderInfo(
      this.relativeDisplayScales.addRef(),
      this.displayDimensions.addRef(),
    ),
  );
  crossSectionOrientation = this.registerDisposer(new OrientationState());
  crossSectionScale = this.registerDisposer(
    new TrackableCrossSectionZoom(this.displayDimensionRenderInfo.addRef()),
  );
  projectionOrientation = this.registerDisposer(new OrientationState());
  crossSectionDepthRange = this.registerDisposer(
    new TrackableDepthRange(-10, this.displayDimensionRenderInfo),
  );
  projectionDepthRange = this.registerDisposer(
    new TrackableDepthRange(-50, this.displayDimensionRenderInfo),
  );
  projectionScale = this.registerDisposer(
    new TrackableProjectionZoom(this.displayDimensionRenderInfo.addRef()),
  );
  navigationState = this.registerDisposer(
    new NavigationState(
      new DisplayPose(
        this.position.addRef(),
        this.displayDimensionRenderInfo.addRef(),
        this.crossSectionOrientation.addRef(),
      ),
      this.crossSectionScale.addRef(),
      this.crossSectionDepthRange.addRef(),
    ),
  );
  perspectiveNavigationState = this.registerDisposer(
    new NavigationState(
      new DisplayPose(
        this.position.addRef(),
        this.displayDimensionRenderInfo.addRef(),
        this.projectionOrientation.addRef(),
      ),
      this.projectionScale.addRef(),
      this.projectionDepthRange.addRef(),
    ),
  );
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager());
  selectedLayer = this.registerDisposer(
    new SelectedLayerState(this.layerManager.addRef()),
  );
  showAxisLines = new TrackableBoolean(true, true);
  wireFrame = new TrackableBoolean(false, false);
  enableAdaptiveDownsampling = new TrackableBoolean(true, true);
  showScaleBar = new TrackableBoolean(true, true);
  showPerspectiveSliceViews = new TrackableBoolean(true, true);
  hideCrossSectionBackground3D = new TrackableBoolean(false, false);
  visibleLayerRoles = allRenderLayerRoles();
  showDefaultAnnotations = new TrackableBoolean(true, true);
  crossSectionBackgroundColor = new TrackableRGB(
    vec3.fromValues(0.5, 0.5, 0.5),
  );
  perspectiveViewBackgroundColor = new TrackableRGB(vec3.fromValues(0, 0, 0));
  scaleBarOptions = new TrackableScaleBarOptions();
  partialViewport = new TrackableWindowedViewport();
  statisticsDisplayState = new StatisticsDisplayState();
  helpPanelState = new HelpPanelState();
  settingsPanelState = new ViewerSettingsPanelState();
  layerSelectedValues = this.registerDisposer(
    new LayerSelectedValues(this.layerManager, this.mouseState),
  );
  selectionDetailsState = this.registerDisposer(
    new TrackableDataSelectionState(
      this.coordinateSpace,
      this.layerSelectedValues,
    ),
  );
  selectedStateServer = new TrackableValue<string>("", verifyString);
  layerListPanelState = new LayerListPanelState();

  resetInitiated = new NullarySignal();

  screenshotHandler: ScreenshotHandler;
  screenshotManager: ScreenshotManager;

  get chunkManager() {
    return this.dataContext.chunkManager;
  }
  get chunkQueueManager() {
    return this.dataContext.chunkQueueManager;
  }

  layerSpecification: TopLevelLayerListSpecification;
  layout: RootLayoutContainer;
  sidePanelManager: SidePanelManager;

  state: TrackableViewerState;

  dataContext: Owned<DataManagementContext>;
  visibility: WatchableVisibilityPriority;
  inputEventBindings: InputEventBindings;
  element: HTMLElement;
  dataSourceProvider: Borrowed<DataSourceRegistry>;

  uiConfiguration: ViewerUIConfiguration;

  private makeUiControlVisibilityState(
    key: (typeof VIEWER_UI_CONTROL_CONFIG_OPTIONS)[number],
  ) {
    const showUIControls = this.uiConfiguration.showUIControls;
    const showTopBar = this.uiConfiguration.showTopBar;
    const option = this.uiConfiguration[key];
    const isTopBarControl = (
      VIEWER_TOP_ROW_CONFIG_OPTIONS as readonly string[]
    ).includes(key as string);
    return this.registerDisposer(
      makeDerivedWatchableValue(
        (a, b, c) => {
          return a && (!isTopBarControl || b) && c;
        },
        showUIControls,
        showTopBar,
        option,
      ),
    );
  }

  /**
   * Logical and of each `VIEWER_UI_CONTROL_CONFIG_OPTIONS` option with the value of showUIControls.
   */
  uiControlVisibility: {
    [key in (typeof VIEWER_UI_CONTROL_CONFIG_OPTIONS)[number]]: WatchableValueInterface<boolean>;
  } = <any>{};

  showLayerDialog: boolean;
  resetStateWhenEmpty: boolean;

  get inputEventMap() {
    return this.inputEventBindings.global;
  }

  visible = true;

  constructor(
    public display: DisplayContext,
    options: Partial<ViewerOptions> = {},
  ) {
    super();
    this.screenshotHandler = this.registerDisposer(new ScreenshotHandler(this));
    this.screenshotManager = this.registerDisposer(new ScreenshotManager(this));
    const {
      dataContext = new DataManagementContext(display.gl, display),
      visibility = new WatchableVisibilityPriority(
        WatchableVisibilityPriority.VISIBLE,
      ),
      inputEventBindings = {
        global: new EventActionMap(),
        sliceView: new EventActionMap(),
        perspectiveView: new EventActionMap(),
      },
      element = display.makeCanvasOverlayElement(),

      uiConfiguration = makeViewerUIConfiguration(),
      dataSourceProvider = (() => {
        const { credentialsManager = getDefaultCredentialsManager() } = options;
        const sharedCredentialsManager = this.registerDisposer(
          new SharedCredentialsManager(credentialsManager, dataContext.rpc),
        );
        const kvStoreContext = this.registerDisposer(
          new SharedKvStoreContext(
            dataContext.chunkManager,
            sharedCredentialsManager,
          ),
        );
        return getDefaultDataSourceProvider({
          credentialsManager: sharedCredentialsManager,
          kvStoreContext,
        });
      })(),
    } = options;
    this.visibility = visibility;
    this.inputEventBindings = inputEventBindings;
    this.element = element;

    this.dataSourceProvider = dataSourceProvider;
    this.uiConfiguration = uiConfiguration;

    this.registerDisposer(
      observeWatchable((value) => {
        this.display.applyWindowedViewportToElement(element, value);
      }, this.partialViewport),
    );

    this.registerDisposer(() => removeFromParent(this.element));

    this.dataContext = this.registerDisposer(dataContext);

    setViewerUiConfiguration(uiConfiguration, options);

    const optionsWithDefaults = { ...defaultViewerOptions, ...options };
    const { resetStateWhenEmpty, showLayerDialog } = optionsWithDefaults;

    for (const key of VIEWER_UI_CONTROL_CONFIG_OPTIONS) {
      this.uiControlVisibility[key] = this.makeUiControlVisibilityState(key);
    }
    this.registerDisposer(
      this.uiConfiguration.showPanelBorders.changed.add(() => {
        this.updateShowBorders();
      }),
    );

    this.showLayerDialog = showLayerDialog;
    this.resetStateWhenEmpty = resetStateWhenEmpty;

    this.layerSpecification = new TopLevelLayerListSpecification(
      this.display,
      this.dataSourceProvider,
      this.layerManager,
      this.chunkManager,
      this.selectionDetailsState,
      this.selectedLayer,
      this.navigationState.coordinateSpace,
      this.navigationState.pose.position,
      this.globalToolBinder,
    );

    this.registerDisposer(
      display.updateStarted.add(() => {
        this.onUpdateDisplay();
      }),
    );

    this.showDefaultAnnotations.changed.add(() => {
      if (this.showDefaultAnnotations.value) {
        this.visibleLayerRoles.add(RenderLayerRole.DEFAULT_ANNOTATION);
      } else {
        this.visibleLayerRoles.delete(RenderLayerRole.DEFAULT_ANNOTATION);
      }
    });

    this.registerDisposer(
      this.navigationState.changed.add(() => {
        this.handleNavigationStateChanged();
      }),
    );

    // Debounce this call to ensure that a transient state does not result in the layer dialog being
    // shown.
    const maybeResetState = this.registerCancellable(
      debounce(() => {
        if (
          !this.wasDisposed &&
          this.layerManager.managedLayers.length === 0 &&
          this.resetStateWhenEmpty
        ) {
          // No layers, reset state.
          this.navigationState.reset();
          this.perspectiveNavigationState.pose.orientation.reset();
          this.perspectiveNavigationState.zoomFactor.reset();
          this.layout.restoreState("4panel-alt");
          this.resetInitiated.dispatch();
          if (
            !overlaysOpen &&
            this.showLayerDialog &&
            this.visibility.visible
          ) {
            addNewLayer(this.layerSpecification, this.selectedLayer);
          }
        }
      }),
    );
    this.layerManager.layersChanged.add(maybeResetState);
    maybeResetState();

    this.registerDisposer(
      this.dataContext.chunkQueueManager.visibleChunksChanged.add(() => {
        this.layerSelectedValues.handleLayerChange();
      }),
    );

    this.registerDisposer(
      this.dataContext.chunkQueueManager.visibleChunksChanged.add(() => {
        if (this.visible) {
          display.scheduleRedraw();
        }
      }),
    );

    this.makeUI();
    this.updateShowBorders();

    this.registerActionListeners();
    this.registerEventActionBindings();

    this.registerDisposer(
      setupPositionDropHandlers(element, this.navigationState.position),
    );

    this.state = new TrackableViewerState(this);

    this.registerDisposer(
      new PlaybackManager(this.display, this.position, this.velocity),
    );
  }

  private updateShowBorders() {
    const { element } = this;
    const className = "neuroglancer-show-panel-borders";
    if (this.uiConfiguration.showPanelBorders.value) {
      element.classList.add(className);
    } else {
      element.classList.remove(className);
    }
  }

  private makeUI() {
    const gridContainer = this.element;
    gridContainer.classList.add("neuroglancer-viewer");
    gridContainer.classList.add("neuroglancer-noselect");
    gridContainer.style.display = "flex";
    gridContainer.style.flexDirection = "column";

    const topRow = document.createElement("div");
    topRow.classList.add("neuroglancer-viewer-top-row");
    topRow.style.display = "flex";
    topRow.style.flexDirection = "row";
    topRow.style.alignItems = "stretch";

    const positionWidget = this.registerDisposer(
      new PositionWidget(
        this.navigationState.position,
        this.layerSpecification.coordinateSpaceCombiner,
        {
          velocity: this.velocity,
          getToolBinder: () => this.toolBinder,
        },
      ),
    );
    this.registerDisposer(
      new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation,
        positionWidget.element,
      ),
    );
    topRow.appendChild(positionWidget.element);

    const mousePositionWidget = this.registerDisposer(
      new MousePositionWidget(
        document.createElement("div"),
        this.mouseState,
        this.navigationState.coordinateSpace,
      ),
    );
    mousePositionWidget.element.style.flex = "1";
    mousePositionWidget.element.style.alignSelf = "center";
    this.registerDisposer(
      new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation,
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
      new AnnotationToolStatusWidget(this.selectedLayer, this.globalToolBinder),
    );
    topRow.appendChild(annotationToolStatus.element);
    this.registerDisposer(
      new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showAnnotationToolStatus,
        annotationToolStatus.element,
      ),
    );

    if (stateShareEnabled) {
      const stateShare = this.registerDisposer(new StateShare(this));
      topRow.appendChild(stateShare.element);
    }

    {
      const button = this.registerDisposer(
        new MultiToolPaletteDropdownButton(this.toolPalettes),
      ).element;

      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showToolPaletteButton,
          button,
        ),
      );
      topRow.appendChild(button);
    }

    {
      const { layerListPanelState } = this;
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
        this.registerDisposer(new LayerArchiveCountWidget(this.layerManager))
          .element,
      );
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showLayerListPanelButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    {
      const { selectionDetailsState } = this;
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
          this.uiControlVisibility.showSelectionPanelButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    {
      const { selectedLayer } = this;
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
          this.uiControlVisibility.showLayerSidePanelButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    {
      const button = makeIcon({ text: "{}", title: "Edit JSON state" });
      this.registerEventListener(button, "click", () => {
        this.editJsonState();
      });
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showEditStateButton,
          button,
        ),
      );
      topRow.appendChild(button);
    }

    {
      const button = makeIcon({ svg: svg_camera, title: "Screenshot" });
      this.registerEventListener(button, "click", () => {
        this.showScreenshotDialog();
      });
      this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showScreenshotButton,
          button,
        ),
      );
      topRow.appendChild(button);
    }

    {
      const { helpPanelState } = this;
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
          this.uiControlVisibility.showHelpButton,
          button.element,
        ),
      );
      topRow.appendChild(button.element);
    }

    {
      const { settingsPanelState } = this;
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
          this.uiControlVisibility.showSettingsButton,
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
            (key) => this.uiControlVisibility[key],
          ),
        ),
        topRow,
      ),
    );

    gridContainer.appendChild(topRow);

    // Note: for new states, the actual default layout is 4panel-alt.
    this.layout = this.registerDisposer(
      new RootLayoutContainer(this, "4panel"),
    );
    this.sidePanelManager = this.registerDisposer(
      new SidePanelManager(this.display, this.layout.element, this.visibility),
    );
    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: this.layerListPanelState.location,
        makePanel: () =>
          new LayerListPanel(
            this.sidePanelManager,
            this.layerSpecification,
            this.layerListPanelState,
          ),
      }),
    );
    this.registerDisposer(
      new LayerSidePanelManager(
        this.sidePanelManager,
        this.selectedLayer.addRef(),
      ),
    );
    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: this.selectionDetailsState.location,
        makePanel: () =>
          new SelectionDetailsPanel(
            this.sidePanelManager,
            this.selectionDetailsState,
            this.layerSpecification,
            this.selectedLayer,
          ),
      }),
    );
    gridContainer.appendChild(this.sidePanelManager.element);

    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: this.statisticsDisplayState.location,
        makePanel: () =>
          new StatisticsPanel(
            this.sidePanelManager,
            this.chunkQueueManager,
            this.statisticsDisplayState,
          ),
      }),
    );

    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: this.helpPanelState.location,
        makePanel: () => {
          const { inputEventBindings } = this;
          return new InputEventBindingHelpDialog(
            this.sidePanelManager,
            this.helpPanelState,
            [
              ["Global", inputEventBindings.global],
              ["Cross section view", inputEventBindings.sliceView],
              ["3-D projection view", inputEventBindings.perspectiveView],
            ],
            this.layerManager,
            this.globalToolBinder,
          );
        },
      }),
    );

    this.registerDisposer(
      this.sidePanelManager.registerPanel({
        location: this.settingsPanelState.location,
        makePanel: () =>
          new ViewerSettingsPanel(
            this.sidePanelManager,
            this.settingsPanelState,
            this,
          ),
      }),
    );

    this.registerDisposer(
      new MultiToolPaletteManager(this.sidePanelManager, this.toolPalettes),
    );

    const updateVisibility = () => {
      const shouldBeVisible = this.visibility.visible;
      if (shouldBeVisible !== this.visible) {
        gridContainer.style.visibility = shouldBeVisible ? "inherit" : "hidden";
        this.visible = shouldBeVisible;
      }
    };
    updateVisibility();
    this.registerDisposer(this.visibility.changed.add(updateVisibility));
  }

  /**
   * Called once by the constructor to set up event handlers.
   */
  private registerEventActionBindings() {
    const { element } = this;
    this.registerDisposer(new KeyboardEventBinder(element, this.inputEventMap));
    this.registerDisposer(new AutomaticallyFocusedElement(element));
  }

  bindAction<Data>(
    action: string,
    handler: (event: ActionEvent<Data>) => void,
  ) {
    this.registerDisposer(
      registerActionListener(this.element, action, handler),
    );
  }

  /**
   * Called once by the constructor to register the action listeners.
   */
  private registerActionListeners() {
    for (const action of ["recolor", "clear-segments"]) {
      this.bindAction(action, () => {
        this.layerManager.invokeAction(action);
      });
    }

    for (const action of ["select", "star"]) {
      this.bindAction(action, () => {
        this.mouseState.updateUnconditionally();
        this.layerManager.invokeAction(action);
      });
    }

    this.bindAction("help", () => this.toggleHelpPanel());

    for (let i = 1; i <= 9; ++i) {
      this.bindAction(`toggle-layer-${i}`, () => {
        const layer = this.layerManager.getLayerByNonArchivedIndex(i - 1);
        if (layer !== undefined) {
          layer.setVisible(!layer.visible);
        }
      });
      this.bindAction(`toggle-pick-layer-${i}`, () => {
        const layer = this.layerManager.getLayerByNonArchivedIndex(i - 1);
        if (layer !== undefined) {
          layer.pickEnabled = !layer.pickEnabled;
        }
      });
      this.bindAction(`select-layer-${i}`, () => {
        const layer = this.layerManager.getLayerByNonArchivedIndex(i - 1);
        if (layer !== undefined) {
          this.selectedLayer.layer = layer;
          this.selectedLayer.visible = true;
        }
      });
    }

    for (let i = 0; i < 26; ++i) {
      const uppercase = String.fromCharCode(65 + i);
      this.bindAction(`tool-${uppercase}`, () => {
        this.activateTool(uppercase);
      });
    }

    this.bindAction("annotate", () => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage(
          "The annotate command requires a layer to be selected.",
        );
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(
          `The selected layer (${JSON.stringify(
            selectedLayer.name,
          )}) does not have an active annotation tool.`,
        );
        return;
      }
      userLayer.tool.value.trigger(this.mouseState);
    });

    this.bindAction("toggle-axis-lines", () => this.showAxisLines.toggle());
    this.bindAction("toggle-scale-bar", () => this.showScaleBar.toggle());
    this.bindAction("toggle-default-annotations", () =>
      this.showDefaultAnnotations.toggle(),
    );
    this.bindAction("toggle-show-slices", () =>
      this.showPerspectiveSliceViews.toggle(),
    );
    this.bindAction("toggle-show-statistics", () => this.showStatistics());
  }

  toggleHelpPanel() {
    this.helpPanelState.location.visible =
      !this.helpPanelState.location.visible;
  }

  private toolInputEventMapBinder = (
    inputEventMap: EventActionMap,
    context: RefCounted,
  ) => {
    context.registerDisposer(
      this.inputEventBindings.sliceView.addParent(
        inputEventMap,
        Number.POSITIVE_INFINITY,
      ),
    );
    context.registerDisposer(
      this.inputEventBindings.perspectiveView.addParent(
        inputEventMap,
        Number.POSITIVE_INFINITY,
      ),
    );
  };

  public toolPalettes = new MultiToolPaletteState(this);

  public globalToolBinder = this.registerDisposer(
    new GlobalToolBinder(this.toolInputEventMapBinder, this.toolPalettes),
  );

  public toolBinder = this.registerDisposer(
    new LocalToolBinder(this, this.globalToolBinder),
  );

  activateTool(uppercase: string) {
    this.globalToolBinder.activate(uppercase);
  }

  deactivateTools() {
    this.globalToolBinder.deactivate();
  }

  editJsonState() {
    this.deactivateTools();
    new StateEditorDialog(this);
  }

  showScreenshotDialog() {
    this.deactivateTools();
    new ScreenshotDialog(this.screenshotManager);
  }

  showStatistics(value: boolean | undefined = undefined) {
    if (value === undefined) {
      value = !this.statisticsDisplayState.location.visible;
    }
    this.statisticsDisplayState.location.visible = value;
  }

  get gl() {
    return this.display.gl;
  }

  onUpdateDisplay() {
    if (this.visible) {
      this.dataContext.chunkQueueManager.chunkUpdateDeadline = null;
    }
  }

  private handleNavigationStateChanged() {
    if (this.visible) {
      const { chunkQueueManager } = this.dataContext;
      if (chunkQueueManager.chunkUpdateDeadline === null) {
        chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
      }
    }
  }

  isReady() {
    this.chunkQueueManager.flushPendingChunkUpdates();
    if (!this.display.isReady()) {
      return false;
    }
    for (const layer of this.layerManager.managedLayers) {
      if (!layer.isReady()) {
        return false;
      }
    }
    return true;
  }
}

registerDimensionToolForViewer(Viewer);
registerDimensionToolForLayerGroupViewer(LayerGroupViewer);
registerDimensionToolForUserLayer(UserLayer);
