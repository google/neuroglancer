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

import { fetchOkWithCredentials } from "#src/credentials_provider/http_request.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";

export interface DVIDToken {
  // If token is undefined, it indicates anonymous credentials that may be retried.
  token?: string;
}

export const credentialsKey = "DVID";

export class DVIDInstance {
  constructor(
    public baseUrl: string,
    public nodeKey: string,
  ) {}

  getNodeApiUrl(path = ""): string {
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

export function appendQueryStringForDvid(
  url: string,
  user: string | null | undefined,
) {
  if (url.includes("?")) {
    url += "&";
  } else {
    url += "?";
  }
  url += "app=Neuroglancer";
  if (user) {
    url += `&u=${user}`;
  }
  return url;
}

export function fetchWithDVIDCredentials(
  credentialsProvider: CredentialsProvider<DVIDToken>,
  input: string,
  init: RequestInit,
): Promise<Response> {
  return fetchOkWithCredentials(
    credentialsProvider,
    input,
    init,
    (credentials: DVIDToken, init: RequestInit) => {
      const newInit: RequestInit = { ...init };
      if (credentials.token) {
        newInit.headers = {
          ...newInit.headers,
          Authorization: `Bearer ${credentials}`,
        };
      }
      return newInit;
    },
    (error) => {
      const { status } = error;
      if (status === 403 || status === 401) {
        // Authorization needed.  Retry with refreshed token.
        return "refresh";
      }
      throw error;
    },
  );
}
