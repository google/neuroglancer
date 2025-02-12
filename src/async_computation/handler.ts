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

import type { AsyncComputationSpec } from "#src/async_computation/index.js";

const handlers = new Map<
  string,
  (...args: any[]) => Promise<{ value: any; transfer?: Transferable[] }>
>();

function setupChannel(port: DedicatedWorkerGlobalScope) {
  self.onmessage = async (msg: any) => {
    const { t, id, args } = msg.data as { t: string; id: number; args: any[] };
    try {
      const handler = handlers.get(t)!;
      if (handler === undefined) {
        throw new Error(
          `Internal error: async computation operation ${JSON.stringify(t)} is not registered.  Registered handlers: ${JSON.stringify(Array.from(handlers.keys()))}`,
        );
      }
      const { value, transfer } = await handler(...args);
      port.postMessage({ id, value }, { transfer });
    } catch (error) {
      port.postMessage({
        id,
        error,
      });
    }
  };
  // Notify that the worker is ready to receive messages.
  self.postMessage(null);
}

setupChannel(self as DedicatedWorkerGlobalScope);

export function registerAsyncComputation<
  Signature extends (...args: any) => any,
>(
  request: AsyncComputationSpec<Signature>,
  handler: (
    ...args: Parameters<Signature>
  ) => Promise<{ value: ReturnType<Signature>; transfer?: Transferable[] }>,
) {
  handlers.set(request.id, handler);
}
