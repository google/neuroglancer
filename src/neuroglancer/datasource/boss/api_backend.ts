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
 * @file
 * This implements the authentication API by simply forwarding all requests to the frontend.
 */

import {implementation, Token} from 'neuroglancer/datasource/boss/api_implementation';
import {registerRPC} from 'neuroglancer/worker_rpc';
import {rpc} from 'neuroglancer/worker_rpc_context';

let resolvePromise: ((token: Token) => void)|null = null;

implementation.getNewTokenPromise = function(invalidToken) {
  let msg: any = {};
  if (invalidToken != null) {
    msg['invalidToken'] = invalidToken;
  }
  let promise = new Promise(function(resolve, _reject) { resolvePromise = resolve; });
  rpc.invoke('boss.requestToken', msg);
  return promise;
};

registerRPC('boss.receiveToken', function(x) { resolvePromise!(x['authResult']); });
