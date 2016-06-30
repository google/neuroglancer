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
 * @file Minimal support for integrating cancellation notification with Promises.
 *
 * For Promises that support cancellation, cancelling a pending Promise has the effect of
 * synchronously invoking a cancellation callback function, if one has been set, and rejecting the
 * promise with the error value CANCELLED.  Cancelling a resolved/rejected Promise, or a regular
 * Promise that does not support cancellation (as indicated by the presence of a cancel method) has
 * no effect.
 */

export interface CancellablePromise<T> extends Promise<T> { cancel?: () => void; }

export class CancellationError {
  toString() { return 'CancellationError'; }
};

/**
 * Value thrown to indicate cancellation.
 */
export const CANCELLED = new CancellationError();

/**
 * Create a new promise capable of receiving notification of cancellation.
 *
 * This extends the interface of the Promise consructor with an additional onCancel argument passed
 * to the executor function.  It is used for specifying a callback function to be invoked when
 * cancelPromise is called.
 *
 * onCancel may be invoked to set the cancellation callback any number of times, either
 * synchronously from within the executor or asynchronously.
 *
 * The effect of invoking onCancel depends on whether the promise is pending (i.e. not yet resolved,
 * rejected, or cancelled):
 *
 * - If at the time onCancel is invoked the promise is still pending, the stored cancellation
 *   callback is replaced with the supplied callback.  The supplied callback may be undefined to
 *   specify that no callback should be invoked.
 *
 * - If at the time onCancel is invoked the promise is not still pending, the supplied callback, if
 *   not undefined, is invoked synchronously.
 *
 * WARNING: Because they may be invoked either synchronously or asynchronously, great care must be
 * taken in writing callbacks to be supplied to onCancel,
 */
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
        cancelHandler = undefined;
        // This can't throw.
        resolve(value);
      }
    }

    function rejecter(value: any) {
      if (!finished) {
        finished = true;
        cancelHandler = undefined;
        // This can't throw.
        reject(value);
      }
    }

    function setCancelHandler(newCancelHandler: (() => void)|undefined) {
      if (finished) {
        try {
          if (newCancelHandler !== undefined) {
            newCancelHandler();
          }
        } catch (ignoredError) {
        }
      } else {
        cancelHandler = newCancelHandler;
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

/**
 * Try to cancel a promise.
 *
 * If the promise has a cancel method, invoke it synchronously.  For promises created by
 * makeCancellablePromise, this has the effect of synchronously invoking the most recently set
 * cancellation callback, if defined, and rejecting the promise with the error value CANCELLED.
 *
 * If the promise has no cancel method, or is null or undefined, do nothing.
 */
export function cancelPromise<T>(promise: CancellablePromise<T>| null | undefined) {
  if (promise != null) {
    let {cancel} = promise;
    if (cancel !== undefined) {
      cancel.call(promise);
    }
  }
}

/**
 * Schedule a call to handler when promise is either fulfilled or rejected.  If the handler throws
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
 * Schedule a call to onFulfilled as soon as the promise is fulfilled.
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
