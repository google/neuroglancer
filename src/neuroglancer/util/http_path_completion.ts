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

import {CancellationToken} from 'neuroglancer/util/cancellation';
import {BasicCompletionResult, Completion} from 'neuroglancer/util/completion';
import {parseUrl} from 'neuroglancer/util/http_request';
import {cancellableFetchOk} from 'neuroglancer/util/http_request';
import {getS3PathCompletions} from 'neuroglancer/util/s3_bucket_listing';

/**
 * Obtains a directory listing from a server that supports HTML directory listings.
 */
export async function getHtmlDirectoryListing(
    url: string, cancellationToken: CancellationToken): Promise<string[]> {
  const {text, contentType} = await cancellableFetchOk(
      url,
      /*init=*/ {headers: {'accept': 'text/html'}},
      async x => ({text: await x.text(), contentType: x.headers.get('content-type')}),
      cancellationToken);
  if (contentType !== 'text/html') {
    return [];
  }
  const doc = new DOMParser().parseFromString(text, contentType);
  const nodes =
      doc.evaluate('//a/@href', doc, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null);
  const results: string[] = [];
  for (let i = 0, n = nodes.snapshotLength; i < n; ++i) {
    const node = nodes.snapshotItem(i);
    const href = node.textContent;
    if (href) {
      results.push(new URL(href, url).toString());
    }
  }
  return results;
}

export async function getHtmlPathCompletions(
    url: string, cancellationToken: CancellationToken): Promise<BasicCompletionResult> {
  const m = url.match(/^([a-z]+:\/\/.*\/)([^\/?#]*)$/);
  if (m === null) throw null;
  const entries = await getHtmlDirectoryListing(m[1], cancellationToken);
  const offset = m[1].length;
  const matches: Completion[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(url)) continue;
    matches.push({value: entry.substring(offset)});
  }
  return {
    offset,
    completions: matches,
  };
}


export async function completeHttpPath(url: string, cancellationToken: CancellationToken) {
  let result;
  try {
    result = parseUrl(url);
  } catch {
    throw null;
  }
  const {protocol, host, path} = result;
  if (protocol === 'gs' && path.length > 0) {
    return await getS3PathCompletions(
        `${protocol}://${host}`, `https://storage.googleapis.com/${host}`, path, cancellationToken);
  }
  const s3Match = url.match(/^((?:http|https):\/\/(?:storage\.googleapis\.com\/[^\/]+|[^\/]+\.storage\.googleapis\.com))(\/.*)$/);
  if (s3Match !== null) {
    return await getS3PathCompletions(s3Match[1], s3Match[1], s3Match[2], cancellationToken);
  }
  if ((protocol === 'http' || protocol === 'https') && path.length > 0) {
    return await getHtmlPathCompletions(url, cancellationToken);
  }
  throw null;
}
