/**
 * @license
 * Copyright 2019 Google Inc.
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

/**
 * @file Provides file listing and completion for storage systems supporting the S3 XML API (e.g. S3
 * and GCS).
 */

import {fetchWithOAuth2Credentials} from 'neuroglancer/credentials_provider/oauth2';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {BasicCompletionResult} from 'neuroglancer/util/completion';
import {SpecialProtocolCredentialsProvider} from 'neuroglancer/util/special_protocol_request';

export async function getS3BucketListing(
    credentialsProvider: SpecialProtocolCredentialsProvider, bucketUrl: string, prefix: string,
    delimiter: string, cancellationToken: CancellationToken): Promise<string[]> {
  const response = await fetchWithOAuth2Credentials(
      credentialsProvider,
      `${bucketUrl}?prefix=${encodeURIComponent(prefix)}` +
          `&delimiter=${encodeURIComponent(delimiter)}`,
      /*init=*/ {}, x => x.text(), cancellationToken);
  const doc = new DOMParser().parseFromString(response, 'application/xml');
  const commonPrefixNodes = doc.evaluate(
      '//*[name()="CommonPrefixes"]/*[name()="Prefix"]', doc, null,
      XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null);
  const results: string[] = [];
  for (let i = 0, n = commonPrefixNodes.snapshotLength; i < n; ++i) {
    results.push(commonPrefixNodes.snapshotItem(i)!.textContent || '');
  }
  const contents = doc.evaluate(
      '//*[name()="Contents"]/*[name()="Key"]', doc, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
      null);
  for (let i = 0, n = contents.snapshotLength; i < n; ++i) {
    results.push(contents.snapshotItem(i)!.textContent || '');
  }
  return results;
}

export async function getS3CompatiblePathCompletions(
    credentialsProvider: SpecialProtocolCredentialsProvider, enteredBucketUrl: string,
    bucketUrl: string, path: string,
    cancellationToken: CancellationToken): Promise<BasicCompletionResult> {
  let prefix = path;
  if (!prefix.startsWith('/')) throw null;
  const paths = await getS3BucketListing(
      credentialsProvider, bucketUrl, path.substring(1), '/', cancellationToken);
  let offset = path.lastIndexOf('/');
  return {
    offset: offset + enteredBucketUrl.length + 1,
    completions: paths.map(x => ({value: x.substring(offset)})),
  };
}
