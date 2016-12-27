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

'use strict';

/**
 * @file This defines an AliasPlugin that provides similar functionality to the AliasPlugin included
 * in enhanced-resolve, but avoids a bug in memory-fs.
 */

/**
 * @constructor
 * @param mappings Object that maps package names to paths.
 * @param source Should normally be 'described-resolve'.
 * @param target Should normally be 'resolve'.
 */
function AliasPlugin(mappings, source, target) {
  this.mappings = mappings;
  this.source = source;
  this.target = target;
}
AliasPlugin.prototype.apply = function(resolver) {
  const mappings = this.mappings;
  const target = this.target;
  resolver.plugin(this.source, function(request, callback) {
    const match = request.request.match(/^([^\/]+)((?:\/.*)?)$/);
    if (match !== null) {
      const key = match[1];
      if (mappings.hasOwnProperty(key)) {
        const mapped = mappings[key];
        var obj = Object.assign({}, request, {request: mapped + match[2]});
        return resolver.doResolve(
            target, obj,
            'aliased with mapping ' + JSON.stringify(key) + ' -> ' + JSON.stringify(obj.request),
            callback);
      }
    }
    return callback();
  });
};

module.exports = AliasPlugin;
