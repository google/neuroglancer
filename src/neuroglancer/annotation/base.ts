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

import {SliceViewChunkSpecification} from 'neuroglancer/sliceview/base';

export const ANNOTATION_METADATA_CHUNK_SOURCE_RPC_ID = 'annotation.MetadataChunkSource';
export const ANNOTATION_GEOMETRY_CHUNK_SOURCE_RPC_ID = 'annotation.GeometryChunkSource';
export const ANNOTATION_SUBSET_GEOMETRY_CHUNK_SOURCE_RPC_ID = 'annotation.SubsetGeometryChunkSource';
export const ANNOTATION_REFERENCE_ADD_RPC_ID = 'annotation.reference.add';
export const ANNOTATION_REFERENCE_DELETE_RPC_ID = 'annotation.reference.delete';
export const ANNOTATION_COMMIT_UPDATE_RPC_ID = 'annotation.commit';
export const ANNOTATION_COMMIT_UPDATE_RESULT_RPC_ID = 'annotation.commit';

export interface AnnotationGeometryChunkSpecification extends SliceViewChunkSpecification {}

export const ANNOTATION_PERSPECTIVE_RENDER_LAYER_RPC_ID = 'annotation/PerspectiveRenderLayer';
export const ANNOTATION_RENDER_LAYER_RPC_ID = 'annotation/RenderLayer';
export const ANNOTATION_RENDER_LAYER_UPDATE_SEGMENTATION_RPC_ID =
    'annotation/RenderLayer.updateSegmentation';
