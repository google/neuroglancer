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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {DisplayContext} from 'neuroglancer/display_context';
import {LayerManager, MouseSelectionState} from 'neuroglancer/layer';
import * as L from 'neuroglancer/layout';
import {NavigationState, OrientationState, Pose} from 'neuroglancer/navigation_state';
import {PerspectivePanel} from 'neuroglancer/perspective_view/panel';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {SliceViewPanel} from 'neuroglancer/sliceview/panel';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {quat} from 'neuroglancer/util/geom';
import {VisibilityPrioritySpecification} from 'neuroglancer/viewer_state';

export interface SliceViewViewerState {
  chunkManager: ChunkManager;
  navigationState: NavigationState;
  layerManager: LayerManager;
}

export interface ViewerUIState extends SliceViewViewerState, VisibilityPrioritySpecification {
  display: DisplayContext;
  mouseState: MouseSelectionState;
  perspectiveNavigationState: NavigationState;
  showPerspectiveSliceViews: TrackableBoolean;
  showAxisLines: TrackableBoolean;
  showScaleBar: TrackableBoolean;
}


export function makeSliceView(viewerState: SliceViewViewerState, baseToSelf?: quat) {
  let navigationState: NavigationState;
  if (baseToSelf === undefined) {
    navigationState = viewerState.navigationState;
  } else {
    navigationState = new NavigationState(
        new Pose(
            viewerState.navigationState.pose.position,
            OrientationState.makeRelative(
                viewerState.navigationState.pose.orientation, baseToSelf)),
        viewerState.navigationState.zoomFactor);
  }
  return new SliceView(viewerState.chunkManager, viewerState.layerManager, navigationState);
}

export function makeOrthogonalSliceViews(viewerState: SliceViewViewerState) {
  let sliceViews = new Array<SliceView>();
  let addSliceView = (q?: quat) => {
    sliceViews.push(makeSliceView(viewerState, q));
  };
  addSliceView();
  addSliceView(quat.rotateX(quat.create(), quat.create(), Math.PI / 2));
  addSliceView(quat.rotateY(quat.create(), quat.create(), Math.PI / 2));
  return sliceViews;
}

export function getCommonViewerState(viewer: ViewerUIState) {
  return {
    mouseState: viewer.mouseState,
    layerManager: viewer.layerManager,
    showAxisLines: viewer.showAxisLines,
    visibility: viewer.visibility,
  };
}

export class FourPanelLayout extends RefCounted {
  constructor(public rootElement: HTMLElement, public viewer: ViewerUIState) {
    super();

    let sliceViews = makeOrthogonalSliceViews(viewer);
    let {display} = viewer;

    const perspectiveViewerState = {
      ...getCommonViewerState(viewer),
      navigationState: viewer.perspectiveNavigationState,
      showSliceViews: viewer.showPerspectiveSliceViews,
      showSliceViewsCheckbox: true,
    };

    const sliceViewerState = {
      ...getCommonViewerState(viewer),
      navigationState: viewer.navigationState,
      showScaleBar: viewer.showScaleBar,
    };

    const sliceViewerStateWithoutScaleBar = {
      ...getCommonViewerState(viewer),
      navigationState: viewer.navigationState,
      showScaleBar: new TrackableBoolean(false, false),
    };
    let mainDisplayContents = [
      L.withFlex(1, L.box('column', [
        L.withFlex(1, L.box('row', [
          L.withFlex(1, element => {
            element.className = 'gllayoutcell noselect';
            this.registerDisposer(new SliceViewPanel(display, element, sliceViews[0], sliceViewerState));
          }),
          L.withFlex(1, element => {
            element.className = 'gllayoutcell noselect';
            this.registerDisposer(new SliceViewPanel(display, element, sliceViews[1], sliceViewerStateWithoutScaleBar));
          })
        ])),
        L.withFlex(1, L.box('row', [
          L.withFlex(1, element => {
            element.className = 'gllayoutcell noselect';
            let perspectivePanel = this.registerDisposer(
                new PerspectivePanel(display, element, perspectiveViewerState));
            for (let sliceView of sliceViews) {
              perspectivePanel.sliceViews.add(sliceView.addRef());
            }
          }),
          L.withFlex(1, element => {
            element.className = 'gllayoutcell noselect';
            this.registerDisposer(new SliceViewPanel(display, element, sliceViews[2], sliceViewerStateWithoutScaleBar));
          })
        ])),
      ]))
    ];
    L.box('row', mainDisplayContents)(rootElement);
    display.onResize();
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export class SliceViewPerspectiveTwoPanelLayout extends RefCounted {
  constructor(
      public rootElement: HTMLElement, public viewer: ViewerUIState,
      public direction: 'row'|'column') {
    super();

    let sliceView = makeSliceView(viewer);
    let {display} = viewer;

    const perspectiveViewerState = {
      ...getCommonViewerState(viewer),
      navigationState: viewer.perspectiveNavigationState,
      showSliceViews: viewer.showPerspectiveSliceViews,
      showSliceViewsCheckbox: true,
    };

    const sliceViewerState = {
      ...getCommonViewerState(viewer),
      navigationState: viewer.navigationState,
      showScaleBar: viewer.showScaleBar,
    };

    L.withFlex(1, L.box(direction, [
      L.withFlex(
          1,
          element => {
            element.className = 'gllayoutcell noselect';
            this.registerDisposer(
                new SliceViewPanel(display, element, sliceView, sliceViewerState));
          }),
      L.withFlex(
          1,
          element => {
            element.className = 'gllayoutcell noselect';
            let perspectivePanel = this.registerDisposer(
                new PerspectivePanel(display, element, perspectiveViewerState));
            perspectivePanel.sliceViews.add(sliceView.addRef());
          }),
    ]))(rootElement);
    display.onResize();
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export class SinglePanelLayout extends RefCounted {
  constructor(public rootElement: HTMLElement, public viewer: ViewerUIState) {
    super();
    let sliceView = makeSliceView(viewer);
    const sliceViewerState = {
      ...getCommonViewerState(viewer),
      navigationState: viewer.navigationState,
      showScaleBar: viewer.showScaleBar,
    };

    L.box('row', [L.withFlex(1, element => {
            this.registerDisposer(
                new SliceViewPanel(viewer.display, element, sliceView, sliceViewerState));
          })])(rootElement);
    viewer.display.onResize();
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export class SinglePerspectiveLayout extends RefCounted {
  constructor(public rootElement: HTMLElement, public viewer: ViewerUIState) {
    super();
    let perspectiveViewerState = {
      ...getCommonViewerState(viewer),
      navigationState: viewer.perspectiveNavigationState,
      showSliceViews: new TrackableBoolean(false, false),
    };


    L.box('row', [L.withFlex(1, element => {
            this.registerDisposer(
                new PerspectivePanel(viewer.display, element, perspectiveViewerState));
          })])(rootElement);
    viewer.display.onResize();
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export interface DataDisplayLayout extends RefCounted { rootElement: HTMLElement; }

export const LAYOUTS:
    [string, (element: HTMLElement, viewer: ViewerUIState) => DataDisplayLayout][] = [
      ['4panel', (element, viewer) => new FourPanelLayout(element, viewer)],
      [
        'xy-3d', (element, viewer) => new SliceViewPerspectiveTwoPanelLayout(element, viewer, 'row')
      ],
      ['xy', (element, viewer) => new SinglePanelLayout(element, viewer)],
      ['3d', (element, viewer) => new SinglePerspectiveLayout(element, viewer)],
    ];
