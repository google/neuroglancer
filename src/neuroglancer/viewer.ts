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

import debounce from 'lodash/debounce';
import {MultiStepAnnotationTool} from 'neuroglancer/annotation/annotation';
import {AnnotationUserLayer} from 'neuroglancer/annotation/user_layer';
import {authFetch, initAuthTokenSharedValue} from 'neuroglancer/authentication/frontend';
import {CapacitySpecification, ChunkManager, ChunkQueueManager, FrameNumberCounter} from 'neuroglancer/chunk_manager/frontend';
import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {InputEventBindings as DataPanelInputEventBindings} from 'neuroglancer/data_panel_layout';
import {DataSourceProvider} from 'neuroglancer/datasource';
import {getDefaultDataSourceProvider} from 'neuroglancer/datasource/default_provider';
import {Differ} from 'neuroglancer/differ/differ';
import {DisplayContext} from 'neuroglancer/display_context';
import {InputEventBindingHelpDialog} from 'neuroglancer/help/input_event_bindings';
import {ActionMode, ActionState, allRenderLayerRoles, LayerManager, LayerSelectedValues, ManagedUserLayer, MouseSelectionState, RenderLayerRole, SelectedLayerState, UserLayer} from 'neuroglancer/layer';
import {LayerDialog} from 'neuroglancer/layer_dialog';
import {RootLayoutContainer} from 'neuroglancer/layer_groups_layout';
import {TopLevelLayerListSpecification} from 'neuroglancer/layer_specification';
import {NavigationState, Pose} from 'neuroglancer/navigation_state';
import {overlaysOpen} from 'neuroglancer/overlay';
import {getSaveToAddressBar, UserPreferencesDialog} from 'neuroglancer/preferences/user_preferences';
import {saverToggle, SaveState, storageAccessible} from 'neuroglancer/save_state/save_state';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {isSegmentationUserLayerWithGraph} from 'neuroglancer/segmentation_user_layer_with_graph';
import {StatusMessage} from 'neuroglancer/status';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeDerivedWatchableValue, TrackableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {ContextMenu} from 'neuroglancer/ui/context_menu';
import {DragResizablePanel} from 'neuroglancer/ui/drag_resize';
import {LayerInfoPanelContainer} from 'neuroglancer/ui/layer_side_panel';
import {MouseSelectionStateTooltipManager} from 'neuroglancer/ui/mouse_selection_state_tooltip';
import {setupPositionDropHandlers} from 'neuroglancer/ui/position_drag_and_drop';
import {StateEditorDialog} from 'neuroglancer/ui/state_editor';
import {StatisticsDisplayState, StatisticsPanel} from 'neuroglancer/ui/statistics';
import {removeParameterFromUrl, UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';
import {UserReportDialog} from 'neuroglancer/user_report/user_report';
import {AutomaticallyFocusedElement} from 'neuroglancer/util/automatic_focus';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {registerActionListener} from 'neuroglancer/util/event_action_map';
import {vec3} from 'neuroglancer/util/geom';
import {EventActionMap, KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {NullarySignal} from 'neuroglancer/util/signal';
import {CompoundTrackable} from 'neuroglancer/util/trackable';
import {getCachedJson} from 'neuroglancer/util/trackable';
import {ViewerState, VisibilityPrioritySpecification} from 'neuroglancer/viewer_state';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {findWhatsNew, WhatsNewDialog} from 'neuroglancer/whats_new/whats_new';
import {AnnotationToolStatusWidget} from 'neuroglancer/widget/annotation_tool_status';
import {NumberInputWidget} from 'neuroglancer/widget/number_input_widget';
import {MousePositionWidget, PositionWidget, VoxelSizeWidget} from 'neuroglancer/widget/position_widget';
import {TrackableScaleBarOptions} from 'neuroglancer/widget/scale_bar';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import {RPC} from 'neuroglancer/worker_rpc';

declare var NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS: any

import './viewer.css';
import 'neuroglancer/noselect.css';
import 'neuroglancer/ui/button.css';

export function validateStateServer(obj: any) {
  return obj;
}

export class DataManagementContext extends RefCounted {
  worker = new Worker('chunk_worker.bundle.js');
  chunkQueueManager = this.registerDisposer(
      new ChunkQueueManager(new RPC(this.worker), this.gl, this.frameNumberCounter, {
        gpuMemory: new CapacitySpecification({defaultItemLimit: 1e6, defaultSizeLimit: 1e9}),
        systemMemory: new CapacitySpecification({defaultItemLimit: 1e7, defaultSizeLimit: 2e9}),
        download: new CapacitySpecification(
            {defaultItemLimit: 32, defaultSizeLimit: Number.POSITIVE_INFINITY}),
        compute: new CapacitySpecification({defaultItemLimit: 128, defaultSizeLimit: 5e8}),
      }));
  chunkManager = this.registerDisposer(new ChunkManager(this.chunkQueueManager));

  get rpc(): RPC {
    return this.chunkQueueManager.rpc!;
  }

  constructor(public gl: GL, public frameNumberCounter: FrameNumberCounter) {
    super();
    this.chunkQueueManager.registerDisposer(() => this.worker.terminate());
  }
}

export class InputEventBindings extends DataPanelInputEventBindings {
  global = new EventActionMap();
}

const viewerUiControlOptionKeys: (keyof ViewerUIControlConfiguration)[] = [
  'showHelpButton', 'showEditStateButton', 'showRedoButton', 'showUndoButton', 'showLayerPanel',
  'showLocation', 'showAnnotationToolStatus', 'showJsonPostButton', 'showUserPreferencesButton',
  'showWhatsNewButton', 'showBugButton', 'showSaveButton', 'showHistoryButton', 'showChangesButton'
];

const viewerOptionKeys: (keyof ViewerUIOptions)[] =
    ['showUIControls', 'showPanelBorders', ...viewerUiControlOptionKeys];

export class ViewerUIControlConfiguration {
  showHelpButton = new TrackableBoolean(true);
  showEditStateButton = new TrackableBoolean(true);
  showRedoButton = new TrackableBoolean(true);
  showUndoButton = new TrackableBoolean(true);
  showJsonPostButton = new TrackableBoolean(true);
  showUserPreferencesButton = new TrackableBoolean(true);
  showBugButton = new TrackableBoolean(true);
  showLayerPanel = new TrackableBoolean(true);
  showLocation = new TrackableBoolean(true);
  showAnnotationToolStatus = new TrackableBoolean(true);
  showWhatsNewButton = new TrackableBoolean(true);
  showSaveButton = new TrackableBoolean(true);
  showHistoryButton = new TrackableBoolean(true);
  showChangesButton = new TrackableBoolean(true);
}

export class ViewerUIConfiguration extends ViewerUIControlConfiguration {
  /**
   * If set to false, all UI controls (controlled individually by the options below) are disabled.
   */
  showUIControls = new TrackableBoolean(true);
  showPanelBorders = new TrackableBoolean(true);
}


function setViewerUiConfiguration(
    config: ViewerUIConfiguration, options: Partial<ViewerUIOptions>) {
  for (const key of viewerOptionKeys) {
    const value = options[key];
    if (value !== undefined) {
      config[key].value = value;
    }
  }
}

interface ViewerUIOptions {
  showUIControls: boolean;
  showHelpButton: boolean;
  showEditStateButton: boolean;
  showRedoButton: boolean;
  showUndoButton: boolean;
  showLayerPanel: boolean;
  showLocation: boolean;
  showPanelBorders: boolean;
  showAnnotationToolStatus: boolean;
  showJsonPostButton: boolean;
  showUserPreferencesButton: boolean;
  showWhatsNewButton: boolean;
  showBugButton: boolean;
  showSaveButton: boolean;
  showHistoryButton: boolean;
  showChangesButton: boolean;
}

export interface ViewerOptions extends ViewerUIOptions, VisibilityPrioritySpecification {
  dataContext: Owned<DataManagementContext>;
  element: HTMLElement;
  dataSourceProvider: Borrowed<DataSourceProvider>;
  uiConfiguration: ViewerUIConfiguration;
  showLayerDialog: boolean;
  inputEventBindings: InputEventBindings;
  resetStateWhenEmpty: boolean;
  minSidePanelSize: number;
}

const defaultViewerOptions = 'undefined' !== typeof NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS ?
    NEUROGLANCER_OVERRIDE_DEFAULT_VIEWER_OPTIONS :
    {
      showLayerDialog: true,
      resetStateWhenEmpty: true,
    };

function makeViewerContextMenu(viewer: Viewer) {
  const menu = new ContextMenu();
  const {element} = menu;
  element.classList.add('neuroglancer-viewer-context-menu');
  const addLimitWidget = (label: string, limit: TrackableValue<number>) => {
    const widget = menu.registerDisposer(new NumberInputWidget(limit, {label}));
    widget.element.classList.add('neuroglancer-viewer-context-menu-limit-widget');
    element.appendChild(widget.element);
  };
  addLimitWidget('GPU memory limit', viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit);
  addLimitWidget('System memory limit', viewer.chunkQueueManager.capacities.systemMemory.sizeLimit);
  addLimitWidget(
      'Concurrent chunk requests', viewer.chunkQueueManager.capacities.download.itemLimit);

  const addCheckbox = (label: string, value: TrackableBoolean) => {
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    const checkbox = menu.registerDisposer(new TrackableBooleanCheckbox(value));
    labelElement.appendChild(checkbox.element);
    element.appendChild(labelElement);
  };
  addCheckbox('Show axis lines', viewer.showAxisLines);
  addCheckbox('Show scale bar', viewer.showScaleBar);
  addCheckbox('Show cross sections in 3-d', viewer.showPerspectiveSliceViews);
  addCheckbox('Show default annotations', viewer.showDefaultAnnotations);
  addCheckbox('Show chunk statistics', viewer.statisticsDisplayState.visible);
  return menu;
}

export enum UrlType {
  json = 1,
  raw,
}

export class Viewer extends RefCounted implements ViewerState {
  navigationState = this.registerDisposer(new NavigationState());
  minSidePanelSize = 290;
  perspectiveNavigationState = new NavigationState(new Pose(this.navigationState.position), 1);
  saver?: SaveState;
  hashBinding?: UrlHashBinding;
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager(this.messageWithUndo.bind(this)));
  selectedLayer = this.registerDisposer(new SelectedLayerState(this.layerManager.addRef()));
  showAxisLines = new TrackableBoolean(true, true);
  showScaleBar = new TrackableBoolean(true, true);
  showPerspectiveSliceViews = new TrackableBoolean(true, true);
  visibleLayerRoles = allRenderLayerRoles();
  showDefaultAnnotations = new TrackableBoolean(true, true);
  sliceViewPrefetchingEnabled = new TrackableBoolean(true, true);
  crossSectionBackgroundColor = new TrackableRGB(vec3.fromValues(0.5, 0.5, 0.5));
  perspectiveViewBackgroundColor = new TrackableRGB(vec3.fromValues(0, 0, 0));
  scaleBarOptions = new TrackableScaleBarOptions();
  contextMenu: ContextMenu;
  statisticsDisplayState = new StatisticsDisplayState();

  layerSelectedValues =
      this.registerDisposer(new LayerSelectedValues(this.layerManager, this.mouseState));
  resetInitiated = new NullarySignal();

  get chunkManager() {
    return this.dataContext.chunkManager;
  }
  get chunkQueueManager() {
    return this.dataContext.chunkQueueManager;
  }

  layerSpecification: TopLevelLayerListSpecification;
  layout: RootLayoutContainer;

  stateServer = new TrackableValue<string>('', validateStateServer);
  jsonStateServer = new TrackableValue<string>('', validateStateServer);
  state = new CompoundTrackable();
  differ = new Differ(this.state);

  dataContext: Owned<DataManagementContext>;
  visibility: WatchableVisibilityPriority;
  inputEventBindings: InputEventBindings;
  element: HTMLElement;
  dataSourceProvider: Borrowed<DataSourceProvider>;

  uiConfiguration: ViewerUIConfiguration;

  private makeUiControlVisibilityState(key: keyof ViewerUIOptions) {
    const showUIControls = this.uiConfiguration.showUIControls;
    const option = this.uiConfiguration[key];
    return this.registerDisposer(
        makeDerivedWatchableValue((a, b) => a && b, showUIControls, option));
  }

  /**
   * Logical and of each of the above values with the value of showUIControls.
   */
  uiControlVisibility:
      {[key in keyof ViewerUIControlConfiguration]: WatchableValueInterface<boolean>} = <any>{};

  showLayerDialog: boolean;
  resetStateWhenEmpty: boolean;

  get inputEventMap() {
    return this.inputEventBindings.global;
  }

  visible = true;

  constructor(public display: DisplayContext, options: Partial<ViewerOptions> = {}) {
    super();

    const {
      dataContext = new DataManagementContext(display.gl, display),
      visibility = new WatchableVisibilityPriority(WatchableVisibilityPriority.VISIBLE),
      inputEventBindings = {
        global: new EventActionMap(),
        sliceView: new EventActionMap(),
        perspectiveView: new EventActionMap(),
      },
      element = display.makeCanvasOverlayElement(),
      dataSourceProvider =
          getDefaultDataSourceProvider({credentialsManager: defaultCredentialsManager}),
      uiConfiguration = new ViewerUIConfiguration(),
    } = options;
    this.minSidePanelSize = options.minSidePanelSize || this.minSidePanelSize;
    this.visibility = visibility;
    this.inputEventBindings = inputEventBindings;
    this.element = element;
    this.element.id = 'neuroglancerViewer';
    this.dataSourceProvider = dataSourceProvider;
    this.uiConfiguration = uiConfiguration;

    this.registerDisposer(() => removeFromParent(this.element));

    this.dataContext = this.registerDisposer(dataContext);

    setViewerUiConfiguration(uiConfiguration, options);

    const optionsWithDefaults = {...defaultViewerOptions, ...options};
    const {
      resetStateWhenEmpty,
      showLayerDialog,
    } = optionsWithDefaults;

    for (const key of viewerUiControlOptionKeys) {
      this.uiControlVisibility[key] = this.makeUiControlVisibilityState(key);
    }
    this.registerDisposer(this.uiConfiguration.showPanelBorders.changed.add(() => {
      this.updateShowBorders();
    }));

    this.showLayerDialog = showLayerDialog;
    this.resetStateWhenEmpty = resetStateWhenEmpty;

    this.layerSpecification = new TopLevelLayerListSpecification(
        this.dataSourceProvider, this.layerManager, this.chunkManager, this.layerSelectedValues,
        this.navigationState.voxelSize);

    this.registerDisposer(display.updateStarted.add(() => {
      this.onUpdateDisplay();
    }));

    this.showDefaultAnnotations.changed.add(() => {
      if (this.showDefaultAnnotations.value) {
        this.visibleLayerRoles.add(RenderLayerRole.DEFAULT_ANNOTATION);
      } else {
        this.visibleLayerRoles.delete(RenderLayerRole.DEFAULT_ANNOTATION);
      }
    });

    const {state} = this;
    state.add('layers', this.layerSpecification);
    state.add('navigation', this.navigationState);
    state.add('showAxisLines', this.showAxisLines);
    state.add('showScaleBar', this.showScaleBar);
    state.add('showDefaultAnnotations', this.showDefaultAnnotations);

    state.add('perspectiveOrientation', this.perspectiveNavigationState.pose.orientation);
    state.add('perspectiveZoom', this.perspectiveNavigationState.zoomFactor);
    state.add('showSlices', this.showPerspectiveSliceViews);
    state.add('gpuMemoryLimit', this.dataContext.chunkQueueManager.capacities.gpuMemory.sizeLimit);
    state.add(
        'systemMemoryLimit', this.dataContext.chunkQueueManager.capacities.systemMemory.sizeLimit);
    state.add(
        'concurrentDownloads', this.dataContext.chunkQueueManager.capacities.download.itemLimit);
    state.add('stateServer', this.stateServer);
    state.add('jsonStateServer', this.jsonStateServer);
    state.add('selectedLayer', this.selectedLayer);
    state.add('crossSectionBackgroundColor', this.crossSectionBackgroundColor);
    state.add('perspectiveViewBackgroundColor', this.perspectiveViewBackgroundColor);

    this.registerDisposer(this.navigationState.changed.add(() => {
      this.handleNavigationStateChanged();
    }));

    this.layerManager.initializePosition(this.navigationState.position);

    this.registerDisposer(
        this.layerSpecification.voxelCoordinatesSet.add((voxelCoordinates: vec3) => {
          this.navigationState.position.setVoxelCoordinates(voxelCoordinates);
        }));

    this.registerDisposer(
        this.layerSpecification.spatialCoordinatesSet.add((spatialCoordinates: vec3) => {
          const {position} = this.navigationState;
          vec3.copy(position.spatialCoordinates, spatialCoordinates);
          position.markSpatialCoordinatesChanged();
        }));


    // Debounce this call to ensure that a transient state does not result in the layer dialog being
    // shown.
    const maybeResetState = this.registerCancellable(debounce(() => {
      if (!this.wasDisposed && this.layerManager.managedLayers.length === 0 &&
          this.resetStateWhenEmpty) {
        // No layers, reset state.
        this.navigationState.reset();
        this.perspectiveNavigationState.pose.orientation.reset();
        this.perspectiveNavigationState.zoomFactor.reset();
        this.resetInitiated.dispatch();
        if (!overlaysOpen && this.showLayerDialog && this.visibility.visible) {
          new LayerDialog(this.layerSpecification);
        }
      }
    }));
    this.layerManager.layersChanged.add(maybeResetState);
    maybeResetState();

    this.registerDisposer(this.dataContext.chunkQueueManager.visibleChunksChanged.add(() => {
      this.layerSelectedValues.handleLayerChange();
    }));

    this.registerDisposer(this.dataContext.chunkQueueManager.visibleChunksChanged.add(() => {
      if (this.visible) {
        display.scheduleRedraw();
      }
    }));

    this.makeUI();
    this.updateShowBorders();

    state.add('layout', this.layout);


    state.add('statistics', this.statisticsDisplayState);

    this.registerActionListeners();
    this.registerEventActionBindings();

    this.registerDisposer(setupPositionDropHandlers(element, this.navigationState.position));

    this.registerDisposer(new MouseSelectionStateTooltipManager(
        this.mouseState, this.layerManager, this.navigationState.voxelSize));

    initAuthTokenSharedValue(this.dataContext.rpc);

    const maybeAddOrRemoveAnnotationShortcuts = this.annotationShortcutControllerFactory();
    this.registerDisposer(
        this.selectedLayer.changed.add(() => maybeAddOrRemoveAnnotationShortcuts()));
    const error = document.getElementById('neuroglancer-error');
    if (error) {
      error.style.display = 'none';
    }
    if (!localStorage.getItem('neuroglancer-disableWhatsNew')) {
      findWhatsNew(this);
    }
  }

  private updateShowBorders() {
    const {element} = this;
    const className = 'neuroglancer-show-panel-borders';
    if (this.uiConfiguration.showPanelBorders.value) {
      element.classList.add(className);
    } else {
      element.classList.remove(className);
    }
  }

  private makeUI() {
    const gridContainer = this.element;
    gridContainer.classList.add('neuroglancer-viewer');
    gridContainer.classList.add('neuroglancer-noselect');
    gridContainer.style.display = 'flex';
    gridContainer.style.flexDirection = 'column';

    const topRow = document.createElement('div');
    topRow.title = 'Right click for settings';
    topRow.classList.add('neuroglancer-viewer-top-row');
    const contextMenu = this.contextMenu = this.registerDisposer(makeViewerContextMenu(this));
    contextMenu.registerParent(topRow);
    topRow.style.display = 'flex';
    topRow.style.flexDirection = 'row';
    topRow.style.alignItems = 'stretch';

    const voxelSizeWidget = this.registerDisposer(
        new VoxelSizeWidget(document.createElement('div'), this.navigationState.voxelSize));
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation, voxelSizeWidget.element));
    topRow.appendChild(voxelSizeWidget.element);

    const positionWidget = this.registerDisposer(new PositionWidget(this.navigationState.position));
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation, positionWidget.element));
    topRow.appendChild(positionWidget.element);

    const mousePositionWidget = this.registerDisposer(new MousePositionWidget(
        document.createElement('div'), this.mouseState, this.navigationState.voxelSize));
    mousePositionWidget.element.style.flex = '1';
    mousePositionWidget.element.style.alignSelf = 'center';
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showLocation, mousePositionWidget.element));
    topRow.appendChild(mousePositionWidget.element);

    const annotationToolStatus =
        this.registerDisposer(new AnnotationToolStatusWidget(this.selectedLayer));
    topRow.appendChild(annotationToolStatus.element);
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        this.uiControlVisibility.showAnnotationToolStatus, annotationToolStatus.element));

    // TODO: Differ does not work with legacy saving
    const isLegacySavingOn = getSaveToAddressBar().value;
    const unsupported = ' is currently unsupported in Legacy Saving Mode';
    {
      const button = makeTextIconButton('⇦', `Undo${isLegacySavingOn ? unsupported : ''}`);
      button.id = 'neuroglancer-undo-button';
      button.classList.add('disabled');
      this.registerEventListener(button, 'click', () => {
        if (this.differ) {
          this.differ.rollback();
        }
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showUndoButton, button));
      topRow.appendChild(button);
    }

    {
      const button = makeTextIconButton('⚬', 'Change History');
      button.id = 'neuroglancer-change-button';
      this.registerEventListener(button, 'click', () => {
        this.showChanges();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showChangesButton, button));
      // TODO: Enable button once show changes button is complete
      // topRow.appendChild(button);
    }

    {
      const button = makeTextIconButton('⇨', `Redo${isLegacySavingOn ? unsupported : ''}`);
      button.id = 'neuroglancer-redo-button';
      button.classList.add('disabled');
      this.registerEventListener(button, 'click', () => {
        if (this.differ) {
          this.differ.rollforward();
        }
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showRedoButton, button));
      topRow.appendChild(button);
    }

    {
      const button = document.createElement('button');
      button.id = 'neuroglancer-saver-button';
      button.classList.add('ng-saver', 'neuroglancer-icon-button');
      button.innerText = 'Share';
      button.title = 'Save Changes';
      if (!storageAccessible()) {
        button.classList.add('fallback');
        button.title =
            `Cannot access Local Storage. Unsaved changes will be lost! Use Legacy Saving to allow for auto saving.`;
      }
      if (storageAccessible() && getSaveToAddressBar().value) {
        button.classList.add('inactive');
        button.title =
            `Save State has been disabled because Legacy Saving has been turned on in User Preferences.`;
      }
      if (this.saver && !this.saver.supported && this.saver.key) {
        const entry = this.saver.pull();
        button.classList.toggle('dirty', entry ? entry.dirty : true);
      }
      this.registerEventListener(button, 'click', () => {
        this.postJsonState(true);
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showSaveButton, button));
      topRow.appendChild(button);
    }

    {
      const button = makeTextIconButton('$', 'View Save History');
      this.registerEventListener(button, 'click', () => {
        this.showHistory();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showHistoryButton, button));
      topRow.appendChild(button);
    }

    {
      const button = makeTextIconButton('{}', 'Edit JSON state');
      this.registerEventListener(button, 'click', () => {
        this.editJsonState();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showEditStateButton, button));
      topRow.appendChild(button);
    }

    {
      const button = makeTextIconButton('⚙', 'Preferences');
      this.registerEventListener(button, 'click', () => {
        this.showPreferencesModal();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showUserPreferencesButton, button));
      topRow.appendChild(button);
    }

    {
      const button = makeTextIconButton('?', 'Help');
      this.registerEventListener(button, 'click', () => {
        this.showHelpDialog();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showHelpButton, button));
      topRow.appendChild(button);
    }

    {
      const button = makeTextIconButton('!', `What's New`);
      this.registerEventListener(button, 'click', () => {
        this.showWhatsNewDialog();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showWhatsNewButton, button));
      topRow.appendChild(button);
    }

    {
      const button = makeTextIconButton('🐞', 'Feedback');
      this.registerEventListener(button, 'click', async () => {
        this.display.draw();
        let raw_ss = (await require('html2canvas')(document.body)).toDataURL();
        let image = raw_ss.slice(raw_ss.indexOf('data:image/png;base64,') + 22);
        this.postJsonState();
        this.showReportDialog(image);
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showBugButton, button));
      topRow.appendChild(button);
    }

    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        makeDerivedWatchableValue(
            (...values: boolean[]) => values.reduce((a, b) => a || b, false),
            this.uiControlVisibility.showHelpButton, this.uiControlVisibility.showEditStateButton,
            this.uiControlVisibility.showLocation,
            this.uiControlVisibility.showAnnotationToolStatus),
        topRow));

    gridContainer.appendChild(topRow);

    const layoutAndSidePanel = document.createElement('div');
    layoutAndSidePanel.style.display = 'flex';
    layoutAndSidePanel.style.flex = '1';
    layoutAndSidePanel.style.flexDirection = 'row';
    this.layout = this.registerDisposer(new RootLayoutContainer(this, '4panel'));
    layoutAndSidePanel.appendChild(this.layout.element);
    const layerInfoPanel =
        this.registerDisposer(new LayerInfoPanelContainer(this.selectedLayer.addRef()));
    layoutAndSidePanel.appendChild(layerInfoPanel.element);
    const self = this;
    layerInfoPanel.registerDisposer(new DragResizablePanel(
        layerInfoPanel.element, {
          changed: self.selectedLayer.changed,
          get value() {
            return self.selectedLayer.visible;
          },
          set value(visible: boolean) {
            self.selectedLayer.visible = visible;
          }
        },
        this.selectedLayer.size, 'horizontal', this.minSidePanelSize));

    gridContainer.appendChild(layoutAndSidePanel);

    const statisticsPanel = this.registerDisposer(
        new StatisticsPanel(this.chunkQueueManager, this.statisticsDisplayState));
    gridContainer.appendChild(statisticsPanel.element);
    statisticsPanel.registerDisposer(new DragResizablePanel(
        statisticsPanel.element, this.statisticsDisplayState.visible,
        this.statisticsDisplayState.size, 'vertical'));

    const updateVisibility = () => {
      const shouldBeVisible = this.visibility.visible;
      if (shouldBeVisible !== this.visible) {
        gridContainer.style.visibility = shouldBeVisible ? 'inherit' : 'hidden';
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
    const {element} = this;
    this.registerDisposer(new KeyboardEventBinder(element, this.inputEventMap));
    this.registerDisposer(new AutomaticallyFocusedElement(element));
  }

  bindAction(action: string, handler: () => void) {
    this.registerDisposer(registerActionListener(this.element, action, handler));
  }

  /**
   * Called once by the constructor to register the action listeners.
   */
  private registerActionListeners() {
    for (const action
             of ['recolor', 'clear-segments', 'merge-selected', 'cut-selected',
                 'shatter-segment-equivalences']) {
      this.bindAction(action, () => {
        this.layerManager.invokeAction(action);
      });
    }

    for (const action of ['select', 'refresh-mesh']) {
      this.bindAction(action, () => {
        this.mouseState.updateUnconditionally();
        this.layerManager.invokeAction(action);
      });
    }

    const handleModeChange = (merge: boolean) => {
      this.mouseState.toggleAction();

      const mergeWhileInSplit = merge && this.mouseState.actionMode === ActionMode.SPLIT;
      const splitWhileInMerge = !merge && this.mouseState.actionMode === ActionMode.MERGE;
      const mergeOn = () => StatusMessage.showTemporaryMessage('Merge mode activated.');
      const splitOn = () => StatusMessage.showTemporaryMessage('Split mode activated.');
      const mergeOff = () => StatusMessage.showTemporaryMessage('Merge mode deactivated.');
      const splitOff = () => StatusMessage.showTemporaryMessage('Split mode deactivated.');

      if (mergeWhileInSplit) {
        this.mouseState.setMode(ActionMode.MERGE);
        mergeOn();
        splitOff();
        this.mouseState.toggleAction();
      } else if (splitWhileInMerge) {
        this.mouseState.setMode(ActionMode.SPLIT);
        splitOn();
        mergeOff();
        this.mouseState.toggleAction();
      } else if (this.mouseState.actionState === ActionState.INACTIVE) {
        if (this.mouseState.actionMode === ActionMode.MERGE) {
          mergeOff();
        } else {
          splitOff();
        }
        this.mouseState.setMode(ActionMode.NONE);
      } else {
        if (merge) {
          this.mouseState.setMode(ActionMode.MERGE);
          mergeOn();
        } else {
          this.mouseState.setMode(ActionMode.SPLIT);
          splitOn();
        }
      }
    };

    this.bindAction('two-point-merge', () => {
      handleModeChange(true);
    });

    this.bindAction('two-point-cut', () => {
      handleModeChange(false);
    });

    this.bindAction('help', () => this.showHelpDialog());

    for (let i = 1; i <= 9; ++i) {
      this.bindAction(`toggle-layer-${i}`, () => {
        const layerIndex = i - 1;
        const layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          let layer = layers[layerIndex];
          layer.setVisible(!layer.visible);
        }
      });
      this.bindAction(`select-layer-${i}`, () => {
        const layerIndex = i - 1;
        const layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          const layer = layers[layerIndex];
          this.selectedLayer.layer = layer;
          this.selectedLayer.visible = true;
        }
      });
    }

    this.bindAction('annotate', () => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage('The annotate command requires a layer to be selected.');
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(`The selected layer (${
            JSON.stringify(selectedLayer.name)}) does not have an active annotation tool.`);
        return;
      }
      userLayer.tool.value.trigger(this.mouseState);
      if (userLayer instanceof AnnotationUserLayer &&
          userLayer.linkedSegmentationLayer.layerName !== undefined) {
        const segLayer = userLayer.linkedSegmentationLayer.layer!.layer;
        if (segLayer instanceof SegmentationUserLayer) {
          if (isSegmentationUserLayerWithGraph(segLayer)) {
            segLayer.getRootOfSelectedSupervoxel().then(rootSegment => {
              userLayer.localAnnotations.get(userLayer.selectedAnnotation.value!.id)!.segments!
                  .push(rootSegment);
            });
          }
        }
      }
    });

    const actionCompleteAnnotation = (shortcut?: boolean) => {
      const selectedLayer = this.selectedLayer.layer;
      if (selectedLayer === undefined) {
        StatusMessage.showTemporaryMessage(
            'The complete annotate command requires a layer to be selected.');
        return;
      }
      const userLayer = selectedLayer.layer;
      if (userLayer === null || userLayer.tool.value === undefined) {
        StatusMessage.showTemporaryMessage(`The selected layer (${
            JSON.stringify(selectedLayer.name)}) does not have an active annotation tool.`);
        return;
      }
      (<MultiStepAnnotationTool>userLayer.tool.value).complete(shortcut);
    };

    this.bindAction('complete-annotation-viakey', () => actionCompleteAnnotation());
    this.bindAction('complete-annotation', () => actionCompleteAnnotation(true));

    this.bindAction('toggle-axis-lines', () => this.showAxisLines.toggle());
    this.bindAction('toggle-scale-bar', () => this.showScaleBar.toggle());
    this.bindAction('toggle-default-annotations', () => this.showDefaultAnnotations.toggle());
    this.bindAction('toggle-show-slices', () => this.showPerspectiveSliceViews.toggle());
    this.bindAction('toggle-show-statistics', () => this.showStatistics());
    this.bindAction('save-state', () => this.postJsonState(true));
    this.bindAction('save-state-getjson', () => {
      this.postJsonState(true, UrlType.json);
    });
    this.bindAction('save-state-getraw', () => {
      this.postJsonState(true, UrlType.raw);
    });
  }

  showHelpDialog() {
    const {inputEventBindings} = this;
    new InputEventBindingHelpDialog([
      ['Global', inputEventBindings.global],
      ['Slice View', inputEventBindings.sliceView],
      ['Perspective View', inputEventBindings.perspectiveView],
    ]);
  }

  showPreferencesModal() {
    new UserPreferencesDialog(this);
  }

  showWhatsNewDialog() {
    new WhatsNewDialog(this);
  }

  showReportDialog(image: string) {
    new UserReportDialog(this, image);
  }

  showSaveDialog(getUrlType?: UrlType, jsonString?: string) {
    this.saver!.showSaveDialog(this, jsonString, getUrlType);
  }

  showHistory() {
    this.saver!.showHistory(this);
  }

  showChanges() {
    this.differ!.showChanges(this);
  }

  promptJsonStateServer(message: string): void {
    let json_server_input =
        prompt(message, 'https://www.dynamicannotationframework.com/nglstate/post');
    if (json_server_input !== null) {
      this.jsonStateServer.value = json_server_input;
    } else {
      this.jsonStateServer.reset();
    }
  }

  loadFromJsonUrl() {
    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('json_url')) {
      let json_url = urlParams.get('json_url')!;
      history.replaceState(null, '', removeParameterFromUrl(window.location.href, 'json_url'));

      this.resetStateWhenEmpty = false;
      return StatusMessage
          .forPromise(
              authFetch(json_url).then(res => res.json()).then(response => {
                this.state.restoreState(response);
                if (this.saver) {
                  this.saver.push(true);
                }
              }),
              {
                initialMessage: `Retrieving state from json_url: ${json_url}.`,
                delay: true,
                errorPrefix: `Error retrieving state: `,
              })
          .finally(() => {
            this.resetStateWhenEmpty = true;
          });
    } else {
      return Promise.resolve();
    }
  }

  postJsonState(
      savestate?: boolean, getUrlType?: UrlType, retry?: boolean, callback: Function = () => {}) {
    // upload state to jsonStateServer (only if it's defined)
    if (savestate && this.saver) {
      const savedUrl = this.saver.savedUrl;
      const entry = this.saver.pull();
      if (savedUrl && !entry.dirty) {
        callback();
        this.showSaveDialog(getUrlType, this.saver.savedUrl);
        return;
      }
    }
    if (this.jsonStateServer.value || getUrlType) {
      if (this.jsonStateServer.value.length) {
        saverToggle(false);
        let postSuccess = false;
        StatusMessage.forPromise(
            authFetch(
                this.jsonStateServer.value,
                {method: 'POST', body: JSON.stringify(this.state.toJSON())})
                .then(res => res.json())
                .then(response => {
                  const savedUrl =
                      `${window.location.origin}${window.location.pathname}?json_url=${response}`;
                  const saverSupported = this.saver && this.saver.supported;
                  if (saverSupported) {
                    this.saver!.commit(response);
                  } else {
                    history.replaceState(null, '', savedUrl);
                  }
                  if (savestate) {
                    callback();
                    this.showSaveDialog(getUrlType, response);
                  }
                  StatusMessage.showTemporaryMessage(`Successfully shared state.`, 4000);
                  postSuccess = true;
                })
                // catch errors with upload and prompt the user if there was an error
                .catch(() => {
                  if (retry) {
                    this.promptJsonStateServer(
                        'State server could not be reached, try again or enter a new one.');
                    if (this.jsonStateServer.value) {
                      this.postJsonState(savestate, getUrlType);
                    } else {
                      StatusMessage.messageWithAction(
                          `Could not share state, no state server was found. `, [{message: 'Ok'}],
                          undefined, {color: 'yellow'});
                    }
                  } else {
                    StatusMessage.showTemporaryMessage(
                        `Could not access state server.`, 4000, {color: 'yellow'});
                  }
                })
                .finally(() => {
                  saverToggle(true);
                  if (!postSuccess && savestate) {
                    callback();
                    this.showSaveDialog(getUrlType);
                  }
                }),
            {
              initialMessage: `Posting state to ${this.jsonStateServer.value}.`,
              delay: true,
              errorPrefix: ''
            });
      } else {
        StatusMessage.showTemporaryMessage(`No state server found.`, 4000, {color: 'yellow'});
      }
    } else {
      if (savestate) {
        callback();
        this.showSaveDialog(getUrlType);
      }
    }
  }

  editJsonState() {
    new StateEditorDialog(this);
  }

  showStatistics(value: boolean|undefined = undefined) {
    if (value === undefined) {
      value = !this.statisticsDisplayState.visible.value;
    }
    this.statisticsDisplayState.visible.value = value;
  }

  get gl() {
    return this.display.gl;
  }

  onUpdateDisplay() {
    if (this.visible) {
      this.dataContext.chunkQueueManager.chunkUpdateDeadline = null;
    }
  }

  messageWithUndo(message: string, actionMessage: string, closeAfter: number = 10000) {
    const undo = this.getStateRevertingFunction();
    StatusMessage.messageWithAction(message, [{message: actionMessage, action: undo}], closeAfter);
  }

  private getStateRevertingFunction() {
    const currentState = getCachedJson(this.state).value;
    return () => {
      this.state.restoreState(currentState);
    };
  }

  private handleNavigationStateChanged() {
    if (this.visible) {
      let {chunkQueueManager} = this.dataContext;
      if (chunkQueueManager.chunkUpdateDeadline === null) {
        chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
      }
    }
  }

  private annotationShortcutControllerFactory() {
    let lastLayerSelected: UserLayer|null = null;
    let lastManagerLayerSelected: ManagedUserLayer|undefined;
    const maybeAddOrRemoveAnnotationShortcuts = () => {
      if (this.selectedLayer.layer !== lastManagerLayerSelected) {
        if (lastLayerSelected && lastLayerSelected instanceof AnnotationUserLayer) {
          lastLayerSelected.disableAnnotationShortcuts();
        }
        const selectedLayer = this.selectedLayer.layer;
        if (selectedLayer) {
          const userLayer = selectedLayer.layer;
          if (userLayer instanceof AnnotationUserLayer) {
            userLayer.enableAnnotationShortcuts();
          }
          lastLayerSelected = userLayer;
        }
        lastManagerLayerSelected = this.selectedLayer.layer;
      }
    };
    return maybeAddOrRemoveAnnotationShortcuts;
  }

  initializeSaver() {
    const hashBinding = this.legacyViewerSetupHashBinding();
    this.saver = this.registerDisposer(new SaveState(this.state, this));
    if (!this.saver.supported) {
      // Fallback to register state change handler has legacy urlHashBinding if saver is not
      // supported
      this.differ.legacy = this;
      hashBinding.legacy.fallback();
    }
  }

  legacyViewerSetupHashBinding() {
    // Backwards compatibility for state links
    const hashBinding = this.registerDisposer(new UrlHashBinding(this.state, this));
    this.hashBinding = hashBinding;
    this.registerDisposer(hashBinding.parseError.changed.add(() => {
      const {value} = hashBinding.parseError;
      if (value !== undefined) {
        const status = new StatusMessage();
        status.setErrorMessage(`Error parsing state: ${value.message}`);
        console.log('Error parsing state', value);
      }
      hashBinding.parseError;
    }));
    StatusMessage.showTemporaryMessage(
        `RAW URLs will soon be Deprecated. Please use JSON URLs whenever available.`, 10000);
    hashBinding.updateFromUrlHash();

    return hashBinding;
  }
}
