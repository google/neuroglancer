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

import {HashFunction} from 'neuroglancer/gpu_hash/hash_function';

export const NUM_ALTERNATIVES = 3;

const DEFAULT_LOAD_FACTOR = 0.9;

export class HashTable {
  hashFunctions: HashFunction[][];
  loadFactor = DEFAULT_LOAD_FACTOR;
  size = 0;
  tables: Uint32Array[];
  growFactor = 1.2;
  maxWidth = 4096;
  width: number;
  height: number;
  maxHeight = 8192;
  emptyLow = 4294967295;
  emptyHigh = 4294967295;
  maxRehashAttempts = 5;
  maxAttempts = 5;
  capacity: number;
  generation = 0;

  constructor(hashFunctions = HashTable.generateHashFunctions(NUM_ALTERNATIVES)) {
    this.hashFunctions = hashFunctions;
    this.allocate(4, 1);
  }

  private updateHashFunctions(numAlternatives: number) {
    this.hashFunctions = HashTable.generateHashFunctions(numAlternatives);
  }

  static generateHashFunctions(numAlternatives = NUM_ALTERNATIVES) {
    let hashFunctions: HashFunction[][] = [];
    for (let alt = 0; alt < numAlternatives; ++alt) {
      let curFunctions = [HashFunction.generate(), HashFunction.generate()];
      hashFunctions.push(curFunctions);
    }
    return hashFunctions;
  }

  getHash(tableIndex: number, low: number, high: number) {
    let hashes = this.hashFunctions[tableIndex];
    let width = this.width, height = this.height;
    let x = hashes[0].compute(low, high) % width;
    let y = hashes[1].compute(low, high) % height;
    return 2 * (y * this.width + x);
  }

  * [Symbol.iterator]() {
    let tableSize = this.width * this.height;
    let emptyLow = this.emptyLow, emptyHigh = this.emptyHigh;
    let temp = [0, 0];
    for (let table of this.tables) {
      for (let i = 0; i < tableSize; ++i) {
        let low = table[2 * i], high = table[2 * i + 1];
        if (low !== emptyLow || high !== emptyHigh) {
          temp[0] = low;
          temp[1] = high;
          yield temp;
        }
      }
    }
  }

  /**
   * Returns the index of the table containing the specified element, or null if the element is not
   * present.
   */
  hasWithTableIndex(low: number, high: number) {
    let numTables = this.tables.length;
    for (let i = 0; i < numTables; ++i) {
      let h = this.getHash(i, low, high);
      let table = this.tables[i];
      if (table[h] === low && table[h + 1] === high) {
        return i;
      }
    }
    return null;
  }


  /**
   * Returns true iff the specified element is present.
   */
  has(low: number, high: number) {
    let numTables = this.tables.length;
    for (let i = 0; i < numTables; ++i) {
      let h = this.getHash(i, low, high);
      let table = this.tables[i];
      if (table[h] === low && table[h + 1] === high) {
        return true;
      }
    }
    return false;
  }

  delete (low: number, high: number) {
    let numTables = this.tables.length;
    for (let i = 0; i < numTables; ++i) {
      let h = this.getHash(i, low, high);
      let table = this.tables[i];
      if (table[h] === low && table[h + 1] === high) {
        table[h] = this.emptyLow;
        table[h + 1] = this.emptyHigh;
        ++this.generation;
        this.size--;
        return true;
      }
    }
    return false;
  }

  clear() {
    if (this.size === 0) {
      return false;
    }
    this.size = 0;
    ++this.generation;
    let {tables, emptyLow, emptyHigh} = this;
    let numTables = tables.length;
    for (let i = 0; i < numTables; ++i) {
      let table = tables[i];
      let tableSize = table.length;
      for (let j = 0; j < tableSize; j += 2) {
        table[j] = emptyLow;
        table[j + 1] = emptyHigh;
      }
    }
    return true;
  }

  private tryToInsert(low: number, high: number) {
    let attempt = 0;
    let {emptyLow, emptyHigh, maxAttempts, tables} = this;
    let numTables = tables.length;

    let tableIndex = Math.floor(Math.random() * numTables);
    while (true) {
      let h = this.getHash(tableIndex, low, high);
      let table = tables[tableIndex];
      let newLow = table[h], newHigh = table[h + 1];
      table[h] = low;
      table[h + 1] = high;
      if (newLow === emptyLow && newHigh === emptyHigh) {
        return null;
      }
      low = newLow;
      high = newHigh;
      if (++attempt === maxAttempts) {
        break;
      }
      tableIndex = (tableIndex + Math.floor(Math.random() * (numTables - 1))) % numTables;
    }
    return [low, high];
  }

  private allocate(width: number, height: number) {
    let tableSize = width * height;
    this.width = width;
    this.height = height;
    let numAlternatives = this.hashFunctions.length;
    let tables = this.tables = new Array(numAlternatives);
    for (let i = 0; i < numAlternatives; ++i) {
      tables[i] = new Uint32Array(tableSize * 2);
    }
    this.maxAttempts = tableSize;
    let emptyLow = this.emptyLow, emptyHigh = this.emptyHigh;
    for (let table of tables) {
      for (let i = 0; i < tableSize; ++i) {
        table[2 * i] = emptyLow;
        table[2 * i + 1] = emptyHigh;
      }
    }
    this.capacity = tableSize * this.tables.length * this.loadFactor;
  }

  private rehash(oldTables: Uint32Array[], width: number, height: number) {
    this.allocate(width, height);
    this.updateHashFunctions(oldTables.length);
    for (let table of oldTables) {
      let tableSize = table.length / 2;
      for (let i = 0; i < tableSize; ++i) {
        let h = 2 * i;
        let low = table[h], high = table[h + 1];
        if (low !== 0 || high !== 0) {
          if (this.tryToInsert(low, high) !== null) {
            return false;
          }
        }
      }
    }
    return true;
  }

  private grow(desiredTableSize: number) {
    let oldTables = this.tables;
    let {width, height, maxWidth, maxHeight} = this;
    while (true) {
      let origTableSize = width * height;
      width = Math.min(maxWidth, Math.ceil(desiredTableSize / this.height));
      if (width * height < desiredTableSize) {
        height = Math.min(maxHeight, Math.ceil(desiredTableSize / this.width));
      }
      let tableSize = width * height;
      if (tableSize < desiredTableSize && tableSize === origTableSize) {
        throw new Error('Maximum table size exceeded');
      }

      for (let rehashAttempt = 0; rehashAttempt < this.maxRehashAttempts; ++rehashAttempt) {
        if (this.rehash(oldTables, width, height)) {
          return;
        }
      }
      desiredTableSize = Math.ceil(this.growFactor * desiredTableSize);
    }
  }

  add(low: number, high: number) {
    if (this.has(low, high)) {
      return false;
    }
    ++this.generation;

    if (++this.size > this.capacity) {
      this.grow(Math.ceil(this.growFactor * this.width * this.height));
    }

    while (true) {
      let result = this.tryToInsert(low, high);
      if (result == null) {
        return true;
      }
      low = result[0];
      high = result[1];
      this.grow(this.width * this.height);
    }
  }
};
