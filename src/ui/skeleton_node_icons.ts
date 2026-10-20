/**
 * @license
 * Copyright 2026 Google Inc.
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

import svg_circle from "ikonate/icons/circle.svg?raw";
import svg_flag from "ikonate/icons/flag.svg?raw";
import svg_minus from "ikonate/icons/minus.svg?raw";
import svg_origin from "ikonate/icons/origin.svg?raw";
import svg_share_android from "ikonate/icons/share-android.svg?raw";
import { SkeletonDisplayNodeType } from "#src/skeleton/node_types.js";

const SKELETON_NODE_TYPE_ICONS: Record<SkeletonDisplayNodeType, string> = {
  [SkeletonDisplayNodeType.ROOT]: svg_origin,
  [SkeletonDisplayNodeType.BRANCH_START]: svg_share_android,
  [SkeletonDisplayNodeType.REGULAR]: svg_minus,
  [SkeletonDisplayNodeType.VIRTUAL_END]: svg_circle,
};

export function getSkeletonNodeTypeIcon(
  nodeType: SkeletonDisplayNodeType,
  nodeIsTrueEnd: boolean,
): string {
  return nodeIsTrueEnd ? svg_flag : SKELETON_NODE_TYPE_ICONS[nodeType];
}
