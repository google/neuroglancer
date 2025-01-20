/**
 * @license
 * Copyright 2024 Google Inc.
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

export type ProgressSpanId = number;

export interface ProgressSpanOptions {
  message: string;
  startTime?: number;
  id?: ProgressSpanId;
}

export class ProgressSpan implements Disposable {
  id: ProgressSpanId;
  startTime: number;
  message: string;

  constructor(
    public listener: ProgressListener,
    options: ProgressSpanOptions,
  ) {
    const { id = Math.random(), startTime = Date.now(), message } = options;
    this.id = id;
    this.startTime = startTime;
    this.message = message;
    listener.addSpan(this);
  }

  [Symbol.dispose]() {
    this.listener.removeSpan(this.id);
  }
}

export interface ProgressListener {
  addSpan(span: ProgressSpan): void;
  removeSpan(spanId: ProgressSpanId): void;
}

export class MultiSet<T> {
  private items = new Map<T, number>();
  add(item: T): number {
    const { items } = this;
    const count = (items.get(item) ?? 0) + 1;
    items.set(item, count);
    return count;
  }

  delete(item: T): number {
    const { items } = this;
    let count = items.get(item)!;
    if (count > 1) {
      count -= 1;
      items.set(item, count);
      return count;
    }
    items.delete(item);
    return 0;
  }

  has(item: T): boolean {
    return this.items.has(item);
  }

  keys() {
    return this.items.keys();
  }

  entries() {
    return this.items.entries();
  }

  [Symbol.iterator]() {
    return this.items.keys();
  }
}

export class KeyedMultiSet<T, Key> {
  private items = new Map<Key, { value: T; count: number }>();
  constructor(private getKey: (value: T) => Key) {}

  add(item: T): number {
    const { items } = this;
    const key = this.getKey(item);
    const obj = items.get(key);
    if (obj === undefined) {
      items.set(key, { value: item, count: 1 });
      return 1;
    } else {
      return (obj.count += 1);
    }
  }

  delete(item: T): number {
    return this.deleteKey(this.getKey(item));
  }

  deleteKey(key: Key): number {
    const { items } = this;
    const obj = items.get(key);
    if (obj !== undefined && obj.count > 1) {
      return (obj.count -= 1);
    }
    items.delete(key);
    return 0;
  }

  has(item: T): boolean {
    return this.items.has(this.getKey(item));
  }

  *[Symbol.iterator]() {
    for (const obj of this.items.values()) {
      yield obj.value;
    }
  }
}

function getId(span: ProgressSpan) {
  return span.id;
}

export class ProgressSpanSet extends KeyedMultiSet<ProgressSpan, number> {
  constructor() {
    super(getId);
  }
}

export class MultiConsumerProgressListener implements ProgressListener {
  private spans = new ProgressSpanSet();
  private listeners = new MultiSet<ProgressListener>();
  addSpan(span: ProgressSpan) {
    if (this.spans.add(span) !== 1) return;
    for (const listener of this.listeners) {
      listener.addSpan(span);
    }
  }

  removeSpan(spanId: ProgressSpanId) {
    if (this.spans.deleteKey(spanId) !== 0) return;
    for (const listener of this.listeners) {
      listener.removeSpan(spanId);
    }
  }

  addListener(listener: ProgressListener | undefined) {
    if (listener === undefined) return;
    if (this.listeners.add(listener) !== 1) return;
    for (const span of this.spans) {
      listener.addSpan(span);
    }
  }

  removeListener(listener: ProgressListener | undefined) {
    if (listener === undefined) return;
    if (this.listeners.delete(listener) !== 0) return;
    for (const span of this.spans) {
      listener.removeSpan(span.id);
    }
  }
}

export interface ProgressOptions {
  signal: AbortSignal;
  progressListener: ProgressListener;
}
