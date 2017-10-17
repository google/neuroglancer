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
import {AvailableCapacity} from './chunk_manager/base';
import {ChunkManager, ChunkQueueManager} from './chunk_manager/frontend';
import {DisplayContext} from './display_context';
import {KeyBindingHelpDialog} from './help/key_bindings';
import {LayerManager, LayerSelectedValues, MouseSelectionState} from './layer';
import {LayerDialog} from './layer_dialog';
import {LayerPanel} from './layer_panel';
import {LayerListSpecification} from './layer_specification';
import * as L from './layout';
import {NavigationState, Pose} from './navigation_state';
import {overlaysOpen} from './overlay';
import {PositionStatusPanel} from './position_status_panel';
import {TrackableBoolean} from './trackable_boolean';
import {TrackableValue} from './trackable_value';
import {RefCounted} from './util/disposable';
import {removeFromParent} from './util/dom';
import {vec3} from './util/geom';
import {globalKeyboardHandlerStack, KeySequenceMap} from './util/keyboard_shortcut_handler';
import {NullarySignal} from './util/signal';
import {CompoundTrackable} from './util/trackable';
import {DataDisplayLayout, LAYOUTS} from './viewer_layouts';
import {ViewerState, VisibilityPrioritySpecification} from './viewer_state';
import {WatchableVisibilityPriority} from './visibility_priority/frontend';
import {GL} from './webgl/context';
import {RPC} from './worker_rpc';

require('./viewer.css');
require('./help_button.css');
require('./noselect.css');

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

export interface UIOptions {
  showHelpButton: boolean;
  showLayerDialog: boolean;
  showLayerPanel: boolean;
  showLocation: boolean;
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

  keyMap = new KeySequenceMap();
  keyCommands = new Map<string, (this: Viewer) => void>();
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

  visible = true;

  constructor(public display: DisplayContext, options: Partial<ViewerOptions> = {}) {
    super();

    const {
      dataContext = new DataManagementContext(display.gl),
      visibility = new WatchableVisibilityPriority(WatchableVisibilityPriority.VISIBLE),
    } = options;

    this.registerDisposer(dataContext);

    this.options = {...defaultViewerOptions, ...options, dataContext, visibility};

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

    let {keyCommands} = this;
    keyCommands.set('toggle-layout', function() {
      this.toggleLayout();
    });
    keyCommands.set('snap', function() {
      this.navigationState.pose.snap();
    });
    keyCommands.set('add-layer', function() {
      this.layerPanel.addLayerMenu();
      return true;
    });
    keyCommands.set('help', this.showHelpDialog);

    for (let i = 1; i <= 9; ++i) {
      keyCommands.set('toggle-layer-' + i, function() {
        let layerIndex = i - 1;
        let layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          let layer = layers[layerIndex];
          layer.setVisible(!layer.visible);
        }
      });
    }

    for (let command of ['recolor', 'clear-segments']) {
      keyCommands.set(command, function() {
        this.layerManager.invokeAction(command);
      });
    }

    keyCommands.set('toggle-axis-lines', function() {
      this.showAxisLines.toggle();
    });
    keyCommands.set('toggle-scale-bar', function() {
      this.showScaleBar.toggle();
    });
    this.keyCommands.set('toggle-show-slices', function() {
      this.showPerspectiveSliceViews.toggle();
    });
  }

  private makeUI() {
    let {display, options} = this;
    let gridContainer = document.createElement('div');
    gridContainer.setAttribute('class', 'gllayoutcontainer noselect');
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

    let keyboardHandlerDisposer: (() => void)|undefined;

    const updateVisibility = () => {
      const shouldBeVisible = this.visibility.visible;
      if (shouldBeVisible) {
        if (keyboardHandlerDisposer === undefined) {
          keyboardHandlerDisposer =
              globalKeyboardHandlerStack.push(this.keyMap, this.onKeyCommand.bind(this));
        }
        if (!this.visible) {
          gridContainer.style.visibility = 'inherit';
        }
      } else if (!shouldBeVisible && this.visible) {
        if (keyboardHandlerDisposer !== undefined) {
          keyboardHandlerDisposer!();
          keyboardHandlerDisposer = undefined;
        }
        if (this.visible) {
          gridContainer.style.visibility = 'hidden';
        }
      }
      this.visible = shouldBeVisible;
    };
    updateVisibility();
    this.registerDisposer(() => {
      if (keyboardHandlerDisposer !== undefined) {
        keyboardHandlerDisposer();
      }
    });
    this.registerDisposer(this.visibility.changed.add(updateVisibility));
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
    new KeyBindingHelpDialog(this.keyMap);
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

  private onKeyCommand(action: string) {
    let command = this.keyCommands.get(action);
    if (command && command.call(this)) {
      return true;
    }
    let {activePanel} = this.display;
    if (activePanel) {
      return activePanel.onKeyCommand(action);
    }
    return false;
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
