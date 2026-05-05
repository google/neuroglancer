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

import { SkeletonSourceParameters } from "#src/datasource/precomputed/base.js";

export class CatmaidDataSourceParameters {
  url!: string;
  projectId!: number;
  cacheProvider?: string;
  spatialSkeletonsReadOnly?: boolean;
}

export class CatmaidSkeletonSourceParameters extends SkeletonSourceParameters {
  catmaidParameters!: CatmaidDataSourceParameters;
  gridIndex?: number;
  catmaidLod?: number;
  static RPC_ID = "catmaid/SkeletonSource";
}

export class CatmaidCompleteSkeletonSourceParameters extends SkeletonSourceParameters {
  catmaidParameters!: CatmaidDataSourceParameters;
  static RPC_ID = "catmaid/CompleteSkeletonSource";
}
