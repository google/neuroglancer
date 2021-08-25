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

import {CredentialsManager} from 'neuroglancer/credentials_provider';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {BasicCompletionResult, Completion, CompletionWithDescription, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {getGcsPathCompletions} from 'neuroglancer/util/gcs_bucket_listing';
import {cancellableFetchOk, parseUrl} from 'neuroglancer/util/http_request';
import {getS3PathCompletions} from 'neuroglancer/util/s3';
import {getS3CompatiblePathCompletions} from 'neuroglancer/util/s3_bucket_listing';
import {parseSpecialUrl} from 'neuroglancer/util/special_protocol_request';

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
  if (contentType === null || /\btext\/html\b/i.exec(contentType) === null) {
    return [];
  }
  const doc = new DOMParser().parseFromString(text, "text/html");
  const nodes =
      doc.evaluate('//a/@href', doc, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null);
  const results: string[] = [];
  for (let i = 0, n = nodes.snapshotLength; i < n; ++i) {
    const node = nodes.snapshotItem(i)!;
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

const specialProtocolEmptyCompletions: CompletionWithDescription[] = [
  {value: 'gs://', description: 'Google Cloud Storage (JSON API)'},
  {value: 'gs+xml://', description: 'Google Cloud Storage (XML API)'},
  {
    value: 'gs+ngauth+http://',
    description: 'Google Cloud Storage (JSON API) authenticated via ngauth'
  },
  {
    value: 'gs+ngauth+https://',
    description: 'Google Cloud Storage (JSON API) authenticated via ngauth'
  },
  {
    value: 'gs+xml+ngauth+http://',
    description: 'Google Cloud Storage (XML API) authenticated via ngauth'
  },
  {
    value: 'gs+xml+ngauth+https://',
    description: 'Google Cloud Storage (XML API) authenticated via ngauth'
  },
  {value: 's3://', description: 'Amazon Simple Storage Service (S3)'},
  {value: 'https://'},
  {value: 'http://'},
];


export async function completeHttpPath(
    credentialsManager: CredentialsManager, url: string,
    cancellationToken: CancellationToken): Promise<BasicCompletionResult<Completion>> {
  if (!url.includes('://')) {
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions(
          url, specialProtocolEmptyCompletions, x => x.value, x => x.description)
    };
  }
  const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(url, credentialsManager);
  const offset = url.length - parsedUrl.length;
  let result;
  try {
    result = parseUrl(parsedUrl);
  } catch {
    throw null;
  }
  const {protocol, host, path} = result;
  const completions = await (async () => {
    if (protocol === 'gs+xml' && path.length > 0) {
      return await getS3CompatiblePathCompletions(
          credentialsProvider, `${protocol}://${host}`, `https://storage.googleapis.com/${host}`,
          path, cancellationToken);
    } else if (protocol === 'gs' && path.length > 0) {
      return await getGcsPathCompletions(
          credentialsProvider, `${protocol}://${host}`, host, path, cancellationToken);
    } else if (protocol === 's3' && path.length > 0) {
      return await getS3PathCompletions(host, path, cancellationToken);
    }
    const s3Match = parsedUrl.match(
        /^((?:http|https):\/\/(?:storage\.googleapis\.com\/[^\/]+|[^\/]+\.storage\.googleapis\.com|[^\/]+\.s3(?:[^./]+)?\.amazonaws.com))(\/.*)$/);
    if (s3Match !== null) {
      return await getS3CompatiblePathCompletions(
          credentialsProvider, s3Match[1], s3Match[1], s3Match[2], cancellationToken);
    }
    if ((protocol === 'http' || protocol === 'https') && path.length > 0) {
      return await getHtmlPathCompletions(parsedUrl, cancellationToken);
    }
    throw null;
  })();
  return {offset: offset + completions.offset, completions: completions.completions};
}
