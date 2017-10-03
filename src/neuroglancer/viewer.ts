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
import {AvailableCapacity} from 'neuroglancer/chunk_manager/base';
import {ChunkManager, ChunkQueueManager} from 'neuroglancer/chunk_manager/frontend';
import {DisplayContext} from 'neuroglancer/display_context';
import {InputEventBindingHelpDialog} from 'neuroglancer/help/input_event_bindings';
import {LayerManager, LayerSelectedValues, MouseSelectionState} from 'neuroglancer/layer';
import {LayerDialog} from 'neuroglancer/layer_dialog';
import {LayerPanel} from 'neuroglancer/layer_panel';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import * as L from 'neuroglancer/layout';
import {NavigationState, Pose} from 'neuroglancer/navigation_state';
import {overlaysOpen} from 'neuroglancer/overlay';
import {PositionStatusPanel} from 'neuroglancer/position_status_panel';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {AutomaticallyFocusedElement} from 'neuroglancer/util/automatic_focus';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {registerActionListener} from 'neuroglancer/util/event_action_map';
import {vec3} from 'neuroglancer/util/geom';
import {EventActionMap, KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {NullarySignal} from 'neuroglancer/util/signal';
import {CompoundTrackable} from 'neuroglancer/util/trackable';
import {DataDisplayLayout, InputEventBindings as DataPanelInputEventBindings, LAYOUTS} from 'neuroglancer/viewer_layouts';
import {ViewerState, VisibilityPrioritySpecification} from 'neuroglancer/viewer_state';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {RPC} from 'neuroglancer/worker_rpc';

require('./viewer.css');
require('./help_button.css');
require('neuroglancer/noselect.css');

export function getLayoutByName(obj: any) {
  let layout = LAYOUTS.find(x => x[0] === obj);
  if (layout === undefined) {
    throw new Error(`Invalid layout name: ${JSON.stringify(obj)}.`);
  }
  return layout;
}

export function validateLayoutName(obj: any) {
  let layout = getLayoutByName(obj);
  return layout[0];
}

export class DataManagementContext extends RefCounted {
  worker = new Worker('chunk_worker.bundle.js');
  chunkQueueManager = this.registerDisposer(new ChunkQueueManager(new RPC(this.worker), this.gl, {
    gpuMemory: new AvailableCapacity(1e6, 1e9),
    systemMemory: new AvailableCapacity(1e7, 2e9),
    download: new AvailableCapacity(32, Number.POSITIVE_INFINITY)
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
}

export interface ViewerOptions extends UIOptions, VisibilityPrioritySpecification {
  dataContext: DataManagementContext;
}

const defaultViewerOptions = {
  showHelpButton: true,
  showLayerDialog: true,
  showLayerPanel: true,
  showLocation: true,
};

export class Viewer extends RefCounted implements ViewerState {
  navigationState = this.registerDisposer(new NavigationState());
  perspectiveNavigationState = new NavigationState(new Pose(this.navigationState.position), 1);
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager());
  showAxisLines = new TrackableBoolean(true, true);
  dataDisplayLayout: DataDisplayLayout;
  showScaleBar = new TrackableBoolean(true, true);
  showPerspectiveSliceViews = new TrackableBoolean(true, true);

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

  layerSpecification: LayerListSpecification;
  layoutName = new TrackableValue<string>(LAYOUTS[0][0], validateLayoutName);

  state = new CompoundTrackable();

  private options: ViewerOptions;

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
    } = options;

    this.registerDisposer(dataContext);

    this.options = {
      ...defaultViewerOptions,
      ...options,
      dataContext,
      visibility,
      inputEventBindings,
    };

    this.layerSpecification = new LayerListSpecification(
        this.layerManager, this.chunkManager, this.layerSelectedValues,
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
    state.add('layout', this.layoutName);

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
      if (!this.wasDisposed && this.layerManager.managedLayers.length === 0) {
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

    this.layoutName.changed.add(() => {
      if (this.dataDisplayLayout !== undefined) {
        let element = this.dataDisplayLayout.rootElement;
        this.dataDisplayLayout.dispose();
        this.createDataDisplayLayout(element);
      }
    });
  }

  private makeUI() {
    let {display, options} = this;
    let gridContainer = document.createElement('div');
    gridContainer.setAttribute('class', 'gllayoutcontainer neuroglancer-noselect');
    let {container} = display;
    container.appendChild(gridContainer);
    this.registerDisposer(() => removeFromParent(gridContainer));

    let uiElements: L.Handler[] = [];

    if (options.showHelpButton || options.showLocation) {
      let rowElements: L.Handler[] = [];
      if (options.showLocation) {
        rowElements.push(L.withFlex(1, element => new PositionStatusPanel(element, this)));
      }
      if (options.showHelpButton) {
        rowElements.push(element => {
          let button = document.createElement('button');
          button.className = 'help-button';
          button.textContent = '?';
          button.title = 'Help';
          element.appendChild(button);
          this.registerEventListener(button, 'click', () => {
            this.showHelpDialog();
          });
        });
      }
      uiElements.push(L.box('row', rowElements));
    }

    if (options.showLayerPanel) {
      uiElements.push(element => {
        this.layerPanel = new LayerPanel(element, this.layerSpecification);
      });
    }

    uiElements.push(L.withFlex(1, element => {
      this.createDataDisplayLayout(element);
    }));

    L.box('column', uiElements)(gridContainer);
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

    {
      const element = gridContainer;
      this.registerDisposer(new KeyboardEventBinder(element, this.inputEventMap));
      this.registerDisposer(new AutomaticallyFocusedElement(element));

      const bindAction = (action: string, handler: () => void) => {
        registerActionListener(element, action, handler);
      };

      for (const action of ['recolor', 'clear-segments', ]) {
        bindAction(action, () => {
          this.layerManager.invokeAction(action);
        });
      }

      for (const action of ['select', 'annotate', ]) {
        bindAction(action, () => {
          this.mouseState.updateUnconditionally();
          this.layerManager.invokeAction(action);
        });
      }

      bindAction('toggle-layout', () => this.toggleLayout());
      bindAction('add-layer', () => this.layerPanel.addLayerMenu());
      bindAction('help', () => this.showHelpDialog());

      for (let i = 1; i <= 9; ++i) {
        bindAction(`toggle-layer-${i}`, () => {
          const layerIndex = i - 1;
          const layers = this.layerManager.managedLayers;
          if (layerIndex < layers.length) {
            let layer = layers[layerIndex];
            layer.setVisible(!layer.visible);
          }
        });
      }

      bindAction('toggle-axis-lines', () => this.showAxisLines.toggle());
      bindAction('toggle-scale-bar', () => this.showScaleBar.toggle());
      bindAction('toggle-show-slices', () => this.showPerspectiveSliceViews.toggle());
    }
  }

  createDataDisplayLayout(element: HTMLElement) {
    let layoutCreator = getLayoutByName(this.layoutName.value)[1];
    this.dataDisplayLayout = layoutCreator(element, this);
  }

  toggleLayout() {
    let existingLayout = getLayoutByName(this.layoutName.value);
    let layoutIndex = LAYOUTS.indexOf(existingLayout);
    let newLayout = LAYOUTS[(layoutIndex + 1) % LAYOUTS.length];
    this.layoutName.value = newLayout[0];
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
