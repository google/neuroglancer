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

import {LayerManager, MouseSelectionState} from 'neuroglancer/layer';
import {NavigationState} from 'neuroglancer/navigation_state';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {VisibilityPrioritySpecification} from 'neuroglancer/visibility_priority/frontend';

export interface ViewerPositionState {
  navigationState: NavigationState;
  mouseState: MouseSelectionState;
  showAxisLines: TrackableBoolean;
}

export {VisibilityPrioritySpecification};

export interface ViewerState extends ViewerPositionState, VisibilityPrioritySpecification {
  layerManager: LayerManager;
}
