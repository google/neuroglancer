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
import {CapacitySpecification, ChunkManager, ChunkQueueManager} from 'neuroglancer/chunk_manager/frontend';
import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {InputEventBindings as DataPanelInputEventBindings} from 'neuroglancer/data_panel_layout';
import {DataSourceProvider} from 'neuroglancer/datasource';
import {getDefaultDataSourceProvider} from 'neuroglancer/datasource/default_provider';
import {DisplayContext} from 'neuroglancer/display_context';
import {InputEventBindingHelpDialog} from 'neuroglancer/help/input_event_bindings';
import {allRenderLayerRoles, LayerManager, LayerSelectedValues, MouseSelectionState, RenderLayerRole, SelectedLayerState} from 'neuroglancer/layer';
import {LayerDialog} from 'neuroglancer/layer_dialog';
import {RootLayoutContainer} from 'neuroglancer/layer_groups_layout';
import {TopLevelLayerListSpecification} from 'neuroglancer/layer_specification';
import {NavigationState, Pose} from 'neuroglancer/navigation_state';
import {overlaysOpen} from 'neuroglancer/overlay';
import {StatusMessage} from 'neuroglancer/status';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {makeDerivedWatchableValue, TrackableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {ContextMenu} from 'neuroglancer/ui/context_menu';
import {LayerInfoPanelContainer} from 'neuroglancer/ui/layer_side_panel';
import {MouseSelectionStateTooltipManager} from 'neuroglancer/ui/mouse_selection_state_tooltip';
import {setupPositionDropHandlers} from 'neuroglancer/ui/position_drag_and_drop';
import {StateEditorDialog} from 'neuroglancer/ui/state_editor';
import {AutomaticallyFocusedElement} from 'neuroglancer/util/automatic_focus';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {registerActionListener} from 'neuroglancer/util/event_action_map';
import {vec3} from 'neuroglancer/util/geom';
import {EventActionMap, KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {NullarySignal} from 'neuroglancer/util/signal';
import {CompoundTrackable} from 'neuroglancer/util/trackable';
import {ViewerState, VisibilityPrioritySpecification} from 'neuroglancer/viewer_state';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {AnnotationToolStatusWidget} from 'neuroglancer/widget/annotation_tool_status';
import {NumberInputWidget} from 'neuroglancer/widget/number_input_widget';
import {MousePositionWidget, PositionWidget, VoxelSizeWidget} from 'neuroglancer/widget/position_widget';
import {TrackableScaleBarOptions} from 'neuroglancer/widget/scale_bar';
import {makeTextIconButton} from 'neuroglancer/widget/text_icon_button';
import {RPC} from 'neuroglancer/worker_rpc';
import {openHttpRequest, sendHttpRequest, sendHttpJsonPostRequest} from 'neuroglancer/util/http_request';

require('./viewer.css');
require('neuroglancer/noselect.css');
require('neuroglancer/ui/button.css');

export function validateStateServer(obj: any) {
  return obj;
}


export class DataManagementContext extends RefCounted {
  worker = new Worker('chunk_worker.bundle.js');
  chunkQueueManager = this.registerDisposer(new ChunkQueueManager(new RPC(this.worker), this.gl, {
    gpuMemory: new CapacitySpecification({defaultItemLimit: 1e6, defaultSizeLimit: 1e9}),
    systemMemory: new CapacitySpecification({defaultItemLimit: 1e7, defaultSizeLimit: 2e9}),
    download: new CapacitySpecification(
        {defaultItemLimit: 32, defaultSizeLimit: Number.POSITIVE_INFINITY}),
  }));
  chunkManager = this.registerDisposer(new ChunkManager(this.chunkQueueManager));

  get rpc(): RPC {
    return this.chunkQueueManager.rpc!;
  }

  constructor(public gl: GL) {
    super();
    this.chunkQueueManager.registerDisposer(() => this.worker.terminate());
  }
}

export class InputEventBindings extends DataPanelInputEventBindings {
  global = new EventActionMap();
}

const viewerUiControlOptionKeys: (keyof ViewerUIControlConfiguration)[] = [
  'showHelpButton',
  'showEditStateButton',
  'showLayerPanel',
  'showLocation',
  'showAnnotationToolStatus',
  'showJsonPostButton'
];

const viewerOptionKeys: (keyof ViewerUIOptions)[] =
    ['showUIControls', 'showPanelBorders', ...viewerUiControlOptionKeys];

export class ViewerUIControlConfiguration {
  showHelpButton = new TrackableBoolean(true);
  showEditStateButton = new TrackableBoolean(true);
  showJsonPostButton = new TrackableBoolean(true);
  showLayerPanel = new TrackableBoolean(true);
  showLocation = new TrackableBoolean(true);
  showAnnotationToolStatus = new TrackableBoolean(true);
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
  showLayerPanel: boolean;
  showLocation: boolean;
  showPanelBorders: boolean;
  showAnnotationToolStatus: boolean;
  showJsonPostButton: boolean;
}

export interface ViewerOptions extends ViewerUIOptions, VisibilityPrioritySpecification {
  dataContext: Owned<DataManagementContext>;
  element: HTMLElement;
  dataSourceProvider: Borrowed<DataSourceProvider>;
  uiConfiguration: ViewerUIConfiguration;
  showLayerDialog: boolean;
  inputEventBindings: InputEventBindings;
  resetStateWhenEmpty: boolean;
}

const defaultViewerOptions = {
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
  return menu;
}

export class Viewer extends RefCounted implements ViewerState {
  navigationState = this.registerDisposer(new NavigationState());
  perspectiveNavigationState = new NavigationState(new Pose(this.navigationState.position), 1);
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager());
  selectedLayer = this.registerDisposer(new SelectedLayerState(this.layerManager.addRef()));
  showAxisLines = new TrackableBoolean(true, true);
  showScaleBar = new TrackableBoolean(true, true);
  showPerspectiveSliceViews = new TrackableBoolean(true, true);
  visibleLayerRoles = allRenderLayerRoles();
  showDefaultAnnotations = new TrackableBoolean(true, true);
  crossSectionBackgroundColor = new TrackableRGB(vec3.fromValues(0.5, 0.5, 0.5));
  scaleBarOptions = new TrackableScaleBarOptions();
  contextMenu: ContextMenu;

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
  jsonStateServer = new TrackableValue<string>('', validateStateServer)
  state = new CompoundTrackable();

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

  // showHelpButtonEffective: WatchableValueInterface<boolean>;
  // showEditStateButtonEffective: WatchableValueInterface<boolean>;
  // showLayerPanelEffective: WatchableValueInterface<boolean>;
  // showLocationEffective: WatchableValueInterface<boolean>;
  // showAnnotationToolStatusEffective: WatchableValueInterface<boolean>;

  showLayerDialog: boolean;
  resetStateWhenEmpty: boolean;

  get inputEventMap() {
    return this.inputEventBindings.global;
  }

  visible = true;

  constructor(public display: DisplayContext, options: Partial<ViewerOptions> = {}) {
    super();

    const {
      dataContext = new DataManagementContext(display.gl),
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
    this.visibility = visibility;
    this.inputEventBindings = inputEventBindings;
    this.element = element;
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
      this.display.onResize();
    }));

    this.showLayerDialog = showLayerDialog;
    this.resetStateWhenEmpty = resetStateWhenEmpty;

    this.layerSpecification = new TopLevelLayerListSpecification(
        this.dataSourceProvider, this.layerManager, this.chunkManager, this.layerSelectedValues,
        this.navigationState.voxelSize);

    this.registerDisposer(display.updateStarted.add(() => {
      this.onUpdateDisplay();
    }));
    this.registerDisposer(display.updateFinished.add(() => {
      this.onUpdateDisplayFinished();
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

    this.registerActionListeners();
    this.registerEventActionBindings();

    this.registerDisposer(setupPositionDropHandlers(element, this.navigationState.position));

    this.registerDisposer(new MouseSelectionStateTooltipManager(
        this.mouseState, this.layerManager, this.navigationState.voxelSize));
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
      const button = makeTextIconButton('🔗', 'Post JSON to state server');
      this.registerEventListener(button, 'click', () => {
        this.postJsonState();
      });
      this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
          this.uiControlVisibility.showJsonPostButton, button));
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
    layoutAndSidePanel.appendChild(
        this.registerDisposer(new LayerInfoPanelContainer(this.selectedLayer.addRef())).element);
    this.registerDisposer(this.selectedLayer.changed.add(() => this.display.onResize()));
    gridContainer.appendChild(layoutAndSidePanel);
    this.display.onResize();

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
    for (const action of ['recolor', 'clear-segments', ]) {
      this.bindAction(action, () => {
        this.layerManager.invokeAction(action);
      });
    }

    for (const action of ['select']) {
      this.bindAction(action, () => {
        this.mouseState.updateUnconditionally();
        this.layerManager.invokeAction(action);
      });
    }

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
    });

    this.bindAction('toggle-axis-lines', () => this.showAxisLines.toggle());
    this.bindAction('toggle-scale-bar', () => this.showScaleBar.toggle());
    this.bindAction('toggle-default-annotations', () => this.showDefaultAnnotations.toggle());
    this.bindAction('toggle-show-slices', () => this.showPerspectiveSliceViews.toggle());
  }

  showHelpDialog() {
    const {inputEventBindings} = this;
    new InputEventBindingHelpDialog([
      ['Global', inputEventBindings.global],
      ['Slice View', inputEventBindings.sliceView],
      ['Perspective View', inputEventBindings.perspectiveView],
    ]);
  }

  loadFromJsonUrl(){

    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('json_url')){
      
      let json_url = urlParams.get('json_url')
      console.log(json_url)
      try{
        sendHttpRequest( openHttpRequest(json_url!), 'json').then(response => {
          this.state.restoreState(response)
        })
        function RemoveParameterFromUrl(url: string, parameter: string) {
          return url
            .replace(new RegExp('[?&]' + parameter + '=[^&#]*(#.*)?$'), '$1')
            .replace(new RegExp('([?&])' + parameter + '=[^&]*&'), '$1');
        }
        RemoveParameterFromUrl(window.location.search, 'json_url');
      }
      catch (HttpError){
        console.log('failed to load from: ' + json_url)
      }

    }
  }
  postJsonState() {
    
    sendHttpJsonPostRequest(openHttpRequest(this.jsonStateServer.value, 'POST'),
                            this.state.toJSON(),"json").then(response => {
                              console.log(response);
                              var short_url =window.location.origin+"/?json_url="+this.jsonStateServer.value.replace(/\/$/,"")+"/"+response;
                              alert(short_url);
                              //="?json_url="+this.jsonStateServer.value+response;
                            })

  }
  editJsonState() {
    new StateEditorDialog(this);
  }

  get gl() {
    return this.display.gl;
  }

  onUpdateDisplay() {
    if (this.visible) {
      this.dataContext.chunkQueueManager.chunkUpdateDeadline = null;
    }
  }

  onUpdateDisplayFinished() {
    if (this.visible) {
      this.mouseState.updateIfStale();
    }
  }

  private handleNavigationStateChanged() {
    if (this.visible) {
      let {chunkQueueManager} = this.dataContext;
      if (chunkQueueManager.chunkUpdateDeadline === null) {
        chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
      }
    }
    this.mouseState.stale = true;
  }
}
