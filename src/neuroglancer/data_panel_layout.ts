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
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {DisplayContext} from 'neuroglancer/display_context';
import {LayerManager, MouseSelectionState} from 'neuroglancer/layer';
import * as L from 'neuroglancer/layout';
import {NavigationState, OrientationState, Pose} from 'neuroglancer/navigation_state';
import {PerspectivePanel} from 'neuroglancer/perspective_view/panel';
import {RenderedDataPanel} from 'neuroglancer/rendered_data_panel';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {SliceViewerState, SliceViewPanel} from 'neuroglancer/sliceview/panel';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {EventActionMap, registerActionListener} from 'neuroglancer/util/event_action_map';
import {quat} from 'neuroglancer/util/geom';
import {VisibilityPrioritySpecification} from 'neuroglancer/viewer_state';

require('neuroglancer/ui/button.css');

export interface SliceViewViewerState {
  chunkManager: ChunkManager;
  navigationState: NavigationState;
  layerManager: LayerManager;
}

export class InputEventBindings {
  perspectiveView = new EventActionMap();
  sliceView = new EventActionMap();
}

export interface ViewerUIState extends SliceViewViewerState, VisibilityPrioritySpecification {
  display: DisplayContext;
  mouseState: MouseSelectionState;
  perspectiveNavigationState: NavigationState;
  showPerspectiveSliceViews: TrackableBoolean;
  showAxisLines: TrackableBoolean;
  showScaleBar: TrackableBoolean;
  inputEventBindings: InputEventBindings;
}

export interface DataDisplayLayout extends RefCounted {
  rootElement: HTMLElement;
  container: DataPanelLayoutContainer;
}

type NamedAxes = 'xy' | 'xz' | 'yz';

const AXES_RELATIVE_ORIENTATION = new Map<NamedAxes, quat|undefined>([
  ['xy', undefined],
  ['xz', quat.rotateX(quat.create(), quat.create(), Math.PI / 2)],
  ['yz', quat.rotateY(quat.create(), quat.create(), Math.PI / 2)],
]);

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

export function makeNamedSliceView(viewerState: SliceViewViewerState, axes: NamedAxes) {
  return makeSliceView(viewerState, AXES_RELATIVE_ORIENTATION.get(axes)!);
}

export function makeOrthogonalSliceViews(viewerState: SliceViewViewerState) {
  return new Map<NamedAxes, SliceView>([
    ['xy', makeNamedSliceView(viewerState, 'xy')],
    ['xz', makeNamedSliceView(viewerState, 'xz')],
    ['yz', makeNamedSliceView(viewerState, 'yz')],
  ]);
}

export function getCommonViewerState(viewer: ViewerUIState) {
  return {
    mouseState: viewer.mouseState,
    layerManager: viewer.layerManager,
    showAxisLines: viewer.showAxisLines,
    visibility: viewer.visibility,
  };
}

function getCommonPerspectiveViewerState(viewer: ViewerUIState) {
  return {
    ...getCommonViewerState(viewer),
    navigationState: viewer.perspectiveNavigationState,
    inputEventMap: viewer.inputEventBindings.perspectiveView,
  };
}

function getCommonSliceViewerState(viewer: ViewerUIState) {
  return {
    ...getCommonViewerState(viewer),
    navigationState: viewer.navigationState,
    inputEventMap: viewer.inputEventBindings.sliceView,
  };
}

function registerRelatedLayouts(
    layout: DataDisplayLayout, panel: RenderedDataPanel, relatedLayouts: string[]) {
  for (let i = 0; i < 2; ++i) {
    const relatedLayout = relatedLayouts[Math.min(relatedLayouts.length - 1, i)];
    layout.registerDisposer(registerActionListener(
        panel.element, i === 0 ? 'toggle-layout' : 'toggle-layout-alternative', (event: Event) => {
          layout.container.name = relatedLayout;
          event.stopPropagation();
        }));
  }
}

export class FourPanelLayout extends RefCounted {
  constructor(
      public container: DataPanelLayoutContainer, public rootElement: HTMLElement,
      public viewer: ViewerUIState) {
    super();

    let sliceViews = makeOrthogonalSliceViews(viewer);
    let {display} = viewer;

    const perspectiveViewerState = {
      ...getCommonPerspectiveViewerState(viewer),
      showSliceViews: viewer.showPerspectiveSliceViews,
      showSliceViewsCheckbox: true,
    };

    const sliceViewerState = {
      ...getCommonSliceViewerState(viewer),
      showScaleBar: viewer.showScaleBar,
    };

    const sliceViewerStateWithoutScaleBar = {
      ...getCommonSliceViewerState(viewer),
      showScaleBar: new TrackableBoolean(false, false),
    };

    const makeSliceViewPanel = (axes: NamedAxes, element: HTMLElement, state: SliceViewerState) => {
      const panel =
          this.registerDisposer(new SliceViewPanel(display, element, sliceViews.get(axes)!, state));
      registerRelatedLayouts(this, panel, [axes, `${axes}-3d`]);
      return panel;
    };
    let mainDisplayContents = [
      L.withFlex(1, L.box('column', [
        L.withFlex(1, L.box('row', [
          L.withFlex(1, element => {
            makeSliceViewPanel('xy', element, sliceViewerState);
          }),
          L.withFlex(1, element => {
            makeSliceViewPanel('xz', element, sliceViewerStateWithoutScaleBar);
          })
        ])),
        L.withFlex(1, L.box('row', [
          L.withFlex(1, element => {
            let panel = this.registerDisposer(
                new PerspectivePanel(display, element, perspectiveViewerState));
            for (let sliceView of sliceViews.values()) {
              panel.sliceViews.add(sliceView.addRef());
            }
            registerRelatedLayouts(this, panel, ['3d']);
          }),
          L.withFlex(1, element => {
            makeSliceViewPanel('yz', element, sliceViewerStateWithoutScaleBar);
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
      public container: DataPanelLayoutContainer, public rootElement: HTMLElement,
      public viewer: ViewerUIState, public direction: 'row'|'column', axes: NamedAxes) {
    super();

    let sliceView = makeNamedSliceView(viewer, axes);
    let {display} = viewer;

    const perspectiveViewerState = {
      ...getCommonPerspectiveViewerState(viewer),
      showSliceViews: viewer.showPerspectiveSliceViews,
      showSliceViewsCheckbox: true,
    };

    const sliceViewerState = {
      ...getCommonSliceViewerState(viewer),
      showScaleBar: viewer.showScaleBar,
    };

    L.withFlex(1, L.box(direction, [
      L.withFlex(
          1,
          element => {
            const panel = this.registerDisposer(
                new SliceViewPanel(display, element, sliceView, sliceViewerState));
            registerRelatedLayouts(this, panel, [axes, '4panel']);
          }),
      L.withFlex(
          1,
          element => {
            let panel = this.registerDisposer(
                new PerspectivePanel(display, element, perspectiveViewerState));
            panel.sliceViews.add(sliceView.addRef());
            registerRelatedLayouts(this, panel, ['3d', '4panel']);
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
  constructor(
      public container: DataPanelLayoutContainer, public rootElement: HTMLElement,
      public viewer: ViewerUIState, axes: NamedAxes) {
    super();
    let sliceView = makeNamedSliceView(viewer, axes);
    const sliceViewerState = {
      ...getCommonSliceViewerState(viewer),
      showScaleBar: viewer.showScaleBar,
    };

    L.box('row', [L.withFlex(1, element => {
            const panel = this.registerDisposer(
                new SliceViewPanel(viewer.display, element, sliceView, sliceViewerState));
            registerRelatedLayouts(this, panel, ['4panel', `${axes}-3d`]);
          })])(rootElement);
    viewer.display.onResize();
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export class SinglePerspectiveLayout extends RefCounted {
  constructor(public container: DataPanelLayoutContainer, public rootElement: HTMLElement, public viewer: ViewerUIState) {
    super();
    let perspectiveViewerState = {
      ...getCommonPerspectiveViewerState(viewer),
      showSliceViews: new TrackableBoolean(false, false),
    };


    L.box('row', [L.withFlex(1, element => {
            const panel = this.registerDisposer(
                new PerspectivePanel(viewer.display, element, perspectiveViewerState));
            registerRelatedLayouts(this, panel, ['4panel']);
          })])(rootElement);
    viewer.display.onResize();
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export const LAYOUTS = new Map<string, {
  factory: (container: DataPanelLayoutContainer, element: HTMLElement, viewer: ViewerUIState) =>
      DataDisplayLayout
}>(
    [
      [
        '4panel', {
          factory: (container, element, viewer) => new FourPanelLayout(container, element, viewer)
        }
      ],
      [
        '3d', {
          factory: (container, element, viewer) =>
              new SinglePerspectiveLayout(container, element, viewer)
        }
      ],
    ],
);

for (const axes of AXES_RELATIVE_ORIENTATION.keys()) {
  LAYOUTS.set(axes, {
    factory: (container, element, viewer) =>
        new SinglePanelLayout(container, element, viewer, <NamedAxes>axes)
  });
  LAYOUTS.set(`${axes}-3d`, {
    factory: (container, element, viewer) =>
        new SliceViewPerspectiveTwoPanelLayout(container, element, viewer, 'row', <NamedAxes>axes)
  });
}

export function getLayoutByName(obj: any) {
  let layout = LAYOUTS.get(obj);
  if (layout === undefined) {
    throw new Error(`Invalid layout name: ${JSON.stringify(obj)}.`);
  }
  return layout;
}

export function validateLayoutName(obj: any) {
  getLayoutByName(obj);
  return <string>obj;
}

export class DataPanelLayoutContainer extends RefCounted {
  element = document.createElement('div');
  layoutName: TrackableValue<string>;
  private layout: DataDisplayLayout|undefined;

  get name () { return this.layoutName.value; }
  set name(value: string) { this.layoutName.value = value; }

  constructor (public viewer: ViewerUIState, defaultLayout: string = 'xy') {
    super();
    this.element.style.flex = '1';
    this.layoutName = new TrackableValue<string>(defaultLayout, validateLayoutName);
    const scheduleUpdateLayout = this.registerCancellable(debounce(() => this.updateLayout(), 0));
    this.layoutName.changed.add(scheduleUpdateLayout);

    // Ensure the layout is updated before drawing begins to avoid flicker.
    this.registerDisposer(
        this.viewer.display.updateStarted.add(() => scheduleUpdateLayout.flush()));
    scheduleUpdateLayout();
  }
  get changed () { return this.layoutName.changed; }
  toJSON () { return this.layoutName.toJSON(); }
  restoreState(obj: any) {
    this.layoutName.restoreState(obj);
  }
  reset () {
    this.layoutName.reset();
  }
  private disposeLayout() {
    let {layout} = this;
    if (layout !== undefined) {
      layout.dispose();
      this.layout = undefined;
    }
  }
  private updateLayout() {
    this.disposeLayout();
    this.layout = getLayoutByName(this.layoutName.value).factory(this, this.element, this.viewer);
  }
  disposed() {
    this.disposeLayout();
    super.disposed();
  }
}
