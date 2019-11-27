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

import {AsyncComputationSpec} from 'neuroglancer/async_computation';

const handlers = new Map<string, (...args: any[]) => Promise<{value: any, transfer?: Transferable[]}>>();

(self as any).onmessage = (msg: any) => {
  const {t, id, args} = msg.data as {t: string, id: number, args: any[]};
  const handler = handlers.get(t)!;
  handler(...args).then(
      ({value, transfer}) => (self as any).postMessage({id, value}, transfer),
      error => (self as any).postMessage({
        id,
        error: (error instanceof Error) ? error.message : error.toString()
      }));
};

export function registerAsyncComputation<Signature extends(...args: any) => any>(
    request: AsyncComputationSpec<Signature>,
    handler: (...args: Parameters<Signature>) =>
        Promise<{value: ReturnType<Signature>, transfer?: Transferable[]}>) {
  handlers.set(request.id, handler);
}
