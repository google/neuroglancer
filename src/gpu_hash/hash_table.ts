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

import { hashCombine } from "#src/gpu_hash/hash_function.js";
import { randomUint64 } from "#src/util/bigint.js";
import { getRandomValues } from "#src/util/random.js";

export const NUM_ALTERNATIVES = 3;

// For 3 hash functions, a DEFAULT_LOAD_FACTOR of 0.8 reliably avoids
// expensive rehashing caused by unresolvable collisions.
const DEFAULT_LOAD_FACTOR = 0.8;

const DEBUG = false;

// Key that needs to be inserted.  Temporary variables used during insert.  These can safely be
// global because control never leaves functions defined in this module while these are in use.
let pending = 0n;
let backupPending = 0n;

export abstract class HashTableBase {
  loadFactor = DEFAULT_LOAD_FACTOR;
  size = 0;
  table: BigUint64Array;
  tableSize: number;
  empty = 0xffffffffffffffffn;
  maxRehashAttempts = 5;
  maxAttempts = 5;
  capacity: number;

  /**
   * Number of uint64 elements per entry in hash table.
   */
  declare entryStride: number;

  generation = 0;

  mungedEmptyKey: bigint | undefined;

  constructor(
    public hashSeeds = HashTableBase.generateHashSeeds(NUM_ALTERNATIVES),
  ) {
    // Minimum size must be greater than 2 * hashSeeds.length.  Otherwise, tableWithMungedEmptyKey
    // may loop infinitely.
    let initialSize = 8;
    while (initialSize < 2 * hashSeeds.length) {
      initialSize *= 2;
    }
    this.allocate(initialSize);
  }

  private updateHashFunctions(numHashes: number) {
    this.hashSeeds = HashTableBase.generateHashSeeds(numHashes);
    this.mungedEmptyKey = undefined;
  }

  /**
   * Invokes callback with a modified version of the hash table data array.
   *
   * Replaces all slots that appear to be valid entries for `empty`, i.e. slots that
   * contain `empty` and to which `empty` hashes, with `mungedEmptyKey`.
   *
   * mungedEmptyKey is chosen such that it does not to any of the same slots as `empty`.
   *
   * This allows the modified data array to be used for lookups without special casing the empty
   * key.
   */
  tableWithMungedEmptyKey(callback: (table: BigUint64Array) => void) {
    const numHashes = this.hashSeeds.length;
    const emptySlots = new Array<number>(numHashes);
    for (let i = 0; i < numHashes; ++i) {
      emptySlots[i] = this.getHash(i, this.empty);
    }
    let { mungedEmptyKey } = this;
    if (mungedEmptyKey === undefined) {
      chooseMungedEmptyKey: while (true) {
        mungedEmptyKey = randomUint64();
        for (let i = 0; i < numHashes; ++i) {
          const h = this.getHash(i, mungedEmptyKey);
          for (let j = 0; j < numHashes; ++j) {
            if (emptySlots[j] === h) {
              continue chooseMungedEmptyKey;
            }
          }
        }
        this.mungedEmptyKey = mungedEmptyKey;
        break;
      }
    }
    const { table, empty } = this;
    for (let i = 0; i < numHashes; ++i) {
      const h = emptySlots[i];
      if (table[h] === empty) {
        table[h] = mungedEmptyKey;
      }
    }
    try {
      callback(table);
    } finally {
      for (let i = 0; i < numHashes; ++i) {
        const h = emptySlots[i];
        if (table[h] === mungedEmptyKey) {
          table[h] = empty;
        }
      }
    }
  }

  static generateHashSeeds(numAlternatives = NUM_ALTERNATIVES) {
    return getRandomValues(new Uint32Array(numAlternatives));
  }

  getHash(hashIndex: number, x: bigint) {
    let hash = this.hashSeeds[hashIndex];
    hash = hashCombine(hash, Number(x & 0xffffffffn));
    hash = hashCombine(hash, Number(x >> 32n));
    return this.entryStride * (hash & (this.tableSize - 1));
  }

  /**
   * Iterates over the uint64 keys contained in the hash set.
   */
  *keys(): IterableIterator<bigint> {
    const { empty, entryStride } = this;
    const { table } = this;
    for (let i = 0, length = table.length; i < length; i += entryStride) {
      const key = table[i];
      if (key !== empty) {
        yield key;
      }
    }
  }

  /**
   * Returns the offset into the hash table of the specified element, or -1 if the element is not
   * present.
   */
  indexOf(x: bigint) {
    const { table, empty } = this;
    if (x === empty) {
      return -1;
    }
    for (let i = 0, numHashes = this.hashSeeds.length; i < numHashes; ++i) {
      const h = this.getHash(i, x);
      if (table[h] === x) {
        return h;
      }
    }
    return -1;
  }

  /**
   * Changes the empty key to a value that is not equal to the current empty key and is not present
   * in the table.
   *
   * This is called when an attempt is made to insert the empty key.
   */
  private chooseAnotherEmptyKey() {
    const { empty, table, entryStride } = this;
    let newKey: bigint;
    while (true) {
      newKey = randomUint64();
      if (newKey === empty) {
        continue;
      }
      if (this.has(newKey)) {
        continue;
      }
      break;
    }

    this.empty = newKey;

    // Replace empty keys in the table.
    for (let h = 0, length = table.length; h < length; h += entryStride) {
      if (table[h] === empty) {
        table[h] = newKey;
      }
    }
  }

  /**
   * Returns true iff the specified element is present.
   */
  has(x: bigint) {
    return this.indexOf(x) !== -1;
  }

  delete(x: bigint) {
    const index = this.indexOf(x);
    if (index !== -1) {
      const { table } = this;
      table[index] = this.empty;
      ++this.generation;
      this.size--;
      return true;
    }
    return false;
  }

  private clearTable() {
    const { table, empty } = this;
    table.fill(empty);
  }

  clear() {
    if (this.size === 0) {
      return false;
    }
    this.size = 0;
    ++this.generation;
    this.clearTable();
    return true;
  }

  reserve(x: number) {
    if (x > this.capacity) {
      this.backupPending();
      this.grow(x);
      this.restorePending();
      return true;
    }
    return false;
  }

  protected swapPending(table: BigUint64Array, offset: number) {
    const temp = pending;
    this.storePending(table, offset);
    table[offset] = temp;
  }

  protected storePending(table: BigUint64Array, offset: number) {
    pending = table[offset];
  }

  protected backupPending() {
    backupPending = pending;
  }

  protected restorePending() {
    pending = backupPending;
  }

  private tryToInsert() {
    if (DEBUG) {
      console.log(`tryToInsert: ${pending}`);
    }
    let attempt = 0;
    const { empty, maxAttempts, table } = this;
    const numHashes = this.hashSeeds.length;

    let tableIndex = Math.floor(Math.random() * numHashes);
    while (true) {
      const h = this.getHash(tableIndex, pending);
      this.swapPending(table, h);
      if (pending === empty) {
        return true;
      }
      if (++attempt === maxAttempts) {
        break;
      }
      tableIndex =
        (tableIndex + Math.floor(Math.random() * (numHashes - 1)) + 1) %
        numHashes;
    }
    return false;
  }

  private allocate(tableSize: number) {
    this.tableSize = tableSize;
    const { entryStride } = this;
    this.table = new BigUint64Array(tableSize * entryStride);
    this.maxAttempts = tableSize;
    this.clearTable();
    this.capacity = tableSize * this.loadFactor;
    this.mungedEmptyKey = undefined;
  }

  private rehash(oldTable: BigUint64Array, tableSize: number) {
    if (DEBUG) {
      console.log("rehash begin");
    }
    this.allocate(tableSize);
    this.updateHashFunctions(this.hashSeeds.length);
    const { empty, entryStride } = this;
    for (let h = 0, length = oldTable.length; h < length; h += entryStride) {
      const key = oldTable[h];
      if (key !== empty) {
        this.storePending(oldTable, h);
        if (!this.tryToInsert()) {
          if (DEBUG) {
            console.log("rehash failed");
          }
          return false;
        }
      }
    }
    if (DEBUG) {
      console.log("rehash end");
    }
    return true;
  }

  private grow(desiredTableSize: number) {
    if (DEBUG) {
      console.log(`grow: ${desiredTableSize}`);
    }
    const oldTable = this.table;
    let { tableSize } = this;
    while (tableSize < desiredTableSize) {
      tableSize *= 2;
    }
    while (true) {
      for (
        let rehashAttempt = 0;
        rehashAttempt < this.maxRehashAttempts;
        ++rehashAttempt
      ) {
        if (this.rehash(oldTable, tableSize)) {
          if (DEBUG) {
            console.log("grow end");
          }
          return;
        }
      }
      tableSize *= 2;
    }
  }

  protected insertInternal() {
    ++this.generation;

    if (pending === this.empty) {
      this.chooseAnotherEmptyKey();
    }

    if (++this.size > this.capacity) {
      this.backupPending();
      this.grow(this.tableSize * 2);
      this.restorePending();
    }

    while (!this.tryToInsert()) {
      this.backupPending();
      this.grow(this.tableSize);
      this.restorePending();
    }
  }
}

export class HashSetUint64 extends HashTableBase {
  add(x: bigint) {
    if (this.has(x)) {
      return false;
    }
    if (DEBUG) {
      console.log(`add: ${x}`);
    }
    pending = x;
    this.insertInternal();
    return true;
  }

  /**
   * Iterates over the keys.
   */
  [Symbol.iterator]() {
    return this.keys();
  }
}
HashSetUint64.prototype.entryStride = 1;

// Value that needs to be inserted.  Temporary variables used during insert.  These can safely be
// global because control never leaves functions defined in this module while these are in use.
let pendingValue = 0n;
let backupPendingValue = 0n;

export class HashMapUint64 extends HashTableBase {
  set(key: bigint, value: bigint) {
    if (this.has(key)) {
      return false;
    }
    if (DEBUG) {
      console.log(`add: ${key} -> ${value}`);
    }
    pending = key;
    pendingValue = value;
    this.insertInternal();
    return true;
  }

  get(key: bigint): bigint | undefined {
    const h = this.indexOf(key);
    if (h === -1) {
      return undefined;
    }
    return this.table[h + 1];
  }

  protected swapPending(table: BigUint64Array, offset: number) {
    const temp = pendingValue;
    super.swapPending(table, offset);
    table[offset + 1] = temp;
  }

  protected storePending(table: BigUint64Array, offset: number) {
    super.storePending(table, offset);
    pendingValue = table[offset + 1];
  }

  protected backupPending() {
    super.backupPending();
    backupPendingValue = pendingValue;
  }

  protected restorePending() {
    super.restorePending();
    pendingValue = backupPendingValue;
  }

  /**
   * Iterates over entries.
   */
  [Symbol.iterator]() {
    return this.entries();
  }

  /**
   * Iterates over entries.
   */
  *entries() {
    const { empty, entryStride } = this;
    const { table } = this;
    for (let i = 0, length = table.length; i < length; i += entryStride) {
      const key = table[i];
      if (key !== empty) {
        const value = table[i + 1];
        yield [key, value];
      }
    }
  }
}
HashMapUint64.prototype.entryStride = 2;
