/**
 * @license
 * Copyright 2017 Google Inc.
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
 * @file Implementation of a CredentialsProvider based on an input and output TrackableValue.
 */

import type {
  CredentialsManager,
  CredentialsWithGeneration,
} from "#src/credentials_provider/index.js";
import {
  AnonymousFirstCredentialsProvider,
  CredentialsProvider,
  makeCachedCredentialsGetter,
} from "#src/credentials_provider/index.js";
import type { Client } from "#src/python_integration/api.js";
import { fetchOk } from "#src/util/http_request.js";
import {
  stableStringify,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
} from "#src/util/json.js";
import { Memoize } from "#src/util/memoize.js";

class PythonCredentialsProvider<
  Credentials,
> extends CredentialsProvider<Credentials> {
  constructor(
    private client: Client,
    private key: string,
    private parameters: any,
  ) {
    super();
  }

  get = makeCachedCredentialsGetter(
    async (
      invalidCredentials?: CredentialsWithGeneration<Credentials>,
    ): Promise<CredentialsWithGeneration<Credentials>> => {
      const response = await fetchOk(this.client.urls.credentials, {
        method: "POST",
        body: JSON.stringify({
          key: this.key,
          parameters: this.parameters,
          invalid: invalidCredentials?.generation,
        }),
      });
      const json = await response.json();
      verifyObject(json);
      const generation = verifyObjectProperty(json, "generation", verifyInt);
      const credentials = json.credentials as Credentials;
      return { generation, credentials };
    },
  );
}

class GcsCredentialsProvider extends AnonymousFirstCredentialsProvider<any> {
  constructor(baseProvider: CredentialsProvider<any>) {
    super(baseProvider, { accessToken: "", tokenType: "" });
  }
}

class AwsCredentialsProvider extends AnonymousFirstCredentialsProvider<any> {
  constructor(baseProvider: CredentialsProvider<any>) {
    super(baseProvider, {
      accessKey: "",
      secretKey: "",
      token: "",
      tokenType: "",
    });
  }
}

export class PythonCredentialsManager implements CredentialsManager {
  constructor(private client: Client) {}
  private memoize = new Memoize<string, CredentialsProvider<any>>();

  getCredentialsProvider<Credentials>(key: string, parameters?: any) {
    if (parameters === undefined) {
      parameters = null;
    }
    const combinedKey = stableStringify({ key, parameters });
    return this.memoize.get(combinedKey, () => {
      const provider = new PythonCredentialsProvider<Credentials>(
        this.client,
        key,
        parameters,
      );
      if (key === "gcs") {
        return new GcsCredentialsProvider(provider);
      }
      if (key === "s3") {
        return new AwsCredentialsProvider(provider);
      }
      return provider;
    });
  }
}
