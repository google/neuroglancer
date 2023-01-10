/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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

import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {fetchWithCredentials} from 'neuroglancer/credentials_provider/http_request';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk, responseArrayBuffer, responseJson, ResponseTransform} from 'neuroglancer/util/http_request';

export interface DVIDToken {
  // If token is undefined, it indicates anonymous credentials that may be retried.
  token?: string;
}

export const credentialsKey = 'DVID';

interface HttpCall {
  method: 'GET'|'POST'|'DELETE'|'HEAD';
  url: string;
  payload?: string;
}

export class DVIDInstance {
  constructor(public baseUrl: string, public nodeKey: string) {}

  getNodeApiUrl(path = ''): string {
    return `${this.baseUrl}/api/node/${this.nodeKey}${path}`;
  }

  getRepoInfoUrl(): string {
    return `${this.baseUrl}/api/repos/info`;
  }

  getKeyValueUrl(dataName: string, key: string) {
    return `${this.getNodeApiUrl()}/${dataName}/key/${key}`;
  }

  getKeyValueRangeUrl(dataName: string, startKey: string, endKey: string) {
    return `${this.getNodeApiUrl()}/${dataName}/keyrange/${startKey}/${endKey}`;
  }

  getKeyValuesUrl(dataName: string) {
    return `${this.getNodeApiUrl()}/${dataName}/keyvalues?jsontar=false`;
  }
}

export function appendQueryStringForDvid(url: string, user: string|null|undefined) {
  if (url.includes('?')) {
    url += '&';
  } else {
    url += '?';
  }
  url += 'app=Neuroglancer';
  if (user) {
    url += `&u=${user}`;
  }
  return url;
}

export function responseText(response: Response): Promise<any> {
  return response.text();
}

export function makeRequest(
    httpCall: HttpCall&{responseType: 'arraybuffer'},
    cancellationToken?: CancellationToken): Promise<ArrayBuffer>;

export function makeRequest(
    httpCall: HttpCall&{responseType: 'json'}, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequest(
    httpCall: HttpCall&{responseType: ''}, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequest(
    httpCall: HttpCall&{responseType: XMLHttpRequestResponseType},
    cancellationToken: CancellationToken = uncancelableToken): any {
  let requestInfo = `${httpCall.url}`;
  let init = {method: httpCall.method, body: httpCall.payload};

  if (httpCall.responseType === '') {
    return cancellableFetchOk(requestInfo, init, responseText, cancellationToken);
  } else {
    return cancellableFetchOk(requestInfo, init, responseJson, cancellationToken);
  }
}

export function makeRequestWithCredentials(
    credentialsProvider: CredentialsProvider<DVIDToken>,
    httpCall: HttpCall&{responseType: 'arraybuffer'},
    cancellationToken?: CancellationToken): Promise<ArrayBuffer>;

export function makeRequestWithCredentials(
    credentialsProvider: CredentialsProvider<DVIDToken>, httpCall: HttpCall&{responseType: 'json'},
    cancellationToken?: CancellationToken): Promise<any>;

export function makeRequestWithCredentials(
    credentialsProvider: CredentialsProvider<DVIDToken>, httpCall: HttpCall&{responseType: ''},
    cancellationToken?: CancellationToken): Promise<any>;

export function makeRequestWithCredentials(
    credentialsProvider: CredentialsProvider<DVIDToken>,
    httpCall: HttpCall&{responseType: XMLHttpRequestResponseType},
    cancellationToken: CancellationToken = uncancelableToken): Promise<any> {
  return fetchWithDVIDCredentials(
      credentialsProvider, httpCall.url, {method: httpCall.method, body: httpCall.payload},
      httpCall.responseType === '' ?
          responseText :
          (httpCall.responseType === 'json' ? responseJson : responseArrayBuffer),
      cancellationToken);
}

export function fetchWithDVIDCredentials<T>(
    credentialsProvider: CredentialsProvider<DVIDToken>, input: string, init: RequestInit,
    transformResponse: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  return fetchWithCredentials(
      credentialsProvider, input, init, transformResponse,
      (credentials: DVIDToken, init: RequestInit) => {
        let newInit: RequestInit = {...init};
        if (credentials.token) {
          newInit.headers = {...newInit.headers, Authorization: `Bearer ${credentials}`};
        }
        return newInit;
      },
      error => {
        const {status} = error;
        if (status === 403 || status === 401) {
          // Authorization needed.  Retry with refreshed token.
          return 'refresh';
        }
        throw error;
      },
      cancellationToken);
}
