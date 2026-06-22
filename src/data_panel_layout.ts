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

import "#src/data_panel_layout.css";

import { debounce } from "lodash-es";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { DisplayContext } from "#src/display_context.js";
import type {
  LayerManager,
  MouseSelectionState,
  SelectedLayerState,
  TrackableDataSelectionState,
} from "#src/layer/index.js";
import * as L from "#src/layout.js";
import type { TrackableZoomInterface } from "#src/navigation_state.js";
import {
  DisplayPose,
  LinkedOrientationState,
  LinkedPosition,
  linkedStateLegacyJsonView,
  LinkedZoomState,
  NavigationState,
  OrientationState,
} from "#src/navigation_state.js";
import { PerspectivePanel } from "#src/perspective_view/panel.js";
import type { RenderedDataPanel } from "#src/rendered_data_panel.js";
import type { RenderLayerRole } from "#src/renderlayer.js";
import { SliceView } from "#src/sliceview/frontend.js";
import type { SliceViewerState } from "#src/sliceview/panel.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type {
  WatchableSet,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import { TrackableValue } from "#src/trackable_value.js";
import type { TrackableRGB } from "#src/util/color.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren, removeFromParent } from "#src/util/dom.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import { quat } from "#src/util/geom.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyPositiveInt,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import { optionallyRestoreFromJsonMember } from "#src/util/trackable.js";
import { WatchableMap } from "#src/util/watchable_map.js";
import type { VisibilityPrioritySpecification } from "#src/viewer_state.js";
import { DisplayDimensionsWidget } from "#src/widget/display_dimensions_widget.js";
import type { ScaleBarOptions } from "#src/widget/scale_bar.js";

export interface SliceViewViewerState {
  chunkManager: ChunkManager;
  navigationState: NavigationState;
  layerManager: LayerManager;
  wireFrame: WatchableValueInterface<boolean>;
}

export class InputEventBindings {
  perspectiveView = new EventActionMap();
  sliceView = new EventActionMap();
}

export interface ViewerUIState
  extends SliceViewViewerState,
    VisibilityPrioritySpecification {
  display: DisplayContext;
  mouseState: MouseSelectionState;
  perspectiveNavigationState: NavigationState;
  selectionDetailsState: TrackableDataSelectionState;
  showPerspectiveSliceViews: TrackableBoolean;
  showAxisLines: TrackableBoolean;
  wireFrame: TrackableBoolean;
  enableAdaptiveDownsampling: TrackableBoolean;
  showScaleBar: TrackableBoolean;
  scaleBarOptions: TrackableValue<ScaleBarOptions>;
  visibleLayerRoles: WatchableSet<RenderLayerRole>;
  selectedLayer: SelectedLayerState;
  inputEventBindings: InputEventBindings;
  crossSectionBackgroundColor: TrackableRGB;
  perspectiveViewBackgroundColor: TrackableRGB;
  hideCrossSectionBackground3D: TrackableBoolean;
  pickRadius: TrackableValue<number>;
}

export interface DataDisplayLayout extends RefCounted {
  rootElement: HTMLElement;
  container: DataPanelLayoutContainer;
}

type NamedAxes = "xy" | "xz" | "yz";

const AXES_RELATIVE_ORIENTATION = new Map<NamedAxes, quat | undefined>([
  ["xy", undefined],
  ["xz", quat.rotateX(quat.create(), quat.create(), Math.PI / 2)],
  ["yz", quat.rotateY(quat.create(), quat.create(), Math.PI / 2)],
]);

const oneSquareSymbol = "◻";

const LAYOUT_SYMBOLS = new Map<string, string>([
  ["4panel", "◱"],
  ["4panel-alt", "◲"],
  ["3d", oneSquareSymbol],
]);

export function makeSliceView(
  viewerState: SliceViewViewerState,
  baseToSelf?: quat,
) {
  let navigationState: NavigationState;
  if (baseToSelf === undefined) {
    navigationState = viewerState.navigationState.addRef();
  } else {
    navigationState = new NavigationState(
      new DisplayPose(
        viewerState.navigationState.pose.position.addRef(),
        viewerState.navigationState.pose.displayDimensionRenderInfo.addRef(),
        OrientationState.makeRelative(
          viewerState.navigationState.pose.orientation,
          baseToSelf,
        ),
      ),
      viewerState.navigationState.zoomFactor.addRef(),
      viewerState.navigationState.depthRange.addRef(),
    );
  }
  return new SliceView(
    viewerState.chunkManager,
    viewerState.layerManager,
    navigationState,
    viewerState.wireFrame,
  );
}

export function makeNamedSliceView(
  viewerState: SliceViewViewerState,
  axes: NamedAxes,
) {
  return makeSliceView(viewerState, AXES_RELATIVE_ORIENTATION.get(axes)!);
}

export function makeOrthogonalSliceViews(viewerState: SliceViewViewerState) {
  return new Map<NamedAxes, SliceView>([
    ["xy", makeNamedSliceView(viewerState, "xy")],
    ["xz", makeNamedSliceView(viewerState, "xz")],
    ["yz", makeNamedSliceView(viewerState, "yz")],
  ]);
}

export function getCommonViewerState(viewer: ViewerUIState) {
  return {
    crossSectionBackgroundColor: viewer.crossSectionBackgroundColor,
    perspectiveViewBackgroundColor: viewer.perspectiveViewBackgroundColor,
    selectionDetailsState: viewer.selectionDetailsState,
    mouseState: viewer.mouseState,
    layerManager: viewer.layerManager,
    showAxisLines: viewer.showAxisLines,
    wireFrame: viewer.wireFrame,
    enableAdaptiveDownsampling: viewer.enableAdaptiveDownsampling,
    visibleLayerRoles: viewer.visibleLayerRoles,
    selectedLayer: viewer.selectedLayer,
    visibility: viewer.visibility,
    scaleBarOptions: viewer.scaleBarOptions,
    hideCrossSectionBackground3D: viewer.hideCrossSectionBackground3D,
    pickRadius: viewer.pickRadius,
  };
}

function getCommonPerspectiveViewerState(container: DataPanelLayoutContainer) {
  const { viewer } = container;
  return {
    ...getCommonViewerState(viewer),
    navigationState: viewer.perspectiveNavigationState,
    inputEventMap: viewer.inputEventBindings.perspectiveView,
    orthographicProjection: container.specification.orthographicProjection,
    showScaleBar: viewer.showScaleBar,
    rpc: viewer.chunkManager.rpc!,
  };
}

function getCommonSliceViewerState(viewer: ViewerUIState) {
  return {
    ...getCommonViewerState(viewer),
    navigationState: viewer.navigationState,
    inputEventMap: viewer.inputEventBindings.sliceView,
  };
}

function addDisplayDimensionsWidget(
  layout: DataDisplayLayout,
  panel: RenderedDataPanel,
) {
  const { navigationState } = panel;
  panel.element.appendChild(
    layout.registerDisposer(
      new DisplayDimensionsWidget(
        navigationState.pose.displayDimensionRenderInfo.addRef(),
        navigationState.zoomFactor,
        navigationState.depthRange.addRef(),
        navigationState.pose.orientation.addRef(),
        panel.boundsUpdated,
        panel.renderViewport,
        panel instanceof SliceViewPanel,
      ),
    ).element,
  );
}

function registerRelatedLayouts(
  layout: DataDisplayLayout,
  panel: RenderedDataPanel,
  relatedLayouts: string[],
) {
  const controls = document.createElement("div");
  controls.className = "neuroglancer-data-panel-layout-controls";
  layout.registerDisposer(() => removeFromParent(controls));
  for (let i = 0; i < 2; ++i) {
    const relatedLayout =
      relatedLayouts[Math.min(relatedLayouts.length - 1, i)];
    layout.registerDisposer(
      registerActionListener(
        panel.element,
        i === 0 ? "toggle-layout" : "toggle-layout-alternative",
        (event: Event) => {
          layout.container.name = relatedLayout;
          event.stopPropagation();
        },
      ),
    );
  }
  for (const relatedLayout of relatedLayouts) {
    const button = document.createElement("button");
    const innerDiv = document.createElement("div");
    button.appendChild(innerDiv);
    innerDiv.textContent = LAYOUT_SYMBOLS.get(relatedLayout)!;
    button.title = `Switch to ${relatedLayout} layout.`;
    button.addEventListener("click", () => {
      layout.container.name = relatedLayout;
    });
    controls.appendChild(button);
  }
  panel.element.appendChild(controls);
}

function makeSliceViewFromSpecification(
  viewer: SliceViewViewerState,
  specification: Borrowed<CrossSectionSpecification>,
) {
  const sliceView = new SliceView(
    viewer.chunkManager,
    viewer.layerManager,
    specification.navigationState.addRef(),
    viewer.wireFrame,
  );
  const updateViewportSize = () => {
    const {
      width: { value: width },
      height: { value: height },
    } = specification;
    sliceView.projectionParameters.setViewport({
      width,
      height,
      logicalWidth: width,
      logicalHeight: height,
      visibleLeftFraction: 0,
      visibleTopFraction: 0,
      visibleWidthFraction: 1,
      visibleHeightFraction: 1,
    });
  };
  sliceView.registerDisposer(
    specification.width.changed.add(updateViewportSize),
  );
  sliceView.registerDisposer(
    specification.height.changed.add(updateViewportSize),
  );
  updateViewportSize();
  return sliceView;
}

function addUnconditionalSliceViews(
  viewer: SliceViewViewerState,
  panel: PerspectivePanel,
  crossSections: Borrowed<CrossSectionSpecificationMap>,
) {
  const previouslyAdded = new Map<
    Borrowed<CrossSectionSpecification>,
    Borrowed<SliceView>
  >();
  const update = () => {
    const currentCrossSections = new Set<Borrowed<CrossSectionSpecification>>();
    // Add missing cross sections.
    for (const crossSection of crossSections.values()) {
      currentCrossSections.add(crossSection);
      if (previouslyAdded.has(crossSection)) {
        continue;
      }
      const sliceView = makeSliceViewFromSpecification(viewer, crossSection);
      panel.sliceViews.set(sliceView, true);
      previouslyAdded.set(crossSection, sliceView);
    }
    // Remove extra cross sections.
    for (const [crossSection, sliceView] of previouslyAdded) {
      if (currentCrossSections.has(crossSection)) {
        continue;
      }
      panel.sliceViews.delete(sliceView);
    }
  };
  update();
}

export class FourPanelLayout extends RefCounted {
  constructor(
    public container: DataPanelLayoutContainer,
    public rootElement: HTMLElement,
    public viewer: ViewerUIState,
    crossSections: Borrowed<CrossSectionSpecificationMap>,
  ) {
    super();

    const sliceViews = makeOrthogonalSliceViews(viewer);
    const { display } = viewer;

    const perspectiveViewerState = {
      ...getCommonPerspectiveViewerState(container),
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

    const makeSliceViewPanel = (
      axes: NamedAxes,
      element: HTMLElement,
      state: SliceViewerState,
      displayDimensionsWidget: boolean,
    ) => {
      const panel = this.registerDisposer(
        new SliceViewPanel(display, element, sliceViews.get(axes)!, state),
      );
      if (displayDimensionsWidget) {
        addDisplayDimensionsWidget(this, panel);
      }
      registerRelatedLayouts(this, panel, [axes, `${axes}-3d`]);
      return panel;
    };
    const mainDisplayContents = [
      L.withFlex(
        1,
        L.box("column", [
          L.withFlex(
            1,
            L.box("row", [
              L.withFlex(1, (element) => {
                makeSliceViewPanel("xy", element, sliceViewerState, true);
              }),
              L.withFlex(1, (element) => {
                makeSliceViewPanel(
                  "xz",
                  element,
                  sliceViewerStateWithoutScaleBar,
                  false,
                );
              }),
            ]),
          ),
          L.withFlex(
            1,
            L.box("row", [
              L.withFlex(1, (element) => {
                const panel = this.registerDisposer(
                  new PerspectivePanel(
                    display,
                    element,
                    perspectiveViewerState,
                  ),
                );
                for (const sliceView of sliceViews.values()) {
                  panel.sliceViews.set(sliceView.addRef(), false);
                }
                addDisplayDimensionsWidget(this, panel);
                addUnconditionalSliceViews(viewer, panel, crossSections);
                registerRelatedLayouts(this, panel, ["3d", "4panel-alt"]);
              }),
              L.withFlex(1, (element) => {
                makeSliceViewPanel(
                  "yz",
                  element,
                  sliceViewerStateWithoutScaleBar,
                  false,
                );
              }),
            ]),
          ),
        ]),
      ),
    ];
    L.box("row", mainDisplayContents)(rootElement);
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export class FourPanelAltLayout extends RefCounted {
  constructor(
    public container: DataPanelLayoutContainer,
    public rootElement: HTMLElement,
    public viewer: ViewerUIState,
    crossSections: Borrowed<CrossSectionSpecificationMap>,
  ) {
    super();

    const sliceViews = makeOrthogonalSliceViews(viewer);
    const { display } = viewer;

    const perspectiveViewerState = {
      ...getCommonPerspectiveViewerState(container),
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

    const makeSliceViewPanel = (
      axes: NamedAxes,
      element: HTMLElement,
      state: SliceViewerState,
      displayDimensionsWidget: boolean,
    ) => {
      const panel = this.registerDisposer(
        new SliceViewPanel(display, element, sliceViews.get(axes)!, state),
      );
      if (displayDimensionsWidget) {
        addDisplayDimensionsWidget(this, panel);
      }
      registerRelatedLayouts(this, panel, [axes, `${axes}-3d`]);
      return panel;
    };
    const mainDisplayContents = [
      L.withFlex(
        1,
        L.box("column", [
          L.withFlex(
            1,
            L.box("row", [
              L.withFlex(1, (element) => {
                makeSliceViewPanel("xy", element, sliceViewerState, true);
              }),
              L.withFlex(1, (element) => {
                makeSliceViewPanel(
                  "yz",
                  element,
                  sliceViewerStateWithoutScaleBar,
                  false,
                );
              }),
            ]),
          ),
          L.withFlex(
            1,
            L.box("row", [
              L.withFlex(1, (element) => {
                makeSliceViewPanel(
                  "xz",
                  element,
                  sliceViewerStateWithoutScaleBar,
                  false,
                );
              }),
              L.withFlex(1, (element) => {
                const panel = this.registerDisposer(
                  new PerspectivePanel(
                    display,
                    element,
                    perspectiveViewerState,
                  ),
                );
                for (const sliceView of sliceViews.values()) {
                  panel.sliceViews.set(sliceView.addRef(), false);
                }
                addDisplayDimensionsWidget(this, panel);
                addUnconditionalSliceViews(viewer, panel, crossSections);
                registerRelatedLayouts(this, panel, ["3d", "4panel"]);
              }),
            ]),
          ),
        ]),
      ),
    ];
    L.box("row", mainDisplayContents)(rootElement);
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export class SliceViewPerspectiveTwoPanelLayout extends RefCounted {
  constructor(
    public container: DataPanelLayoutContainer,
    public rootElement: HTMLElement,
    public viewer: ViewerUIState,
    public direction: "row" | "column",
    axes: NamedAxes,
    crossSections: Borrowed<CrossSectionSpecificationMap>,
  ) {
    super();

    const sliceView = makeNamedSliceView(viewer, axes);
    const { display } = viewer;

    const perspectiveViewerState = {
      ...getCommonPerspectiveViewerState(container),
      showSliceViews: viewer.showPerspectiveSliceViews,
      showSliceViewsCheckbox: true,
    };

    const sliceViewerState = {
      ...getCommonSliceViewerState(viewer),
      showScaleBar: viewer.showScaleBar,
    };

    L.withFlex(
      1,
      L.box(direction, [
        L.withFlex(1, (element) => {
          const panel = this.registerDisposer(
            new SliceViewPanel(display, element, sliceView, sliceViewerState),
          );
          addDisplayDimensionsWidget(this, panel);
          registerRelatedLayouts(this, panel, [axes, "4panel-alt"]);
        }),
        L.withFlex(1, (element) => {
          const panel = this.registerDisposer(
            new PerspectivePanel(display, element, perspectiveViewerState),
          );
          panel.sliceViews.set(sliceView.addRef(), false);
          addUnconditionalSliceViews(viewer, panel, crossSections);
          addDisplayDimensionsWidget(this, panel);
          registerRelatedLayouts(this, panel, ["3d", "4panel-alt"]);
        }),
      ]),
    )(rootElement);
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export class SinglePanelLayout extends RefCounted {
  constructor(
    public container: DataPanelLayoutContainer,
    public rootElement: HTMLElement,
    public viewer: ViewerUIState,
    axes: NamedAxes,
  ) {
    super();
    const sliceView = makeNamedSliceView(viewer, axes);
    const sliceViewerState = {
      ...getCommonSliceViewerState(viewer),
      showScaleBar: viewer.showScaleBar,
    };

    L.box("row", [
      L.withFlex(1, (element) => {
        const panel = this.registerDisposer(
          new SliceViewPanel(
            viewer.display,
            element,
            sliceView,
            sliceViewerState,
          ),
        );
        addDisplayDimensionsWidget(this, panel);
        registerRelatedLayouts(this, panel, ["4panel-alt", `${axes}-3d`]);
      }),
    ])(rootElement);
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export class SinglePerspectiveLayout extends RefCounted {
  constructor(
    public container: DataPanelLayoutContainer,
    public rootElement: HTMLElement,
    public viewer: ViewerUIState,
    crossSections: Borrowed<CrossSectionSpecificationMap>,
  ) {
    super();
    const perspectiveViewerState = {
      ...getCommonPerspectiveViewerState(container),
      showSliceViews: new TrackableBoolean(false, false),
    };

    L.box("row", [
      L.withFlex(1, (element) => {
        const panel = this.registerDisposer(
          new PerspectivePanel(viewer.display, element, perspectiveViewerState),
        );
        addUnconditionalSliceViews(viewer, panel, crossSections);
        addDisplayDimensionsWidget(this, panel);
        registerRelatedLayouts(this, panel, ["4panel-alt"]);
      }),
    ])(rootElement);
  }

  disposed() {
    removeChildren(this.rootElement);
    super.disposed();
  }
}

export const LAYOUTS = new Map<
  string,
  {
    factory: (
      container: DataPanelLayoutContainer,
      element: HTMLElement,
      viewer: ViewerUIState,
      crossSections: Borrowed<CrossSectionSpecificationMap>,
    ) => DataDisplayLayout;
  }
>([
  [
    "4panel",
    {
      factory: (container, element, viewer, crossSections) =>
        new FourPanelLayout(container, element, viewer, crossSections),
    },
  ],
  [
    "4panel-alt",
    {
      factory: (container, element, viewer, crossSections) =>
        new FourPanelAltLayout(container, element, viewer, crossSections),
    },
  ],
  [
    "3d",
    {
      factory: (container, element, viewer, crossSections) =>
        new SinglePerspectiveLayout(container, element, viewer, crossSections),
    },
  ],
]);

for (const axes of AXES_RELATIVE_ORIENTATION.keys()) {
  LAYOUTS.set(axes, {
    factory: (container, element, viewer) =>
      new SinglePanelLayout(container, element, viewer, <NamedAxes>axes),
  });
  const splitLayout = `${axes}-3d`;
  LAYOUT_SYMBOLS.set(axes, oneSquareSymbol);
  LAYOUT_SYMBOLS.set(splitLayout, "◫");
  LAYOUTS.set(splitLayout, {
    factory: (container, element, viewer, crossSections) =>
      new SliceViewPerspectiveTwoPanelLayout(
        container,
        element,
        viewer,
        "row",
        <NamedAxes>axes,
        crossSections,
      ),
  });
}

export function getLayoutByName(obj: any) {
  const layout = LAYOUTS.get(obj);
  if (layout === undefined) {
    throw new Error(`Invalid layout name: ${JSON.stringify(obj)}.`);
  }
  return layout;
}

export function validateLayoutName(obj: any) {
  getLayoutByName(obj);
  return <string>obj;
}

export class CrossSectionSpecification extends RefCounted implements Trackable {
  width = new TrackableValue<number>(1000, verifyPositiveInt);
  height = new TrackableValue<number>(1000, verifyPositiveInt);
  position: LinkedPosition;
  orientation: LinkedOrientationState;
  scale: LinkedZoomState<TrackableZoomInterface>;
  navigationState: NavigationState;
  changed = new NullarySignal();
  constructor(parent: Borrowed<NavigationState>) {
    super();
    this.position = new LinkedPosition(parent.position.addRef());
    this.position.changed.add(this.changed.dispatch);
    this.orientation = new LinkedOrientationState(
      parent.pose.orientation.addRef(),
    );
    this.orientation.changed.add(this.changed.dispatch);
    this.width.changed.add(this.changed.dispatch);
    this.height.changed.add(this.changed.dispatch);
    this.scale = new LinkedZoomState(
      parent.zoomFactor.addRef(),
      parent.zoomFactor.displayDimensionRenderInfo.addRef(),
    );
    this.scale.changed.add(this.changed.dispatch);
    this.navigationState = this.registerDisposer(
      new NavigationState(
        new DisplayPose(
          this.position.value,
          parent.pose.displayDimensionRenderInfo.addRef(),
          this.orientation.value,
        ),
        this.scale.value,
        parent.depthRange.addRef(),
      ),
    );
  }

  restoreState(obj: any) {
    verifyObject(obj);
    optionallyRestoreFromJsonMember(obj, "width", this.width);
    optionallyRestoreFromJsonMember(obj, "height", this.height);
    optionallyRestoreFromJsonMember(
      obj,
      "position",
      linkedStateLegacyJsonView(this.position),
    );
    optionallyRestoreFromJsonMember(obj, "orientation", this.orientation);
    optionallyRestoreFromJsonMember(obj, "scale", this.scale);
    optionallyRestoreFromJsonMember(
      obj,
      "zoom",
      linkedStateLegacyJsonView(this.scale),
    );
  }

  reset() {
    this.width.reset();
    this.height.reset();
    this.position.reset();
    this.orientation.reset();
    this.scale.reset();
  }

  toJSON() {
    return {
      width: this.width.toJSON(),
      height: this.height.toJSON(),
      position: this.position.toJSON(),
      orientation: this.orientation.toJSON(),
      scale: this.scale.toJSON(),
    };
  }
}

export class CrossSectionSpecificationMap extends WatchableMap<
  string,
  CrossSectionSpecification
> {
  constructor(private parentNavigationState: Owned<NavigationState>) {
    super((context, spec) =>
      context.registerDisposer(
        context.registerDisposer(spec).changed.add(this.changed.dispatch),
      ),
    );
    this.registerDisposer(parentNavigationState);
  }

  restoreState(obj: any) {
    verifyObject(obj);
    for (const key of Object.keys(obj)) {
      const state = new CrossSectionSpecification(this.parentNavigationState);
      try {
        this.set(key, state.addRef());
        state.restoreState(obj[key]);
      } finally {
        state.dispose();
      }
    }
  }

  reset() {
    this.clear();
  }

  toJSON() {
    if (this.size === 0) return undefined;
    const obj: { [key: string]: any } = {};
    for (const [k, v] of this) {
      obj[k] = v.toJSON();
    }
    return obj;
  }
}

export class DataPanelLayoutSpecification
  extends RefCounted
  implements Trackable
{
  changed = new NullarySignal();
  type: TrackableValue<string>;
  crossSections: CrossSectionSpecificationMap;
  orthographicProjection = new TrackableBoolean(false);

  constructor(
    parentNavigationState: Owned<NavigationState>,
    defaultLayout: string,
  ) {
    super();
    this.type = new TrackableValue<string>(defaultLayout, validateLayoutName);
    this.type.changed.add(this.changed.dispatch);
    this.crossSections = this.registerDisposer(
      new CrossSectionSpecificationMap(parentNavigationState.addRef()),
    );
    this.crossSections.changed.add(this.changed.dispatch);
    this.orthographicProjection.changed.add(this.changed.dispatch);
    this.registerDisposer(parentNavigationState);
  }

  reset() {
    this.crossSections.clear();
    this.orthographicProjection.reset();
    this.type.reset();
  }

  restoreState(obj: any) {
    this.crossSections.clear();
    this.orthographicProjection.reset();
    if (typeof obj === "string") {
      this.type.restoreState(obj);
    } else {
      verifyObject(obj);
      verifyObjectProperty(obj, "type", (x) => this.type.restoreState(x));
      verifyObjectProperty(obj, "orthographicProjection", (x) =>
        this.orthographicProjection.restoreState(x),
      );
      verifyObjectProperty(
        obj,
        "crossSections",
        (x) => x !== undefined && this.crossSections.restoreState(x),
      );
    }
  }

  toJSON() {
    const { type, crossSections, orthographicProjection } = this;
    const orthographicProjectionJson = orthographicProjection.toJSON();
    if (crossSections.size === 0 && orthographicProjectionJson === undefined) {
      return type.value;
    }
    return {
      type: type.value,
      crossSections: crossSections.toJSON(),
      orthographicProjection: orthographicProjectionJson,
    };
  }
}

export class DataPanelLayoutContainer extends RefCounted {
  element = document.createElement("div");
  specification: Owned<DataPanelLayoutSpecification>;

  private layout: DataDisplayLayout | undefined;

  get name() {
    return this.specification.type.value;
  }
  set name(value: string) {
    this.specification.type.value = value;
  }

  constructor(
    public viewer: ViewerUIState,
    defaultLayout: string,
  ) {
    super();
    this.specification = this.registerDisposer(
      new DataPanelLayoutSpecification(
        this.viewer.navigationState.addRef(),
        defaultLayout,
      ),
    );
    this.element.style.flex = "1";
    const scheduleUpdateLayout = this.registerCancellable(
      debounce(() => this.updateLayout(), 0),
    );
    this.specification.type.changed.add(scheduleUpdateLayout);

    registerActionListener(this.element, "toggle-orthographic-projection", () =>
      this.specification.orthographicProjection.toggle(),
    );

    // Ensure the layout is updated before drawing begins to avoid flicker.
    this.registerDisposer(
      this.viewer.display.updateStarted.add(() => scheduleUpdateLayout.flush()),
    );
    scheduleUpdateLayout();
  }
  get changed() {
    return this.specification.changed;
  }
  toJSON() {
    return this.specification.toJSON();
  }
  restoreState(obj: any) {
    this.specification.restoreState(obj);
  }
  reset() {
    this.specification.reset();
  }
  private disposeLayout() {
    const { layout } = this;
    if (layout !== undefined) {
      layout.dispose();
      this.layout = undefined;
    }
  }
  private updateLayout() {
    this.disposeLayout();
    this.layout = getLayoutByName(this.name).factory(
      this,
      this.element,
      this.viewer,
      this.specification.crossSections,
    );
  }
  disposed() {
    this.disposeLayout();
    super.disposed();
  }
}
