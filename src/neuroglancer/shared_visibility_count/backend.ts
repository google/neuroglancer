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

import {ON_VISIBILITY_CHANGE_METHOD_ID, SharedObjectWithVisibilityCount} from 'neuroglancer/shared_visibility_count/base';
import {registerRPC} from 'neuroglancer/worker_rpc';

registerRPC(ON_VISIBILITY_CHANGE_METHOD_ID, function(x) {
  let obj = <SharedObjectWithVisibilityCount>this.get(x['id']);
  let value = <boolean>x['visible'];
  if (value) {
    obj.visibilityCount.inc();
  } else {
    obj.visibilityCount.dec();
  }
});
