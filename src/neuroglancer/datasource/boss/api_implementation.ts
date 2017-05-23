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
 * @file
 * This file defines a global variable that specifies authentication API to use.
 *
 * The actual API is defined in api_{frontend,backend}.ts.
 *
 * This allows other code to be agnostic to whether it is running in the frontend (UI thread) or
 * backend (WebWorker thread)
 */

// declare var Keycloak: any;


export type Token = any;

export class Implementation { getNewTokenPromise: (invalidToken: Token) => Promise<Token>; }
export var implementation = new Implementation();

let promise: Promise<Token>|null = null;
let token: Token|null = null;

export function getToken(invalidToken?: Token) {
  if (promise !== null && (token === null || invalidToken == null))
  {
     return promise; 
  }  
  token = null;
  promise = implementation.getNewTokenPromise(invalidToken);
  promise.then((t: Token) => { token = t; });
  return promise;
}
