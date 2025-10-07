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

import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest } from "@smithy/types";
import {
  fetchOkWithCredentials,
  fetchOkWithCredentialsAdapter,
} from "#src/credentials_provider/http_request.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import type { FetchOk, HttpError } from "#src/util/http_request.js";
import { fetchOk } from "#src/util/http_request.js";

//aws-sdk signature v4 signer

/**
 * AWS Access Tokens
 */
export interface AWSSignatureV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  token?: string; // if provided, expiration should be provided as well
  // AccountId?: string;
  // Expiration?: string; // rfc3339
}

async function applyCredentials(
  credentials: AWSSignatureV4Credentials,
  init: RequestInit,
  input: RequestInfo,
): Promise<RequestInit> {
  if (!credentials.accessKeyId) {
    return init;
  }
  const signer = new SignatureV4({
    service: "s3",
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.token,
    },
    sha256: Sha256,
  });
  const apiUrl = new URL(input.toString());
  const request = {
    hostname: apiUrl.hostname.toString(),
    protocol: apiUrl.protocol,
    path: apiUrl.pathname,
    method: init.method || "GET",
    headers: { ...init.headers, host: apiUrl.hostname.toString() },
  } as HttpRequest;
  return signer
    .sign(request)
    .then((signedRequest) => {
      const headers = signedRequest.headers;
      const x = { ...init, headers };
      return x;
    })
    .catch((error) => {
      throw error;
    });
}

function errorHandler(
  error: HttpError,
  credentials: AWSSignatureV4Credentials,
): "refresh" {
  const { status } = error;
  if (status === 401) {
    // 401: Authorization needed.
    return "refresh";
  }
  if (status === 403 && !credentials.accessKeyId) {
    // Anonymous access denied.  Request credentials.
    return "refresh";
  }
  throw error;
}

export function fetchOkWithAWSSignatureV4Credentials(
  credentialsProvider:
    | CredentialsProvider<AWSSignatureV4Credentials>
    | undefined,
  input: RequestInfo,
  init: RequestInit,
): Promise<Response> {
  if (credentialsProvider === undefined) {
    return fetchOk(input, init);
  }
  return fetchOkWithCredentials(
    credentialsProvider,
    input,
    init,
    applyCredentials,
    errorHandler,
  );
}

export function fetchOkWithAWSSignatureV4CredentialsAdapter(
  credentialsProvider:
    | CredentialsProvider<AWSSignatureV4Credentials>
    | undefined,
): FetchOk {
  if (credentialsProvider === undefined) return fetchOk;
  return fetchOkWithCredentialsAdapter(
    credentialsProvider,
    applyCredentials,
    errorHandler,
  );
}
