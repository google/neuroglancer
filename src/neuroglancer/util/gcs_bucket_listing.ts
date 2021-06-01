/**
 * @license
 * Copyright 2020 Google Inc.
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

import {fetchWithOAuth2Credentials} from 'neuroglancer/credentials_provider/oauth2';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {BasicCompletionResult} from 'neuroglancer/util/completion';
import {responseJson} from 'neuroglancer/util/http_request';
import {parseArray, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

export async function getGcsBucketListing(
    credentialsProvider: SpecialProtocolCredentialsProvider, bucket: string, prefix: string,
    delimiter: string, cancellationToken: CancellationToken): Promise<string[]> {
  // Include origin as `neuroglancerOrigin` query string parameter.  See comment in
  // `special_protocol_request.ts` for details.
  const response = await fetchWithOAuth2Credentials(
      credentialsProvider,
      `https://www.googleapis.com/storage/v1/b/${bucket}/o?` +
          `delimiter=${encodeURIComponent(delimiter)}&prefix=${encodeURIComponent(prefix)}&` +
          `neuroglancerOrigin=${encodeURIComponent(location.origin)}`,
      {}, responseJson, cancellationToken);
  verifyObject(response);
  const prefixes = verifyOptionalObjectProperty(response, 'prefixes', verifyStringArray, []);
  const items = verifyOptionalObjectProperty(
                    response, 'items',
                    items => parseArray(
                        items,
                        item => {
                          verifyObject(item);
                          return verifyObjectProperty(item, 'name', verifyString);
                        }),
                    [])
                    .filter(name => !name.endsWith('_$folder$'));
  return [...prefixes, ...items];
}


export async function getGcsPathCompletions(
    credentialsProvider: SpecialProtocolCredentialsProvider, enteredBucketUrl: string,
    bucket: string, path: string,
    cancellationToken: CancellationToken): Promise<BasicCompletionResult> {
  let prefix = path;
  if (!prefix.startsWith('/')) throw null;
  const paths = await getGcsBucketListing(
      credentialsProvider, bucket, path.substring(1), '/', cancellationToken);
  let offset = path.lastIndexOf('/');
  return {
    offset: offset + enteredBucketUrl.length + 1,
    completions: paths.map(x => ({value: x.substring(offset)})),
  };
}
