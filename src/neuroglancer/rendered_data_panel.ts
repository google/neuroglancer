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
import {NavigationState} from 'neuroglancer/navigation_state';
import {AXES_NAMES, kAxes, vec3} from 'neuroglancer/util/geom';
import {getWheelZoomAmount} from 'neuroglancer/util/wheel_zoom';
import {ViewerState} from 'neuroglancer/viewer_state';

require('./rendered_data_panel.css');

export const KEY_COMMANDS = new Map<string, (this: RenderedDataPanel) => void>();
for (let axis = 0; axis < 3; ++axis) {
  let axisName = AXES_NAMES[axis];
  for (let sign of [-1, +1]) {
    let signStr = (sign < 0) ? '-' : '+';
    KEY_COMMANDS.set(`rotate-relative-${axisName}${signStr}`, function() {
      this.navigationState.pose.rotateRelative(kAxes[axis], sign * 0.1);
    });
    let tempOffset = vec3.create();
    KEY_COMMANDS.set(`${axisName}${signStr}`, function() {
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
KEY_COMMANDS.set('snap', function() {
  this.navigationState.pose.snap();
});

KEY_COMMANDS.set('zoom-in', function() {
  this.navigationState.zoomBy(0.5);
});
KEY_COMMANDS.set('zoom-out', function() {
  this.navigationState.zoomBy(2.0);
});

const tempVec3 = vec3.create();

export abstract class RenderedDataPanel extends RenderedPanel {
  // Last mouse position within the panel.
  mouseX = 0;
  mouseY = 0;

  abstract updateMouseState(state: MouseSelectionState): boolean;

  private mouseStateUpdater = this.updateMouseState.bind(this);

  navigationState: NavigationState;

  constructor(context: DisplayContext, element: HTMLElement, public viewer: ViewerState) {
    super(context, element, viewer.visibility);

    element.classList.add('rendered-data-panel');

    this.registerEventListener(element, 'mousemove', this.onMousemove.bind(this));
    this.registerEventListener(element, 'mouseleave', this.onMouseout.bind(this));
    this.registerEventListener(element, 'mousedown', this.onMousedown.bind(this), false);
    this.registerEventListener(element, 'wheel', this.onMousewheel.bind(this), false);
    this.registerEventListener(element, 'dblclick', () => {
      this.viewer.layerManager.invokeAction('select');
    });
  }

  onMouseout(_event: MouseEvent) {
    let {mouseState} = this.viewer;
    mouseState.updater = undefined;
    mouseState.setActive(false);
  }

  onKeyCommand(action: string) {
    let command = KEY_COMMANDS.get(action);
    if (command) {
      command.call(this);
      return true;
    }
    return false;
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

  disposed() {
    let {mouseState} = this.viewer;
    if (mouseState.updater === this.mouseStateUpdater) {
      mouseState.updater = undefined;
      mouseState.setActive(false);
    }
    super.disposed();
  }

  abstract zoomByMouse(factor: number): void;

  onMousewheel(e: WheelEvent) {
    if (e.ctrlKey) {
      this.onMousemove(e);
      this.zoomByMouse(getWheelZoomAmount(e));
    } else {
      let {navigationState} = this;
      let offset = tempVec3;
      let delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      offset[0] = 0;
      offset[1] = 0;
      offset[2] = (delta > 0 ? -1 : 1) * (e.shiftKey ? 10 : 1);
      navigationState.pose.translateVoxelsRelative(offset);
    }
    e.preventDefault();
  }

  abstract startDragViewport(e: MouseEvent): void;

  onMousedown(e: MouseEvent) {
    if (e.target !== this.element) {
      return;
    }
    this.onMousemove(e);
    if (e.button === 0) {
      if (e.ctrlKey) {
        let {mouseState} = this.viewer;
        if (mouseState.updateUnconditionally()) {
          this.viewer.layerManager.invokeAction('annotate');
        }
      } else {
        this.startDragViewport(e);
      }
    } else if (e.button === 2) {
      let {mouseState} = this.viewer;
      if (mouseState.updateUnconditionally()) {
        let position = this.navigationState.pose.position;
        vec3.copy(position.spatialCoordinates, mouseState.position);
        position.changed.dispatch();
      }
    }
  }
}
