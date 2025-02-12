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

import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import type { OAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import { fetchOkWithOAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import type { RequestInitWithProgress } from "#src/util/http_request.js";

export type { OAuth2Credentials };

export type BrainmapsCredentialsProvider =
  CredentialsProvider<OAuth2Credentials>;

/**
 * Key used for retrieving the CredentialsProvider from a CredentialsManager.
 */
export const credentialsKey = "google-brainmaps";

export interface BrainmapsInstance {
  description: string;
  /**
   * One or more server URLs to use to connect to the instance.
   */
  serverUrl: string;
}

/**
 * API-related interfaces.
 */

export interface ChangeSpecPayload {
  change_stack_id?: string;
  time_stamp?: number;
  skip_equivalences?: boolean;
}

export interface ChangeStackAwarePayload {
  change_spec?: ChangeSpecPayload;
}

export interface GeometryPayload {
  corner: string;
  size: string;
  scale: number;
}

export interface GeometryAwarePayload {
  geometry: GeometryPayload;
}

export interface ImageFormatOptionsPayload {
  image_format?: "AUTO" | "JPEG" | "PNG" | "JSON";
  jpeg_quality?: number;
  compressed_segmentation_block_size?: string;
}

export interface SubvolumePayload
  extends ChangeStackAwarePayload,
    GeometryAwarePayload {
  image_format_options?: ImageFormatOptionsPayload;
  subvolume_format?: "RAW" | "SINGLE_IMAGE";
}

export interface SkeletonPayload extends ChangeStackAwarePayload {
  object_id: string;
}

export interface MeshFragmentPayload extends ChangeStackAwarePayload {
  fragment_key: string;
  object_id: string;
}

export interface BatchMeshFragment {
  object_id: string;
  fragment_keys: string[];
}

export interface BatchMeshFragmentPayload {
  volume_id: string;
  mesh_name: string;
  batches: BatchMeshFragment[];
}

export function makeRequest(
  instance: BrainmapsInstance,
  credentialsProvider: BrainmapsCredentialsProvider,
  path: string,
  init: RequestInitWithProgress = {},
): Promise<Response> {
  return fetchOkWithOAuth2Credentials(
    credentialsProvider,
    `${instance.serverUrl}${path}`,
    init,
  );
}
