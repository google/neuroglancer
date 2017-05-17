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
import {KeyBindingHelpDialog} from 'neuroglancer/help/key_bindings';
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
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {globalKeyboardHandlerStack, KeySequenceMap} from 'neuroglancer/util/keyboard_shortcut_handler';
import {NullarySignal} from 'neuroglancer/util/signal';
import {CompoundTrackable} from 'neuroglancer/util/trackable';
import {DataDisplayLayout, LAYOUTS} from 'neuroglancer/viewer_layouts';
import {ViewerState} from 'neuroglancer/viewer_state';
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

export interface UIOptions {
  showHelpButton?: boolean;
  showLayerDialog?: boolean;
  showLayerPanel?: boolean;
  showLocation?: boolean;
}
export interface ViewerOptions extends UIOptions {}

const defaultViewerOptions: ViewerOptions = {
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
  worker = new RPC(new Worker('chunk_worker.bundle.js'));
  resetInitiated = new NullarySignal();

  chunkQueueManager = new ChunkQueueManager(this.worker, this.display.gl, {
    gpuMemory: new AvailableCapacity(1e6, 1e9),
    systemMemory: new AvailableCapacity(1e7, 2e9),
    download: new AvailableCapacity(32, Number.POSITIVE_INFINITY)
  });
  chunkManager = new ChunkManager(this.chunkQueueManager);
  keyMap = new KeySequenceMap();
  keyCommands = new Map<string, (this: Viewer) => void>();
  layerSpecification = new LayerListSpecification(
      this.layerManager, this.chunkManager, this.worker, this.layerSelectedValues,
      this.navigationState.voxelSize);
  layoutName = new TrackableValue<string>(LAYOUTS[0][0], validateLayoutName);

  state = new CompoundTrackable();

  private options: ViewerOptions;

  constructor(public display: DisplayContext, options: ViewerOptions = {}) {
    super();

    this.options = {...defaultViewerOptions, ...options};

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
      if (this.layerManager.managedLayers.length === 0) {
        // No layers, reset state.
        this.navigationState.reset();
        this.perspectiveNavigationState.pose.orientation.reset();
        this.perspectiveNavigationState.zoomFactor.reset();
        this.resetInitiated.dispatch();
        if (!overlaysOpen && this.options.showLayerDialog) {
          new LayerDialog(this.layerSpecification);
        }
      }
    }));
    this.layerManager.layersChanged.add(maybeResetState);
    maybeResetState();

    this.registerDisposer(this.chunkQueueManager.visibleChunksChanged.add(() => {
      this.layerSelectedValues.handleLayerChange();
    }));

    this.chunkQueueManager.visibleChunksChanged.add(() => {
      display.scheduleRedraw();
    });

    this.makeUI();

    this.registerDisposer(
        globalKeyboardHandlerStack.push(this.keyMap, this.onKeyCommand.bind(this)));

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
    this.chunkQueueManager.chunkUpdateDeadline = null;
  }

  onUpdateDisplayFinished() {
    this.mouseState.updateIfStale();
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
    let {chunkQueueManager} = this;
    if (chunkQueueManager.chunkUpdateDeadline === null) {
      chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
    }
    this.mouseState.stale = true;
  }
}
