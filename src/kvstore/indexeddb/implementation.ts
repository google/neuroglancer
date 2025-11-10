/**
 * @license
 * Copyright 2025
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

import type { DriverReadOptions, KvStore, ListResponse, ReadResponse, StatOptions, StatResponse } from "#src/kvstore/index.js";

function promisifyRequest<T = unknown>(req: IDBRequest, context: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(new Error(`${context}: ${String(req.error?.message ?? req.error)}`, { cause: req.error ?? undefined }));
  });
}

function awaitTransactionCompletion(tx: IDBTransaction, context: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new Error(`${context}: transaction aborted`, { cause: tx.error ?? undefined }));
    tx.onerror = () => reject(new Error(`${context}: transaction error`, { cause: tx.error ?? undefined }));
  });
}

export class IndexedDBKvStore implements KvStore {
  constructor(private readonly databaseName: string, private readonly storeName: string) {}

  private dbPromise: Promise<IDBDatabase> | undefined;

  private getDb(): Promise<IDBDatabase> {
    if (this.dbPromise !== undefined) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onerror = () => reject(new Error(`Failed to open IndexedDB database ${this.databaseName}`, { cause: request.error ?? undefined }));
      request.onsuccess = () => resolve(request.result);
    });
    return this.dbPromise;
  }

  async stat(key: string, _options: StatOptions): Promise<StatResponse | undefined> {
    const db = await this.getDb();
    const tx = db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const getReq = store.get(key);
    const value = await promisifyRequest<unknown>(getReq, `stat: get(${key})`);
    await awaitTransactionCompletion(tx, `stat(${key})`);
    if (value === undefined) return undefined;
    if (!(value instanceof ArrayBuffer)) {
      throw new Error(`stat(${key}): expected ArrayBuffer, got ${Object.prototype.toString.call(value)}`);
    }
    return { totalSize: value.byteLength };
  }

  async read(key: string, _options: DriverReadOptions): Promise<ReadResponse | undefined> {
    const db = await this.getDb();
    const tx = db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);
    const getReq = store.get(key);
    const value = await promisifyRequest<ArrayBuffer | undefined>(getReq, `read: get(${key})`);
    await awaitTransactionCompletion(tx, `read(${key})`);
    if (value === undefined) return undefined;
    const response = new Response(value);
    return { response, offset: 0, length: value.byteLength, totalSize: value.byteLength };
  }

  async write(key: string, value: ArrayBuffer): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const req = store.put(value, key);
    await promisifyRequest(req, `write: put(${key})`);
    await awaitTransactionCompletion(tx, `write(${key})`);
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(this.storeName, "readwrite");
    const store = tx.objectStore(this.storeName);
    const req = store.delete(key);
    await promisifyRequest(req, `delete: delete(${key})`);
    await awaitTransactionCompletion(tx, `delete(${key})`);
  }

  async list(prefix: string): Promise<ListResponse> {
    const db = await this.getDb();
    const tx = db.transaction(this.storeName, "readonly");
    const store = tx.objectStore(this.storeName);

    const upperBound = `${prefix}\uffff`;
    const range = IDBKeyRange.bound(prefix, upperBound);

    const directories = new Set<string>();
    const entries: Array<{ key: string }> = [];

    await new Promise<void>((resolve, reject) => {
      // IDB spec: openKeyCursor may not exist in older impls; fallback to openCursor reading keys only.
      const cursorRequest = (store as any).openKeyCursor
        ? (store as any).openKeyCursor(range)
        : store.openCursor(range);
      cursorRequest.onerror = () => reject(new Error(`list: cursor error for prefix ${prefix}`, { cause: cursorRequest.error ?? undefined }));
      cursorRequest.onsuccess = () => {
        const cursor: IDBCursor | null = cursorRequest.result as IDBCursor | null;
        if (cursor === null) {
          resolve();
          return;
        }
        const key = String(cursor.key);
        if (!key.startsWith(prefix)) {
          cursor.continue();
          return;
        }
        const remainder = key.substring(prefix.length);
        const slashIndex = remainder.indexOf("/");
        if (slashIndex === -1) {
          entries.push({ key });
        } else {
          const dirName = prefix + remainder.substring(0, slashIndex);
          directories.add(dirName);
        }
        cursor.continue();
      };
    });

    await awaitTransactionCompletion(tx, `list(${prefix})`);

    const sortedEntries = entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const sortedDirectories = Array.from(directories).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    return { entries: sortedEntries, directories: sortedDirectories };
  }

  getUrl(key: string): string {
    return `local://${encodeURIComponent(this.databaseName)}/${encodeURIComponent(this.storeName)}/${encodeURIComponent(key)}`;
  }

  get supportsOffsetReads(): boolean { return false; }
  get supportsSuffixReads(): boolean { return false; }
}
