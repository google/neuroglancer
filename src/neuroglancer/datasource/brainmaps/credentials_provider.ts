/**
 * @license
 * Copyright 2016 Google Inc.
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
 * @file This implements a Brain Maps CredentialsProvider based on neuroglancer/util/google_auth2.
 */

import {GoogleOAuth2CredentialsProvider, OPENID_SCOPE, EMAIL_SCOPE} from 'neuroglancer/util/google_oauth2';

const BRAINMAPS_SCOPE = 'https://www.googleapis.com/auth/brainmaps';

export class BrainmapsCredentialsProvider extends GoogleOAuth2CredentialsProvider {
  constructor(clientId: string) {
    super({
      clientId: clientId,
      scopes: [BRAINMAPS_SCOPE, OPENID_SCOPE, EMAIL_SCOPE],
      description: 'Brain Maps'
    });
  }
}
