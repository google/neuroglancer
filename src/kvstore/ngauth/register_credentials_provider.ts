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

import { registerDefaultCredentialsProvider } from "#src/credentials_provider/default_manager.js";
import type { CredentialsManager } from "#src/credentials_provider/index.js";
import {
  NgauthCredentialsProvider,
  NgauthGcsCredentialsProvider,
} from "#src/kvstore/ngauth/credentials_provider.js";

registerDefaultCredentialsProvider(
  "ngauth",
  (serverUrl) => new NgauthCredentialsProvider(serverUrl),
);
registerDefaultCredentialsProvider(
  "ngauth_gcs",
  (
    parameters: { authServer: string; bucket: string },
    credentialsManager: CredentialsManager,
  ) => {
    return new NgauthGcsCredentialsProvider(
      credentialsManager.getCredentialsProvider(
        "ngauth",
        parameters.authServer,
      ),
      parameters.authServer,
      parameters.bucket,
    );
  },
);
