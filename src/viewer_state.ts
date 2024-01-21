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

import type {
  LayerManager,
  MouseSelectionState,
  SelectedLayerState,
  TrackableDataSelectionState,
} from "#src/layer/index.js";
import type { NavigationState } from "#src/navigation_state.js";
import type { RenderLayerRole } from "#src/renderlayer.js";
import type { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableSet } from "#src/trackable_value.js";
import { VisibilityPrioritySpecification } from "#src/visibility_priority/frontend.js";

export { VisibilityPrioritySpecification };

export interface ViewerState extends VisibilityPrioritySpecification {
  visibleLayerRoles: WatchableSet<RenderLayerRole>;
  navigationState: NavigationState;
  mouseState: MouseSelectionState;
  showAxisLines: TrackableBoolean;
  layerManager: LayerManager;
  selectedLayer: SelectedLayerState;
  selectionDetailsState: TrackableDataSelectionState;
}
