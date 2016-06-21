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

export interface CancellablePromise<T> extends Promise<T> {
  // Prevents any chained actions from being called.
  // Any finally handlers are scheduled to be run.
  cancel?: () => void;

  finally?: <TResult>(handler: () => TResult | PromiseLike<TResult>) => Promise<T>;
}

export class CancellationError {
  toString() { return 'CancellationError'; }
};

/**
 * Value thrown to indicate cancellation.
 */
export const CANCELLED = new CancellationError();

export function makeCancellablePromise<T>(
    executor: (
        resolve: (value: T | PromiseLike<T>) => void, reject: (reason: any) => void,
        onCancel: (callback: (() => void) | undefined) => void) => void) {
  let finished = false;
  let cancelHandler: (() => void)|undefined;
  let cancelFunction: (() => void)|undefined;
  let promise: CancellablePromise<T> = new Promise<T>((resolve, reject) => {
    function resolver(value: T) {
      if (!finished) {
        finished = true;
        // This can't throw.
        resolve(value);
      }
    }

    function rejecter(value: any) {
      if (!finished) {
        finished = true;
        // This can't throw.
        reject(value);
      }
    }

    function setCancelHandler(newCancelHandler: () => void) {
      if (finished) {
        try {
          newCancelHandler();
        } catch (ignoredError) {
        }
      }
    }
    try {
      executor(resolver, rejecter, setCancelHandler);
    } catch (executorError) {
      rejecter(executorError);
    }
    cancelFunction = () => {
      if (!finished) {
        finished = true;
        if (cancelHandler !== undefined) {
          try {
            cancelHandler();
          } catch (ignoredError) {
          }
          cancelHandler = undefined;
        }
        reject(CANCELLED);
      }
    };
  });
  promise.cancel = cancelFunction!;
  return promise;
}

export function cancelPromise<T>(promise: CancellablePromise<T>| null | undefined) {
  if (promise != null) {
    let {cancel} = promise;
    if (cancel !== undefined) {
      cancel.call(promise);
    }
  }
}

/**
 * Schedules a call to handler when promise is either fulfilled or rejected.  If the handler throws
 * an error, the returned promise is rejected with it.  Otherwise, the returned promise has the same
 * state as the original promise.
 *
 * If the returned promise is cancelled before the inputPromise is finished, the inputPromise is
 * cancelled.
 */
export function callFinally<T>(
    inputPromise: CancellablePromise<T>,
    handler: (onCancel: (newCancelHandler: (() => void) | undefined) => void) =>
        void|PromiseLike<void>) {
  return makeCancellablePromise<T>((resolve, reject, onCancel) => {
    onCancel(() => { cancelPromise(inputPromise); });
    inputPromise.then(
        value => {
          onCancel(undefined);
          Promise.resolve(handler(onCancel)).then(() => { resolve(value); });
        },
        reason => {
          onCancel(undefined);
          try {
            Promise.resolve(handler(onCancel)).then(() => { reject(reason); }, reject);
          } catch (otherError) {
            reject(otherError);
          }
        });
  });
}

/**
 * Schedules a call to onFulfilled as soon as the promise is fulfilled.
 *
 * A cancellation handler may be set, which is called if the returned promise is cancelled afer
 * inputPromise is fulfilled.  If the returned promise is cancelled before inputPromise is
 * fulfilled, inputPromise is cancelled if it supports it.
 */
export function cancellableThen<T, TResult>(
    inputPromise: CancellablePromise<T>,
    onFulfilled: (value: T, onCancel: (newCancelHandler: () => void) => void) =>
        TResult | PromiseLike<TResult>): CancellablePromise<TResult> {
  return makeCancellablePromise<TResult>((resolve, reject, onCancel) => {
    let cancelled = false;
    onCancel(() => {
      cancelled = true;
      cancelPromise(inputPromise);
    });
    inputPromise.then(value => {
      if (cancelled) {
        reject(CANCELLED);
      } else {
        onCancel(undefined);
        resolve(onFulfilled(value, onCancel));
      }
    });
  });
}
