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
import {LayerManager, LayerSelectedValues, MouseSelectionState} from 'neuroglancer/layer';
import {LayerDialog} from 'neuroglancer/layer_dialog';
import {RootLayoutContainer} from 'neuroglancer/layer_groups_layout';
import {LayerPanel} from 'neuroglancer/layer_panel';
import {TopLevelLayerListSpecification} from 'neuroglancer/layer_specification';
import {NavigationState, Pose} from 'neuroglancer/navigation_state';
import {overlaysOpen} from 'neuroglancer/overlay';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {ContextMenu} from 'neuroglancer/ui/context_menu';
import {setupPositionDropHandlers} from 'neuroglancer/ui/position_drag_and_drop';
import {AutomaticallyFocusedElement} from 'neuroglancer/util/automatic_focus';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {registerActionListener} from 'neuroglancer/util/event_action_map';
import {vec3} from 'neuroglancer/util/geom';
import {EventActionMap, KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {NullarySignal} from 'neuroglancer/util/signal';
import {CompoundTrackable} from 'neuroglancer/util/trackable';
import {ViewerState, VisibilityPrioritySpecification} from 'neuroglancer/viewer_state';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {NumberInputWidget} from 'neuroglancer/widget/number_input_widget';
import {MousePositionWidget, PositionWidget, VoxelSizeWidget} from 'neuroglancer/widget/position_widget';
import {RPC} from 'neuroglancer/worker_rpc';

require('./viewer.css');
require('./help_button.css');
require('neuroglancer/noselect.css');
require('neuroglancer/ui/button.css');

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

export interface UIOptions {
  showHelpButton: boolean;
  showLayerDialog: boolean;
  showLayerPanel: boolean;
  showLocation: boolean;
  inputEventBindings: InputEventBindings;
  resetStateWhenEmpty: boolean;
}

export interface ViewerOptions extends UIOptions, VisibilityPrioritySpecification {
  dataContext: DataManagementContext;
  element: HTMLElement;
  dataSourceProvider: DataSourceProvider;
}

const defaultViewerOptions = {
  showHelpButton: true,
  showLayerDialog: true,
  showLayerPanel: true,
  showLocation: true,
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
  return menu;
}

export class Viewer extends RefCounted implements ViewerState {
  navigationState = this.registerDisposer(new NavigationState());
  perspectiveNavigationState = new NavigationState(new Pose(this.navigationState.position), 1);
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager());
  showAxisLines = new TrackableBoolean(true, true);
  showScaleBar = new TrackableBoolean(true, true);
  showPerspectiveSliceViews = new TrackableBoolean(true, true);
  contextMenu: ContextMenu;
  
  layerPanel: LayerPanel;
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

  state = new CompoundTrackable();

  options: ViewerOptions;

  get dataContext() {
    return this.options.dataContext;
  }
  get visibility() {
    return this.options.visibility;
  }

  get inputEventBindings() {
    return this.options.inputEventBindings;
  }

  get inputEventMap() {
    return this.inputEventBindings.global;
  }

  get element() {
    return this.options.element;
  }

  get dataSourceProvider() {
    return this.options.dataSourceProvider;
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
    } = options;

    this.registerDisposer(() => removeFromParent(this.element));

    this.registerDisposer(dataContext);

    this.options = {
      ...defaultViewerOptions,
      ...options,
      dataContext,
      visibility,
      inputEventBindings,
      element,
      dataSourceProvider,
    };

    this.layerSpecification = new TopLevelLayerListSpecification(
        this.dataSourceProvider, this.layerManager, this.chunkManager, this.layerSelectedValues,
        this.navigationState.voxelSize);

    this.registerDisposer(display.updateStarted.add(() => {
      this.onUpdateDisplay();
    }));
    this.registerDisposer(display.updateFinished.add(() => {
      this.onUpdateDisplayFinished();
    }));

    const {state} = this;
    state.add('layers', this.layerSpecification);
    state.add('navigation', this.navigationState);
    state.add('showAxisLines', this.showAxisLines);
    state.add('showScaleBar', this.showScaleBar);

    state.add('perspectiveOrientation', this.perspectiveNavigationState.pose.orientation);
    state.add('perspectiveZoom', this.perspectiveNavigationState.zoomFactor);
    state.add('showSlices', this.showPerspectiveSliceViews);
    state.add('gpuMemoryLimit', this.dataContext.chunkQueueManager.capacities.gpuMemory.sizeLimit);
    state.add(
        'systemMemoryLimit', this.dataContext.chunkQueueManager.capacities.systemMemory.sizeLimit);
    state.add(
        'concurrentDownloads', this.dataContext.chunkQueueManager.capacities.download.itemLimit);

    this.registerDisposer(this.navigationState.changed.add(() => {
      this.handleNavigationStateChanged();
    }));

    this.layerManager.initializePosition(this.navigationState.position);

    this.registerDisposer(
        this.layerSpecification.voxelCoordinatesSet.add((voxelCoordinates: vec3) => {
          this.navigationState.position.setVoxelCoordinates(voxelCoordinates);
        }));

    // Debounce this call to ensure that a transient state does not result in the layer dialog being
    // shown.
    const maybeResetState = this.registerCancellable(debounce(() => {
      if (!this.wasDisposed && this.layerManager.managedLayers.length === 0 &&
          this.options.resetStateWhenEmpty) {
        // No layers, reset state.
        this.navigationState.reset();
        this.perspectiveNavigationState.pose.orientation.reset();
        this.perspectiveNavigationState.zoomFactor.reset();
        this.resetInitiated.dispatch();
        if (!overlaysOpen && this.options.showLayerDialog && this.visibility.visible) {
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
    state.add('layout', this.layout);

    this.registerActionListeners();
    this.registerEventActionBindings();

    this.registerDisposer(setupPositionDropHandlers(element, this.navigationState.position));
  }

  private makeUI() {
    const {options} = this;
    const gridContainer = this.element;
    gridContainer.classList.add('neuroglancer-viewer');
    gridContainer.classList.add('neuroglancer-noselect');
    gridContainer.style.display = 'flex';
    gridContainer.style.flexDirection = 'column';
    if (options.showHelpButton || options.showLocation) {
      const topRow = document.createElement('div');
      topRow.title = 'Right click for settings';
      const contextMenu = this.contextMenu = this.registerDisposer(makeViewerContextMenu(this));
      contextMenu.registerParent(topRow);
      topRow.style.display = 'flex';
      topRow.style.flexDirection = 'row';
      topRow.style.alignItems = 'stretch';
      if (options.showLocation) {
        const voxelSizeWidget = this.registerDisposer(
            new VoxelSizeWidget(document.createElement('div'), this.navigationState.voxelSize));
        topRow.appendChild(voxelSizeWidget.element);
        const positionWidget =
            this.registerDisposer(new PositionWidget(this.navigationState.position));
        topRow.appendChild(positionWidget.element);
        const mousePositionWidget = this.registerDisposer(new MousePositionWidget(
            document.createElement('div'), this.mouseState, this.navigationState.voxelSize));
        mousePositionWidget.element.style.flex = '1';
        mousePositionWidget.element.style.alignSelf = 'center';
        topRow.appendChild(mousePositionWidget.element);
      }
      if (options.showHelpButton) {
        let button = document.createElement('div');
        button.className = 'neuroglancer-help-button neuroglancer-button';
        button.textContent = '?';
        button.title = 'Help';
        this.registerEventListener(button, 'click', () => {
          this.showHelpDialog();
        });
        topRow.appendChild(button);
      }
      gridContainer.appendChild(topRow);
    }

    this.layout = this.registerDisposer(new RootLayoutContainer(this, '4panel'));
    gridContainer.appendChild(this.layout.element);
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

    for (const action of ['select', 'annotate', ]) {
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
    }

    this.bindAction('toggle-axis-lines', () => this.showAxisLines.toggle());
    this.bindAction('toggle-scale-bar', () => this.showScaleBar.toggle());
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
