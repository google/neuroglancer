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

import type {
  AnnotationPropertySpec,
  AnnotationType,
} from "#src/annotation/index.js";

/**
 * Numpy-style dtype string for a per-vertex attribute as written by
 * zarr-vectors.  Subset that maps directly onto neuroglancer
 * annotation property serializer types.
 */
export type ZarrVectorsAttributeDtype =
  | "float32"
  | "uint8"
  | "uint16"
  | "uint32"
  | "int8"
  | "int16"
  | "int32";

export class ZarrVectorsAnnotationSourceParameters {
  rank: number;
  type: AnnotationType;
  properties: AnnotationPropertySpec[];
  static RPC_ID = "zarr-vectors/AnnotationSource";
}

export class ZarrVectorsAnnotationSpatialIndexSourceParameters {
  // Pipeline URL of the level directory (ends with "/"), e.g.
  // ".../store.zvr/0/".
  baseUrl: string;
  rank: number;
  // Parallel arrays: attributeNames[i] is the directory name under
  // <baseUrl>/attributes/, and attributeDtypes[i] is the numpy dtype of
  // the chunk byte blob.  Index i in this list corresponds to property
  // index i on the parent AnnotationSource.
  attributeNames: string[];
  attributeDtypes: ZarrVectorsAttributeDtype[];
  static RPC_ID = "zarr-vectors/AnnotationSpatialIndexSource";
}
