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

import {hashCombine} from 'neuroglancer/gpu_hash/hash_function';
import {getRandomValues} from 'neuroglancer/util/random';
import {Uint64} from 'neuroglancer/util/uint64';

export const NUM_ALTERNATIVES = 3;

// For 3 hash functions, a DEFAULT_LOAD_FACTOR of 0.8 reliably avoids
// expensive rehashing caused by unresolvable collisions.
const DEFAULT_LOAD_FACTOR = 0.8;

const DEBUG = false;

// Key that needs to be inserted.  Temporary variables used during insert.  These can safely be
// global because control never leaves functions defined in this module while these are in use.
let pendingLow = 0, pendingHigh = 0, backupPendingLow = 0, backupPendingHigh = 0;

export abstract class HashTableBase {
  loadFactor = DEFAULT_LOAD_FACTOR;
  size = 0;
  table: Uint32Array;
  tableSize: number;
  emptyLow = 4294967295;
  emptyHigh = 4294967295;
  maxRehashAttempts = 5;
  maxAttempts = 5;
  capacity: number;

  /**
   * Number of uint32 elements per entry in hash table.
   */
  entryStride: number;

  generation = 0;

  mungedEmptyKey = -1;

  constructor(public hashSeeds = HashTableBase.generateHashSeeds(NUM_ALTERNATIVES)) {
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
    this.mungedEmptyKey = -1;
  }

  /**
   * Invokes callback with a modified version of the hash table data array.
   *
   * Replaces all slots that appear to be valid entries for (emptyLow, emptyHigh), i.e. slots that
   * contain (emptyLow, emptyHigh) and to which (emptyLow, emptyHigh) hashes, with (mungedEmptyKey,
   * mungedEmptyKey).
   *
   * mungedEmptyKey is chosen to be a 32-bit value with the property that the 64-bit value
   * (mungedEmptyKey, mungedEmptyKey) does not hash to any of the same slots as (emptyLow,
   * emptyHigh).
   *
   * This allows the modified data array to be used for lookups without special casing the empty
   * key.
   */
  tableWithMungedEmptyKey(callback: (table: Uint32Array) => void) {
    const numHashes = this.hashSeeds.length;
    const emptySlots = new Array<number>(numHashes);
    for (let i = 0; i < numHashes; ++i) {
      emptySlots[i] = this.getHash(i, this.emptyLow, this.emptyHigh);
    }
    let {mungedEmptyKey} = this;
    if (mungedEmptyKey === -1) {
      chooseMungedEmptyKey: while (true) {
        mungedEmptyKey = (Math.random() * 0x1000000) >>> 0;
        for (let i = 0; i < numHashes; ++i) {
          let h = this.getHash(i, mungedEmptyKey, mungedEmptyKey);
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
    let {table, emptyLow, emptyHigh} = this;
    for (let i = 0; i < numHashes; ++i) {
      let h = emptySlots[i];
      if (table[h] === emptyLow && table[h + 1] === emptyHigh) {
        table[h] = mungedEmptyKey;
        table[h + 1] = mungedEmptyKey;
      }
    }
    try {
      callback(table);
    } finally {
      for (let i = 0; i < numHashes; ++i) {
        let h = emptySlots[i];
        if (table[h] === mungedEmptyKey && table[h + 1] === mungedEmptyKey) {
          table[h] = emptyLow;
          table[h + 1] = emptyHigh;
        }
      }
    }
  }

  static generateHashSeeds(numAlternatives = NUM_ALTERNATIVES) {
    return getRandomValues(new Uint32Array(numAlternatives));
  }

  getHash(hashIndex: number, low: number, high: number) {
    let hash = this.hashSeeds[hashIndex];
    hash = hashCombine(hash, low);
    hash = hashCombine(hash, high);
    return this.entryStride * (hash & (this.tableSize - 1));
  }

  /**
   * Iterates over the Uint64 keys contained in the hash set.
   *
   * Creates a new Uint64 object at every iteration (otherwise spread and Array.from() fail)
   */
  * keys() {
    let {emptyLow, emptyHigh, entryStride} = this;
    let {table} = this;
    for (let i = 0, length = table.length; i < length; i += entryStride) {
      let low = table[i], high = table[i + 1];
      if (low !== emptyLow || high !== emptyHigh) {
        yield new Uint64(low, high);
      }
    }
  }

  /**
   * Iterates over the Uint64 keys contained in the hash set.
   *
   * The same temp value will be modified and yielded at every iteration.
   */
  * unsafeKeys(temp = new Uint64()) {
    let {emptyLow, emptyHigh, entryStride} = this;
    let {table} = this;
    for (let i = 0, length = table.length; i < length; i += entryStride) {
      let low = table[i], high = table[i + 1];
      if (low !== emptyLow || high !== emptyHigh) {
        temp.low = low;
        temp.high = high;
        yield temp;
      }
    }
  }

  indexOfPair(low: number, high: number) {
    let {table, emptyLow, emptyHigh} = this;
    if (low === emptyLow && high === emptyHigh) {
      return -1;
    }
    for (let i = 0, numHashes = this.hashSeeds.length; i < numHashes; ++i) {
      let h = this.getHash(i, low, high);
      if (table[h] === low && table[h + 1] === high) {
        return h;
      }
    }
    return -1;
  }

  /**
   * Returns the offset into the hash table of the specified element, or -1 if the element is not
   * present.
   */
  indexOf(x: Uint64) {
    return this.indexOfPair(x.low, x.high);
  }

  /**
   * Changes the empty key to a value that is not equal to the current empty key and is not present
   * in the table.
   *
   * This is called when an attempt is made to insert the empty key.
   */
  private chooseAnotherEmptyKey() {
    let {emptyLow, emptyHigh, table, entryStride} = this;
    let newLow: number, newHigh: number;
    while (true) {
      newLow = (Math.random() * 0x100000000) >>> 0;
      newHigh = (Math.random() * 0x100000000) >>> 0;
      if (newLow === emptyLow && newHigh === emptyHigh) {
        continue;
      }
      if (this.hasPair(newLow, newHigh)) {
        continue;
      }
      break;
    }

    this.emptyLow = newLow;
    this.emptyHigh = newHigh;

    // Replace empty keys in the table.
    for (let h = 0, length = table.length; h < length; h += entryStride) {
      if (table[h] === emptyLow && table[h + 1] === emptyHigh) {
        table[h] = newLow;
        table[h + 1] = newHigh;
      }
    }
  }

  /**
   * Returns true iff the specified element is present.
   */
  has(x: Uint64) {
    return this.indexOf(x) !== -1;
  }

  /**
   * Returns true iff the specified element is present.
   */
  hasPair(low: number, high: number) {
    return this.indexOfPair(low, high) !== -1;
  }

  delete(x: Uint64) {
    let index = this.indexOf(x);
    if (index !== -1) {
      let {table} = this;
      table[index] = this.emptyLow;
      table[index + 1] = this.emptyHigh;
      ++this.generation;
      this.size--;
      return true;
    }
    return false;
  }

  private clearTable() {
    let {table, entryStride, emptyLow, emptyHigh} = this;
    let length = table.length;

    for (let h = 0; h < length; h += entryStride) {
      table[h] = emptyLow;
      table[h + 1] = emptyHigh;
    }
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

  protected swapPending(table: Uint32Array, offset: number) {
    let tempLow = pendingLow, tempHigh = pendingHigh;
    this.storePending(table, offset);
    table[offset] = tempLow;
    table[offset + 1] = tempHigh;
  }

  protected storePending(table: Uint32Array, offset: number) {
    pendingLow = table[offset];
    pendingHigh = table[offset + 1];
  }

  protected backupPending() {
    backupPendingLow = pendingLow;
    backupPendingHigh = pendingHigh;
  }

  protected restorePending() {
    pendingLow = backupPendingLow;
    pendingHigh = backupPendingHigh;
  }

  private tryToInsert() {
    if (DEBUG) {
      console.log(`tryToInsert: ${pendingLow}, ${pendingHigh}`);
    }
    let attempt = 0;
    let {emptyLow, emptyHigh, maxAttempts, table} = this;
    let numHashes = this.hashSeeds.length;

    let tableIndex = Math.floor(Math.random() * numHashes);
    while (true) {
      let h = this.getHash(tableIndex, pendingLow, pendingHigh);
      this.swapPending(table, h);
      if (pendingLow === emptyLow && pendingHigh === emptyHigh) {
        return true;
      }
      if (++attempt === maxAttempts) {
        break;
      }
      tableIndex = (tableIndex + Math.floor(Math.random() * (numHashes - 1)) + 1) % numHashes;
    }
    return false;
  }

  private allocate(tableSize: number) {
    this.tableSize = tableSize;
    let {entryStride} = this;
    this.table = new Uint32Array(tableSize * entryStride);
    this.maxAttempts = tableSize;
    this.clearTable();
    this.capacity = tableSize * this.loadFactor;
    this.mungedEmptyKey = -1;
  }

  private rehash(oldTable: Uint32Array, tableSize: number) {
    if (DEBUG) {
      console.log('rehash begin');
    }
    this.allocate(tableSize);
    this.updateHashFunctions(this.hashSeeds.length);
    let {emptyLow, emptyHigh, entryStride} = this;
    for (let h = 0, length = oldTable.length; h < length; h += entryStride) {
      let low = oldTable[h], high = oldTable[h + 1];
      if (low !== emptyLow || high !== emptyHigh) {
        this.storePending(oldTable, h);
        if (!this.tryToInsert()) {
          if (DEBUG) {
            console.log('rehash failed');
          }
          return false;
        }
      }
    }
    if (DEBUG) {
      console.log('rehash end');
    }
    return true;
  }

  private grow(desiredTableSize: number) {
    if (DEBUG) {
      console.log(`grow: ${desiredTableSize}`);
    }
    let oldTable = this.table;
    let {tableSize} = this;
    while (tableSize < desiredTableSize) {
      tableSize *= 2;
    }
    while (true) {
      for (let rehashAttempt = 0; rehashAttempt < this.maxRehashAttempts; ++rehashAttempt) {
        if (this.rehash(oldTable, tableSize)) {
          if (DEBUG) {
            console.log(`grow end`);
          }
          return;
        }
      }
      tableSize *= 2;
    }
  }

  protected insertInternal() {
    ++this.generation;

    if (pendingLow === this.emptyLow && pendingHigh === this.emptyHigh) {
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
  add(x: Uint64) {
    let {low, high} = x;
    if (this.hasPair(low, high)) {
      return false;
    }
    if (DEBUG) {
      console.log(`add: ${low},${high}`);
    }
    pendingLow = low;
    pendingHigh = high;
    this.insertInternal();
    return true;
  }

  /**
   * Iterates over the keys.
   * Creates a new Uint64 object at every iteration (otherwise spread and Array.from() fail)
   */
  [Symbol.iterator]() {
    return this.unsafeKeys();
  }
}
HashSetUint64.prototype.entryStride = 2;

// Value that needs to be inserted.  Temporary variables used during insert.  These can safely be
// global because control never leaves functions defined in this module while these are in use.
let pendingValueLow = 0, pendingValueHigh = 0, backupPendingValueLow = 0,
    backupPendingValueHigh = 0;

export class HashMapUint64 extends HashTableBase {
  set(key: Uint64, value: Uint64) {
    let {low, high} = key;
    if (this.hasPair(low, high)) {
      return false;
    }
    if (DEBUG) {
      console.log(`add: ${low},${high} -> ${value.low},${value.high}`);
    }
    pendingLow = low;
    pendingHigh = high;
    pendingValueLow = value.low;
    pendingValueHigh = value.high;
    this.insertInternal();
    return true;
  }

  get(key: Uint64, value: Uint64): boolean {
    let h = this.indexOf(key);
    if (h === -1) {
      return false;
    }
    let {table} = this;
    value.low = table[h + 2];
    value.high = table[h + 3];
    return true;
  }

  protected swapPending(table: Uint32Array, offset: number) {
    let tempLow = pendingValueLow, tempHigh = pendingValueHigh;
    super.swapPending(table, offset);
    table[offset + 2] = tempLow;
    table[offset + 3] = tempHigh;
  }

  protected storePending(table: Uint32Array, offset: number) {
    super.storePending(table, offset);
    pendingValueLow = table[offset + 2];
    pendingValueHigh = table[offset + 3];
  }

  protected backupPending() {
    super.backupPending();
    backupPendingValueLow = pendingValueLow;
    backupPendingValueHigh = pendingValueHigh;
  }

  protected restorePending() {
    super.restorePending();
    pendingValueLow = backupPendingValueLow;
    pendingValueHigh = backupPendingValueHigh;
  }

  /**
   * Iterates over entries.  The same temporary value will be modified and yielded at every
   * iteration.
   */
  [Symbol.iterator]() {
    return this.unsafeEntries();
  }

  /**
   * Iterates over entries.
   * Creates new Uint64 objects at every iteration (otherwise spread and Array.from() fail)
   */
  * entries() {
    let {emptyLow, emptyHigh, entryStride} = this;
    let {table} = this;
    for (let i = 0, length = table.length; i < length; i += entryStride) {
      let low = table[i], high = table[i + 1];
      if (low !== emptyLow || high !== emptyHigh) {
        let key = new Uint64(low, high);
        let value = new Uint64(table[i + 2], table[i + 3]);
        yield [key, value];
      }
    }
  }

  /**
   * Iterates over entries.  The same temporary value will be modified and yielded at every
   * iteration.
   */
  * unsafeEntries(temp: [Uint64, Uint64] = [new Uint64(), new Uint64()]) {
    let {emptyLow, emptyHigh, entryStride} = this;
    let {table} = this;
    let [key, value] = temp;
    for (let i = 0, length = table.length; i < length; i += entryStride) {
      let low = table[i], high = table[i + 1];
      if (low !== emptyLow || high !== emptyHigh) {
        key.low = low;
        key.high = high;
        value.low = table[i + 2];
        value.high = table[i + 3];
        yield temp;
      }
    }
  }
}
HashMapUint64.prototype.entryStride = 4;
