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

import {CredentialsManager, MaybeOptionalCredentialsProvider} from 'neuroglancer/credentials_provider';
import {fetchWithOAuth2Credentials, OAuth2Credentials} from 'neuroglancer/credentials_provider/oauth2';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {parseUrl, ResponseTransform} from 'neuroglancer/util/http_request';

export type SpecialProtocolCredentials = OAuth2Credentials|undefined;
export type SpecialProtocolCredentialsProvider =
  MaybeOptionalCredentialsProvider<SpecialProtocolCredentials>;

function getMiddleAuthCredentialsProvider(
    credentialsManager: CredentialsManager, url: string): SpecialProtocolCredentialsProvider {
  return credentialsManager.getCredentialsProvider(
    'middleauthapp', new URL(url).origin);
}

function getNgauthCredentialsProvider(
    credentialsManager: CredentialsManager, serverUrl: string,
    path: string): SpecialProtocolCredentialsProvider {
  const bucketPattern = /^\/([^\/]+)/;
  const m = path.match(bucketPattern);
  if (m === null) return undefined;
  return typeof NEUROGLANCER_PYTHON_INTEGRATION !== 'undefined' ?
      credentialsManager.getCredentialsProvider('gcs', {bucket: m[1]}) :
      credentialsManager.getCredentialsProvider(
          'ngauth_gcs', {authServer: serverUrl, bucket: m[1]});
}

export function parseSpecialUrl(url: string, credentialsManager: CredentialsManager):
    {url: string, credentialsProvider: SpecialProtocolCredentialsProvider} {
  const u = parseUrl(url);
  switch (u.protocol) {
    case 'gs':
    case 'gs+xml':
      return {
        credentialsProvider: typeof NEUROGLANCER_PYTHON_INTEGRATION !== 'undefined' ?
            credentialsManager.getCredentialsProvider('gcs', {bucket: u.host}) :
            undefined,
        url,
      };
    case 'gs+ngauth+http':
      return {
        credentialsProvider: getNgauthCredentialsProvider(credentialsManager, `http://${u.host}`, u.path),
        url: 'gs:/' + u.path,
      };
    case 'gs+ngauth+https':
      return {
        credentialsProvider: getNgauthCredentialsProvider(credentialsManager, `https://${u.host}`, u.path),
        url: 'gs:/' + u.path,
      };
    case 'gs+xml+ngauth+http':
      return {
        credentialsProvider: getNgauthCredentialsProvider(credentialsManager, `http://${u.host}`, u.path),
        url: 'gs+xml:/' + u.path,
      };
    case 'gs+xml+ngauth+https':
      return {
        credentialsProvider: getNgauthCredentialsProvider(credentialsManager, `https://${u.host}`, u.path),
        url: 'gs+xml:/' + u.path,
      };
    case 'middleauth+https':
      url = url.substr('middleauth+'.length);
      return {
        credentialsProvider: getMiddleAuthCredentialsProvider(credentialsManager, url),
        url: url,
      };
    default:
      return {
        credentialsProvider: undefined,
        url,
      };
  }
}

export async function cancellableFetchSpecialOk<T>(
    credentialsProvider: SpecialProtocolCredentialsProvider, url: string, init: RequestInit,
    transformResponse: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  const u = parseUrl(url);
  switch (u.protocol) {
    case 'gs':
      // Include origin as `neuroglancerOrigin` query string parameter.
      //
      // GCS fails to send an updated `Access-Control-Allow-Origin` header in 304 responses to cache
      // revalidation requests.
      //
      // https://bugs.chromium.org/p/chromium/issues/detail?id=1214563#c2
      //
      // Consequently, we include this extra query string parameter that is ignored by GCS but
      // ensures the cache is not shared.
      //
      // Note: This workaround is not needed for gs+xml because with the XML API, the
      // Access-Control-Allow-Origin response header does not vary with the Origin.
      return fetchWithOAuth2Credentials(
          credentialsProvider,
          `https://www.googleapis.com/storage/v1/b/${u.host}/o/` +
              `${encodeURIComponent(u.path.substring(1))}?alt=media&` +
              `neuroglancerOrigin=${encodeURIComponent(location.origin)}`,
          init, transformResponse, cancellationToken);
    case 'gs+xml':
      return fetchWithOAuth2Credentials(
          credentialsProvider, `https://storage.googleapis.com/${u.host}${u.path}`, init,
          transformResponse, cancellationToken);
    default:
      return fetchWithOAuth2Credentials(
          credentialsProvider, url, init, transformResponse, cancellationToken);
  }
}
