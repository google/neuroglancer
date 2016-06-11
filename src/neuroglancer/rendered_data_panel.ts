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

import {DisplayContext, RenderedPanel} from 'neuroglancer/display_context';
import {MouseSelectionState} from 'neuroglancer/layer';
import {getWheelZoomAmount} from 'neuroglancer/util/wheel_zoom';
import {ViewerState} from 'neuroglancer/viewer_state';
import {vec3} from 'neuroglancer/util/geom';

require('./rendered_data_panel.css');

export abstract class RenderedDataPanel extends RenderedPanel {
  // Last mouse position within the panel.
  mouseX = 0;
  mouseY = 0;

  abstract updateMouseState(state: MouseSelectionState): boolean;

  private mouseStateUpdater = this.updateMouseState.bind(this);

  constructor(context: DisplayContext, element: HTMLElement, public viewer: ViewerState) {
    super(context, element);

    element.classList.add('rendered-data-panel');

    this.registerEventListener(element, 'mousemove', this.onMousemove.bind(this));
    this.registerEventListener(element, 'mouseleave', this.onMouseout.bind(this));
    this.registerEventListener(element, 'mousedown', this.onMousedown.bind(this), false);
    this.registerEventListener(element, 'wheel', this.onMousewheel.bind(this), false);
    this.registerEventListener(
        element, 'dblclick', () => { this.viewer.layerManager.invokeAction('select'); });
  }

  onMouseout(event: MouseEvent) {
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
    mouseState.updater = this.mouseStateUpdater;
    mouseState.triggerUpdate();
  }
  onMousewheel(e: WheelEvent) {
    this.viewer.navigationState.zoomBy(getWheelZoomAmount(e));
    e.preventDefault();
  }
  onMousedown(e: MouseEvent) {
    if (event.target !== this.element) {
      return;
    }
    this.onMousemove(e);
    if (e.button === 2) {
      let {mouseState} = this.viewer;
      if (mouseState.updateUnconditionally()) {
        let position = this.viewer.navigationState.pose.position;
        vec3.copy(position.spatialCoordinates, mouseState.position);
        position.changed.dispatch();
      }
    }
  }
};
