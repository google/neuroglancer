/**
 * @license
 * Copyright 2021 Google Inc.
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

import {CachingMapBasedCredentialsManager, CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk, ResponseTransform} from 'neuroglancer/util/http_request';
import {getS3CompatiblePathCompletions} from 'neuroglancer/util/s3_bucket_listing';

// Support for s3:// special protocol.

interface S3BucketCredentials {
  region: string;
}

class S3RegionProvider extends CredentialsProvider<S3BucketCredentials> {
  constructor(public bucket: string) {
    super();
  }
  get = makeCredentialsGetter(async () => {
    const {bucket} = this;
    const response =
        await cancellableFetchOk(`https://s3.amazonaws.com/${bucket}?location`, {}, x => x.text());
    const doc = new DOMParser().parseFromString(response, 'application/xml');
    const locationElement = doc.querySelector('LocationConstraint');
    if (locationElement === null) {
      throw new Error(`Unable to determine location of S3 bucket: ${bucket}`);
    }
    const location = locationElement.textContent?.trim() || 'us-east-1';
    return {region: location};
  });
}

let s3RegionCache: CachingMapBasedCredentialsManager|undefined;

export function getS3RegionCredentials(bucket: string) {
  if (s3RegionCache === undefined) {
    s3RegionCache = new CachingMapBasedCredentialsManager();
    s3RegionCache.register('s3', bucket => new S3RegionProvider(bucket));
  }
  return s3RegionCache.getCredentialsProvider('s3', bucket);
}

export async function cancellableFetchS3Ok<T>(
    credentialsProvider: CredentialsProvider<S3BucketCredentials>, bucket: string, path: string,
    requestInit: RequestInit, transformResponse: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken) {
  const credentials = await credentialsProvider.get();
  const {region} = credentials.credentials;
  return await cancellableFetchOk(
      `https://${bucket}.s3.${region}.amazonaws.com${path}`, requestInit, transformResponse,
      cancellationToken);
}

export async function getS3PathCompletions(
    bucket: string, path: string, cancellationToken: CancellationToken) {
  const credentialsProvider = getS3RegionCredentials(bucket);
  const credentials = await credentialsProvider.get();
  const {region} = credentials.credentials as S3BucketCredentials;
  return await getS3CompatiblePathCompletions(
      undefined, `s3://${bucket}`, `https://${bucket}.s3.${region}.amazonaws.com`, path,
      cancellationToken);
}
