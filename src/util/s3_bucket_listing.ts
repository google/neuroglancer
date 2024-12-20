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

import { fetchWithOAuth2Credentials } from "#src/credentials_provider/oauth2.js";
import type { BasicCompletionResult } from "#src/util/completion.js";
import type { SpecialProtocolCredentialsProvider } from "#src/util/special_protocol_request.js";

export async function getS3BucketListing(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  bucketUrl: string,
  prefix: string,
  delimiter: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  const response = await fetchWithOAuth2Credentials(
    credentialsProvider,
    `${bucketUrl}?prefix=${encodeURIComponent(prefix)}` +
      `&delimiter=${encodeURIComponent(delimiter)}`,
    /*init=*/ { signal: abortSignal },
  );
  const doc = new DOMParser().parseFromString(
    await response.text(),
    "application/xml",
  );
  const commonPrefixNodes = doc.evaluate(
    '//*[name()="CommonPrefixes"]/*[name()="Prefix"]',
    doc,
    null,
    XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  const results: string[] = [];
  for (let i = 0, n = commonPrefixNodes.snapshotLength; i < n; ++i) {
    results.push(commonPrefixNodes.snapshotItem(i)!.textContent || "");
  }
  const contents = doc.evaluate(
    '//*[name()="Contents"]/*[name()="Key"]',
    doc,
    null,
    XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  for (let i = 0, n = contents.snapshotLength; i < n; ++i) {
    results.push(contents.snapshotItem(i)!.textContent || "");
  }
  return results;
}

export async function getS3CompatiblePathCompletions(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  enteredBucketUrl: string,
  bucketUrl: string,
  path: string,
  abortSignal: AbortSignal,
): Promise<BasicCompletionResult> {
  const prefix = path;
  if (!prefix.startsWith("/")) throw null;
  const paths = await getS3BucketListing(
    credentialsProvider,
    bucketUrl,
    path.substring(1),
    "/",
    abortSignal,
  );
  const offset = path.lastIndexOf("/");
  return {
    offset: offset + enteredBucketUrl.length + 1,
    completions: paths.map((x) => ({ value: x.substring(offset) })),
  };
}
