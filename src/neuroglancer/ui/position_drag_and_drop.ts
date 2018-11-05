/**
 * @license
 * Copyright 2017 Google Inc.
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

import {SpatialPosition} from 'neuroglancer/navigation_state';
import {Borrowed, registerEventListener} from 'neuroglancer/util/disposable';
import {positionDragType} from 'neuroglancer/widget/position_widget';

export function setupPositionDropHandlers(
    target: EventTarget, position: Borrowed<SpatialPosition>) {
  const dropDisposer = registerEventListener(target, 'drop', (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer!.types.indexOf(positionDragType) !== -1) {
      const positionState = JSON.parse(event.dataTransfer!.getData(positionDragType));
      position.restoreState(positionState);
      event.stopPropagation();
    }
  });
  const dragoverDisposer = registerEventListener(target, 'dragover', (event: DragEvent) => {
    if (event.dataTransfer!.types.indexOf(positionDragType) !== -1) {
      // Permit drag.
      event.dataTransfer!.dropEffect = 'link';
      event.preventDefault();
      event.stopPropagation();
    }
  });
  return () => {
    dragoverDisposer();
    dropDisposer();
  };
}
