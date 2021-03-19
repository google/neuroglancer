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

import {NullarySignal, Signal} from 'neuroglancer/util/signal';

describe('signal', () => {
  it('should invoke the handler when dispatched', () => {
    const signal = new Signal();
    const results: any[][] = [];
    signal.add(function(this: any) {
      results.push([this, ...arguments]);
    });
    expect(signal.count).toEqual(0);
    signal.dispatch.call(undefined, 1, 2, 3);
    expect(signal.count).toEqual(1);
    expect(results).toEqual([[undefined, 1, 2, 3]]);
    const a = {a: 1};
    signal.dispatch.call(a);
    expect(signal.count).toEqual(2);
    expect(results).toEqual([[undefined, 1, 2, 3], [a]]);
  });

  it('should invoke handlers in the order they are added', () => {
    const signal = new Signal();
    let result = '';
    signal.add(() => {
      result += 'a';
    });
    signal.dispatch();
    expect(result).toEqual('a');
    signal.add(() => {
      result += 'b';
    });
    signal.dispatch();
    expect(result).toEqual('aab');
  });

  it('should not invoke handlers after they are removed', () => {
    const signal = new Signal();
    let result = '';
    const handler1 = () => {
      result += 'a';
    };
    const handler2 = () => {
      result += 'b';
    };
    signal.add(handler1);
    signal.add(handler2);
    signal.dispatch();
    expect(result).toEqual('ab');
    expect(signal.remove(handler1)).toEqual(true);
    signal.dispatch();
    expect(result).toEqual('abb');
    expect(signal.remove(handler2)).toEqual(true);
    signal.dispatch();
    expect(result).toEqual('abb');
    expect(signal.count).toEqual(3);
  });

  it('should invoke handlers added by another handler', () => {
    const signal = new Signal();
    let result = '';
    const handler2 = () => {
      result += 'b';
    };
    const handler1 = () => {
      result += 'a';
      signal.add(handler2);
    };
    signal.add(handler1);
    signal.dispatch();
    expect(result).toEqual('ab');
  });

  it('should not invoke handlers removed by a prior handler', () => {
    const signal = new Signal();
    let result = '';
    const handler2 = () => {
      result += 'b';
    };
    const handler1 = () => {
      result += 'a';
      signal.remove(handler2);
    };
    signal.add(handler1);
    signal.add(handler2);
    signal.dispatch();
    expect(result).toEqual('a');
  });

  it('add should return removal function', () => {
    const signal = new Signal();
    let result = '';
    const removalFunction = signal.add(() => {
      result += 'a';
    });
    signal.dispatch();
    expect(result).toEqual('a');
    expect(removalFunction()).toEqual(true);
    signal.dispatch();
    expect(result).toEqual('a');
    expect(removalFunction()).toEqual(false);
  });

  it('NullarySignal works', () => {
    const signal = new NullarySignal();
    let result = '';
    signal.add(() => {
      result += 'a';
    });
    signal.dispatch();
    expect(result).toEqual('a');
  });
});
