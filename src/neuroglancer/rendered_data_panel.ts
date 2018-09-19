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

import {Annotation} from 'neuroglancer/annotation';
import {getSelectedAnnotation} from 'neuroglancer/annotation/selection';
import {getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {DisplayContext, RenderedPanel} from 'neuroglancer/display_context';
import {MouseSelectionState} from 'neuroglancer/layer';
import {NavigationState} from 'neuroglancer/navigation_state';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {AutomaticallyFocusedElement} from 'neuroglancer/util/automatic_focus';
import {ActionEvent, EventActionMap, registerActionListener} from 'neuroglancer/util/event_action_map';
import {AXES_NAMES, kAxes, vec2, vec3} from 'neuroglancer/util/geom';
import {KeyboardEventBinder} from 'neuroglancer/util/keyboard_bindings';
import {MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {getWheelZoomAmount} from 'neuroglancer/util/wheel_zoom';
import {ViewerState} from 'neuroglancer/viewer_state';


require('./rendered_data_panel.css');
require('neuroglancer/noselect.css');

const tempVec3 = vec3.create();

export interface RenderedDataViewerState extends ViewerState {
  inputEventMap: EventActionMap;
}

export abstract class RenderedDataPanel extends RenderedPanel {
  // Last mouse position within the panel.
  mouseX = 0;
  mouseY = 0;

  abstract updateMouseState(state: MouseSelectionState): boolean;

  private mouseStateUpdater = this.updateMouseState.bind(this);

  inputEventMap: EventActionMap;

  navigationState: NavigationState;


  constructor(
      context: DisplayContext, element: HTMLElement, public viewer: RenderedDataViewerState) {
    super(context, element, viewer.visibility);
    this.inputEventMap = viewer.inputEventMap;

    element.classList.add('neuroglancer-rendered-data-panel');
    element.classList.add('neuroglancer-panel');
    element.classList.add('neuroglancer-noselect');

    this.registerDisposer(new AutomaticallyFocusedElement(element));
    this.registerDisposer(new KeyboardEventBinder(element, this.inputEventMap));
    this.registerDisposer(new MouseEventBinder(element, this.inputEventMap));

    this.registerEventListener(element, 'mousemove', this.onMousemove.bind(this));
    this.registerEventListener(element, 'mouseleave', this.onMouseout.bind(this));

    registerActionListener(element, 'snap', () => {
      this.navigationState.pose.snap();
    });

    registerActionListener(element, 'zoom-in', () => {
      this.navigationState.zoomBy(0.5);
    });

    registerActionListener(element, 'zoom-out', () => {
      this.navigationState.zoomBy(2.0);
    });

    registerActionListener(element, 'highlight', () => {
      this.viewer.layerManager.invokeAction('highlight');
    });

    for (let axis = 0; axis < 3; ++axis) {
      let axisName = AXES_NAMES[axis];
      for (let sign of [-1, +1]) {
        let signStr = (sign < 0) ? '-' : '+';
        registerActionListener(element, `rotate-relative-${axisName}${signStr}`, () => {
          this.navigationState.pose.rotateRelative(kAxes[axis], sign * 0.1);
        });
        let tempOffset = vec3.create();
        registerActionListener(element, `${axisName}${signStr}`, () => {
          let {navigationState} = this;
          let offset = tempOffset;
          offset[0] = 0;
          offset[1] = 0;
          offset[2] = 0;
          offset[axis] = sign;
          navigationState.pose.translateVoxelsRelative(offset);
        });
      }
    }

    registerActionListener(element, 'zoom-via-wheel', (event: ActionEvent<WheelEvent>) => {
      const e = event.detail;
      this.onMousemove(e);
      this.zoomByMouse(getWheelZoomAmount(e));
    });

    for (const amount of [1, 10]) {
      registerActionListener(element, `z+${amount}-via-wheel`, (event: ActionEvent<WheelEvent>) => {
        const e = event.detail;
        let {navigationState} = this;
        let offset = tempVec3;
        let delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        offset[0] = 0;
        offset[1] = 0;
        offset[2] = (delta > 0 ? -1 : 1) * amount;
        navigationState.pose.translateVoxelsRelative(offset);
      });
    }

    registerActionListener(element, 'move-to-mouse-position', () => {
      let {mouseState} = this.viewer;
      if (mouseState.updateUnconditionally()) {
        let position = this.navigationState.pose.position;
        vec3.copy(position.spatialCoordinates, mouseState.position);
        position.changed.dispatch();
      }
    });

    registerActionListener(element, 'snap', () => this.navigationState.pose.snap());

    registerActionListener(element, 'select-annotation', () => {
      const {mouseState, layerManager} = this.viewer;
      const state = getSelectedAnnotation(mouseState, layerManager);
      if (state === undefined) {
        return;
      }
      const userLayer = state.layer.layer;
      if (userLayer !== null) {
        this.viewer.selectedLayer.layer = state.layer;
        this.viewer.selectedLayer.visible = true;
        userLayer.tabs.value = 'annotations';
        (<UserLayerWithAnnotations>userLayer).selectedAnnotation.value = {
          id: state.id,
          partIndex: state.partIndex
        };
      }
    });
    registerActionListener(element, 'move-annotation', (e: ActionEvent<MouseEvent>) => {
      const {mouseState} = this.viewer;
      const selectedAnnotationId = mouseState.pickedAnnotationId;
      const annotationLayer = mouseState.pickedAnnotationLayer;
      if (annotationLayer !== undefined) {
        if (selectedAnnotationId !== undefined) {
          e.stopPropagation();
          let annotationRef = annotationLayer.source.getReference(selectedAnnotationId)!;
          let ann = <Annotation>annotationRef.value;

          const handler = getAnnotationTypeRenderHandler(ann.type);
          const pickedOffset = mouseState.pickedOffset;
          let repPoint = handler.getRepresentativePoint(
              annotationLayer.objectToGlobal, ann, mouseState.pickedOffset);
          let totDeltaVec = vec2.set(vec2.create(), 0, 0);
          if (mouseState.updateUnconditionally()) {
            startRelativeMouseDrag(
                e.detail,
                (_event, deltaX, deltaY) => {
                  vec2.add(totDeltaVec, totDeltaVec, [deltaX, deltaY]);
                  let newRepPt = this.translateDataPointByViewportPixels(
                      vec3.create(), repPoint, totDeltaVec[0], totDeltaVec[1]);
                  let newAnnotation = handler.updateViaRepresentativePoint(
                      <Annotation>annotationRef.value, newRepPt, annotationLayer.globalToObject,
                      pickedOffset);
                  annotationLayer.source.delete(annotationRef);
                  annotationRef.dispose();
                  annotationRef = annotationLayer.source.add(newAnnotation, true);
                },
                (_event) => {
                  annotationRef.dispose();
                });
          }
        }
      }
    });
  }


  onMouseout(_event: MouseEvent) {
    let {mouseState} = this.viewer;
    mouseState.updater = undefined;
    mouseState.setActive(false);
  }

  onMousemove(event: MouseEvent) {
    let {element} = this;
    if (event.target !== element) {
      return;
    }
    this.mouseX = event.offsetX - element.clientLeft;
    this.mouseY = event.offsetY - element.clientTop;
    let {mouseState} = this.viewer;
    mouseState.pageX = event.pageX;
    mouseState.pageY = event.pageY;
    mouseState.updater = this.mouseStateUpdater;
    mouseState.triggerUpdate();
  }

  disposed() {
    let {mouseState} = this.viewer;
    if (mouseState.updater === this.mouseStateUpdater) {
      mouseState.updater = undefined;
      mouseState.setActive(false);
    }
    super.disposed();
  }

  abstract zoomByMouse(factor: number): void;
}
