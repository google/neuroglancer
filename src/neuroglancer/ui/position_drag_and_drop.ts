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

import {dimensionNamesFromJson} from 'neuroglancer/coordinate_transform';
import {Position} from 'neuroglancer/navigation_state';
import {Borrowed, registerEventListener} from 'neuroglancer/util/disposable';
import {parseArray, verifyFiniteFloat, verifyObject, verifyObjectProperty} from 'neuroglancer/util/json';
import {positionDragType} from 'neuroglancer/widget/position_widget';

export function setupPositionDropHandlers(target: EventTarget, position: Borrowed<Position>) {
  const dropDisposer = registerEventListener(target, 'drop', (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer!.types.indexOf(positionDragType) !== -1) {
      event.stopPropagation();
      const obj = verifyObject(JSON.parse(event.dataTransfer!.getData(positionDragType)));
      const dimensions = verifyObjectProperty(obj, 'dimensions', dimensionNamesFromJson);
      const positionVec = verifyObjectProperty(
          obj, 'position', positionObj => parseArray(positionObj, verifyFiniteFloat));
      if (positionVec.length !== dimensions.length) {
        throw new Error('length mismatch between position and dimensions');
      }
      const rank = positionVec.length;
      const {coordinateSpace: {value: {names}}, value: coordinates} = position;
      for (let i = 0; i < rank; ++i) {
        const dim = names.indexOf(dimensions[i]);
        if (dim === -1) continue;
        coordinates[dim] = positionVec[i];
      }
      position.changed.dispatch();
    }
  });
  const handleDragOver = (event: DragEvent) => {
    if (event.dataTransfer!.types.indexOf(positionDragType) !== -1) {
      // Permit drag.
      event.dataTransfer!.dropEffect = 'link';
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const dragenterDisposer = registerEventListener(target, 'dragenter', handleDragOver);
  const dragoverDisposer = registerEventListener(target, 'dragover', handleDragOver);
  return () => {
    dragenterDisposer();
    dragoverDisposer();
    dropDisposer();
  };
}
