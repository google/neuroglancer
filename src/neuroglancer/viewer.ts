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

import {AvailableCapacity} from 'neuroglancer/chunk_manager/base';
import {ChunkQueueManager, ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {DisplayContext} from 'neuroglancer/display_context';
import {KeyBindingHelpDialog} from 'neuroglancer/help/key_bindings';
import {MouseSelectionState, LayerManager, LayerSelectedValues} from 'neuroglancer/layer';
import {LayerDialog} from 'neuroglancer/layer_dialog';
import {LayerPanel} from 'neuroglancer/layer_panel';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import * as L from 'neuroglancer/layout';
import {NavigationState, TrackableZoomState, Pose} from 'neuroglancer/navigation_state';
import {overlaysOpen} from 'neuroglancer/overlay';
import {PerspectivePanel} from 'neuroglancer/perspective_panel';
import {PositionStatusPanel} from 'neuroglancer/position_status_panel';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {SliceViewPanel} from 'neuroglancer/sliceview/panel';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {delayHashUpdate, registerTrackable} from 'neuroglancer/url_hash_state';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4, Mat4} from 'neuroglancer/util/geom';
import {GlobalKeyboardShortcutHandler, KeySequenceMap} from 'neuroglancer/util/keyboard_shortcut_handler';
import {ViewerState} from 'neuroglancer/viewer_state';
import {RPC} from 'neuroglancer/worker_rpc';
import {Signal} from 'signals';

require('./viewer.css');
require('neuroglancer/noselect.css');

export class Viewer extends RefCounted implements ViewerState {
  navigationState = this.registerDisposer(new NavigationState());
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager());
  showAxisLines = new TrackableBoolean(true, true);
  layerPanel: LayerPanel;
  layerSelectedValues =
      this.registerDisposer(new LayerSelectedValues(this.layerManager, this.mouseState));
  worker = new RPC(new Worker('chunk_worker.bundle.js'));
  resetInitiated = new Signal();

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

  constructor(public display: DisplayContext) {
    super();

    // Delay hash update after each redraw to try to prevent noticeable lag in Chrome.
    this.registerSignalBinding(display.updateStarted.add(this.onUpdateDisplay, this));
    this.registerSignalBinding(display.updateFinished.add(this.onUpdateDisplayFinished, this));

    // Prevent contextmenu on rightclick, as this inteferes with our use
    // of the right mouse button.
    this.registerEventListener(document, 'contextmenu', (e: Event) => {
      e.preventDefault();
      return false;
    });

    registerTrackable('layers', this.layerSpecification);
    registerTrackable('navigation', this.navigationState);
    registerTrackable('showAxisLines', this.showAxisLines);


    this.registerSignalBinding(
        this.navigationState.changed.add(this.handleNavigationStateChanged, this));

    this.layerManager.initializePosition(this.navigationState.position);
    this.layerManager.layersChanged.add(() => {
      if (this.layerManager.managedLayers.length === 0) {
        // No layers, reset state.
        this.navigationState.voxelSize.reset();
        this.navigationState.reset();
        this.resetInitiated.dispatch();
        this.layerManager.initializePosition(this.navigationState.position);
        if (!overlaysOpen) {
          new LayerDialog(this.layerSpecification);
        }
      }
    });

    this.registerSignalBinding(this.chunkQueueManager.visibleChunksChanged.add(
        () => { this.layerSelectedValues.handleLayerChange(); }));

    this.chunkQueueManager.visibleChunksChanged.add(display.scheduleRedraw, display);

    this.addFourPanelLayout();

    this.registerDisposer(
        new GlobalKeyboardShortcutHandler(this.keyMap, this.onKeyCommand.bind(this)));

    let {keyCommands} = this;
    keyCommands.set('snap', function() { this.navigationState.pose.snap(); });
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
      keyCommands.set(command, function() { this.layerManager.invokeAction(command); });
    }

    keyCommands.set('toggle-axis-lines', function() { this.showAxisLines.toggle(); });


    // This needs to happen after the global keyboard shortcut handler for the viewer has been
    // registered, so that it has priority.
    if (this.layerManager.managedLayers.length === 0) {
      new LayerDialog(this.layerSpecification);
    }
  }

  showHelpDialog() {
    new KeyBindingHelpDialog(this.keyMap);
  }

  get gl() { return this.display.gl; }

  onUpdateDisplay() {
    delayHashUpdate();
    this.chunkQueueManager.chunkUpdateDeadline = null;
  }

  onUpdateDisplayFinished() { this.mouseState.updateIfStale(); }

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

  makeOrthogonalSliceViews() {
    let {gl, layerManager} = this;
    let sliceViews = new Array<SliceView>();
    let addSliceView = (mat?: Mat4) => {
      let sliceView = new SliceView(gl, this.chunkManager, layerManager);
      sliceViews.push(sliceView);
      sliceView.fixRelativeTo(this.navigationState, mat);
    };
    addSliceView();
    {
      let mat = mat4.create();
      mat4.identity(mat);
      mat4.rotateX(mat, mat, Math.PI / 2);
      addSliceView(mat);
    }

    {
      let mat = mat4.create();
      mat4.identity(mat);
      mat4.rotateY(mat, mat, Math.PI / 2);
      addSliceView(mat);
    }
    return sliceViews;
  }

  addFourPanelLayout() {
    let sliceViews = this.makeOrthogonalSliceViews();
    let {display} = this;

    let perspectiveViewerState = {
      mouseState: this.mouseState,
      layerManager: this.layerManager,
      navigationState: new NavigationState(new Pose(this.navigationState.position), 1),
      showSliceViews: new TrackableBoolean(true, true),
      showAxisLines: this.showAxisLines,
    };
    this.resetInitiated.add(() => {
      perspectiveViewerState.navigationState.pose.orientation.reset();
      perspectiveViewerState.navigationState.resetZoom();
    });
    registerTrackable(
        'perspectiveOrientation', perspectiveViewerState.navigationState.pose.orientation);
    registerTrackable(
        'perspectiveZoom', new TrackableZoomState(perspectiveViewerState.navigationState));
    registerTrackable('showSlices', perspectiveViewerState.showSliceViews);

    this.keyCommands.set(
        'toggle-show-slices', function() { perspectiveViewerState.showSliceViews.toggle(); });

    let gridContainer = document.createElement('div');
    gridContainer.setAttribute('class', 'gllayoutcontainer noselect');
    let {container} = display;
    container.appendChild(gridContainer);
    let mainDisplayContents = [
      L.withFlex(1, L.box('column', [
        L.withFlex(1, L.box('row', [
          L.withFlex(1, element => {
            element.className = 'gllayoutcell noselect';
            display.panels.add(new SliceViewPanel(display, element, sliceViews[0], this));
          }),
          L.withFlex(1, element => {
            element.className = 'gllayoutcell noselect';
            display.panels.add(new SliceViewPanel(display, element, sliceViews[1], this));
          })
        ])),
        L.withFlex(1, L.box('row', [
          L.withFlex(1, element => {
            element.className = 'gllayoutcell noselect';
            let perspectivePanel = new PerspectivePanel(display, element, perspectiveViewerState);
            for (let sliceView of sliceViews) {
              perspectivePanel.sliceViews.add(sliceView);
            }
            display.panels.add(perspectivePanel);
          }),
          L.withFlex(1, element => {
            element.className = 'gllayoutcell noselect';
            display.panels.add(new SliceViewPanel(display, element, sliceViews[2], this));
          })
        ])),
      ]))
    ];
    L.box('column', [
      L.box('row', [
        L.withFlex(1, element => new PositionStatusPanel(element, this)),
        element => {
          let button = document.createElement('button');
          button.className = 'help-button';
          button.textContent = '?';
          button.title = 'Help';
          element.appendChild(button);
          this.registerEventListener(button, 'click', () => { this.showHelpDialog(); });
        },
      ]),
      element => { this.layerPanel = new LayerPanel(element, this.layerSpecification); },
      L.withFlex(1, L.box('row', mainDisplayContents))
    ])(gridContainer);
    this.display.onResize();
  }

  private handleNavigationStateChanged() {
    let {chunkQueueManager} = this;
    if (chunkQueueManager.chunkUpdateDeadline === null) {
      chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
    }
    this.mouseState.stale = true;
  }
};
