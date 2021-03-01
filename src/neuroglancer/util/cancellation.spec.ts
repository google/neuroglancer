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

import {CANCELED, CancellationTokenSource, makeCancelablePromise, MultipleConsumerCancellationTokenSource, throwIfCanceled, uncancelableToken} from 'neuroglancer/util/cancellation';

describe('cancellation', () => {
  describe('CancellationTokenSource', () => {
    it('supports cancel', () => {
      const source = new CancellationTokenSource();
      expect(source.isCanceled).toBe(false);
      source.cancel();
      expect(source.isCanceled).toBe(true);
      source.cancel();
      expect(source.isCanceled).toBe(true);
    });

    it('supports add', () => {
      const source = new CancellationTokenSource();
      let log: number[] = [];
      const handler = () => {
        log.push(1);
      };
      source.add(handler);
      source.cancel();
      expect(log).toEqual([1]);
      source.cancel();
      expect(log).toEqual([1]);
    });

    it('supports add after cancel', () => {
      const source = new CancellationTokenSource();
      source.cancel();
      let log: number[] = [];
      const handler = () => {
        log.push(1);
      };
      source.add(handler);
      expect(log).toEqual([1]);
    });

    it('supports remove', () => {
      const source = new CancellationTokenSource();
      let log: number[] = [];
      const handler = () => {
        log.push(1);
      };
      source.add(handler);
      source.remove(handler);
      source.cancel();
      expect(log).toEqual([]);
    });

    it('supports throwIfCanceled', () => {
      const source = new CancellationTokenSource();
      expect(() => throwIfCanceled(source)).not.toThrow();
      source.cancel();
      expect(() => throwIfCanceled(source)).toThrow(CANCELED);
    });
  });

  describe('uncancelableToken', () => {
    it('supports isCanceled', () => {
      expect(uncancelableToken.isCanceled).toBe(false);
    });

    it('supports add', () => {
      uncancelableToken.add(() => {});
    });

    it('supports remove', () => {
      const handler = () => {};
      uncancelableToken.add(handler);
      uncancelableToken.remove(handler);
    });
  });

  describe('MultipleConsumerCancellationTokenSource', () => {
    it('supports cancellation from two consumers', () => {
      const multiToken = new MultipleConsumerCancellationTokenSource();
      const token1 = new CancellationTokenSource();
      multiToken.addConsumer(token1);
      const token2 = new CancellationTokenSource();
      multiToken.addConsumer(token2);
      token1.cancel();
      expect(multiToken.isCanceled).toBe(false);
      token2.cancel();
      expect(multiToken.isCanceled).toBe(true);
    });

    it('supports cancellation from three consumers', () => {
      const multiToken = new MultipleConsumerCancellationTokenSource();
      const token1 = new CancellationTokenSource();
      multiToken.addConsumer(token1);
      const token2 = new CancellationTokenSource();
      multiToken.addConsumer(token2);
      token1.cancel();
      expect(multiToken.isCanceled).toBe(false);
      const token3 = new CancellationTokenSource();
      multiToken.addConsumer(token3);
      token2.cancel();
      expect(multiToken.isCanceled).toBe(false);
      token3.cancel();
      expect(multiToken.isCanceled).toBe(true);
    });
  });

  describe('makeCancellablePromise', () => {
    it('supports basic resolve behavior', done => {
      const promise =
          makeCancelablePromise<number>(uncancelableToken, (resolve, _reject, _token) => {
            resolve(3);
          });
      promise.then(value => {
        expect(value).toBe(3);
        done();
      });
    });
    it('supports basic reject behavior', done => {
      const promise =
          makeCancelablePromise<number>(uncancelableToken, (_resolve, reject, _token) => {
            reject(3);
          });
      promise.catch(value => {
        expect(value).toBe(3);
        done();
      });
    });

    it('unregisters the cancellation handler when the promise is fulfilled', () => {
      const source = new CancellationTokenSource();
      const log: string[] = [];
      makeCancelablePromise<number>(source, (resolve, _reject, token) => {
        token.add(() => {
          log.push('cancel called');
        });
        resolve(1);
        source.cancel();
        expect(log).toEqual([]);
      });
    });

    it('unregisters the cancellation handler when the promise is rejected', () => {
      const source = new CancellationTokenSource();
      const log: string[] = [];
      makeCancelablePromise<number>(source, (_resolve, reject, token) => {
        token.add(() => {
          log.push('cancel called');
        });
        reject(1);
        source.cancel();
        expect(log).toEqual([]);
      }).catch(() => null);
    });

  });
});
