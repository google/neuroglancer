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
import {CANCELED, CancellationToken} from 'neuroglancer/util/cancellation';
import {WORKER_RPC_ID} from 'neuroglancer/worker_rpc';
import {rpc} from 'neuroglancer/worker_rpc_context';

const freeWorkers: (Worker|MessagePort)[] = [];
const pendingTasks = new Map<number, {msg: any, transfer: Transferable[] | undefined}>();
const tasks = new Map<
    number, {resolve: (value: any) => void, reject: (error: any) => void, cleanup: () => void}>();
// On Safari, `navigator.hardwareConcurrency` is not defined.
const maxWorkers = typeof navigator.hardwareConcurrency === 'undefined' ?
    4 :
    Math.min(12, navigator.hardwareConcurrency);
let nextTaskId = 0;

function returnWorker(worker: Worker|MessagePort) {
  for (const [id, task] of pendingTasks) {
    pendingTasks.delete(id);
    worker.postMessage(task.msg, task.transfer as Transferable[]);
    return;
  }
  freeWorkers.push(worker);
}

function getNewWorker(): Worker|MessagePort {
  let port: Worker|MessagePort;
  if (typeof Worker === 'undefined') {
    // On Safari, the `Worker` constructor is not available from workers.  Instead, we request the
    // main thread to create a worker.
    const channel = new MessageChannel();
    port = channel.port2;
    rpc.invoke(
        WORKER_RPC_ID, {port: channel.port1, path: 'async_computation.bundle.js'}, [channel.port1]);
  } else {
    port = new Worker('async_computation.bundle.js');
  }
  port.onmessage = msg => {
    const {id, value, error} = msg.data as {id: number, value?: any, error?: string};
    returnWorker(port);
    const callbacks = tasks.get(id)!;
    tasks.delete(id);
    if (callbacks === undefined) return;
    callbacks.cleanup();
    if (error !== undefined) {
      callbacks.reject(new Error(error));
    } else {
      callbacks.resolve(value);
    }
  };
  return port;
}

export function requestAsyncComputation<Signature extends(...args: any) => any>(
    request: AsyncComputationSpec<Signature>, cancellationToken: CancellationToken,
    transfer: Transferable[]|undefined,
    ...args: Parameters<Signature>): Promise<ReturnType<Signature>> {
  if (cancellationToken.isCanceled) return Promise.reject(CANCELED);
  const id = nextTaskId++;
  const msg = {t: request.id, id, args: args};
  const cleanup = cancellationToken.add(() => {
    pendingTasks.delete(id);
    tasks.delete(id);
  });
  const promise = new Promise<ReturnType<Signature>>((resolve, reject) => {
    tasks.set(id, {resolve, reject, cleanup});
  });
  if (freeWorkers.length !== 0) {
    freeWorkers.pop()!.postMessage(msg, transfer as Transferable[]);
  } else if (tasks.size < maxWorkers) {
    getNewWorker().postMessage(msg, transfer as Transferable[]);
  } else {
    pendingTasks.set(id, {msg, transfer});
  }
  return promise;
}
