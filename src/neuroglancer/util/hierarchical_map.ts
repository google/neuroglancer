/**
 * @license
 * Copyright 2017 Google Inc.
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
 * @file Hierarchical mapping from keys to values.
 */

export interface HierarchicalMapInterface<Key, Value> {
  get(key: Key): Value|undefined;
  entries(): IterableIterator<[Key, Value]>;
}

/**
 * Maps string event identifiers to string action identifiers.
 *
 * When an event identifier is looked up in a given HierarchicalMap, it is resolved to a
 * corresponding action identifier in one of two ways:
 *
 * 1. via mappings defined directly on the HierarchicalMap.
 *
 * 2. via a recursive lookup on a "parent" HierarchicalMap that has been specified for the root
 *    HierarchicalMap on which the lookup was initiated.
 *
 * HierarchicalMap objects may be specified as "parents" of another HierarchicalMap along with a
 * specified numerical priority value, such that there is a directed graph of HierarchicalMap
 * objects.  Cycles in this graph may lead to infinite looping.
 *
 * Recursive lookups in parent HierarchicalMap objects are performed in order of decreasing
 * priority. The lookup stops as soon as a mapping is found.  Direct bindings have a priority of 0.
 * Therefore, parent maps with a priority higher than 0 take precedence over direct bindings.
 */
export class HierarchicalMap<Key, Value, Parent extends HierarchicalMapInterface<Key, Value> =
                                                            HierarchicalMapInterface<Key, Value>>
    implements HierarchicalMapInterface<Key, Value> {
  parents = new Array<Parent>();
  private parentPriorities = new Array<number>();
  bindings = new Map<Key, Value>();

  /**
   * If an existing HierarchicalMap is specified, a shallow copy is made.
   *
   * @param existing Existing map to make a shallow copy of.
   */
  constructor(existing?: HierarchicalMap<Key, Value, Parent>) {
    if (existing !== undefined) {
      this.parents.push(...existing.parents);
      this.parentPriorities.push(...existing.parentPriorities);
      for (const [k, v] of existing.bindings) {
        this.bindings.set(k, v);
      }
    }
  }

  /**
   * Register `parent` as a parent map.  If `priority > 0`, this map will take precedence over
   * direct bindings.
   *
   * @returns A nullary function that unregisters the parent (and may be called at most once).
   */
  addParent(parent: Parent, priority: number) {
    const {parents, parentPriorities} = this;
    let index = 0;
    const {length} = parents;
    while (index < length && priority < parentPriorities[index]) {
      ++index;
    }
    parents.splice(index, 0, parent);
    parentPriorities.splice(index, 0, priority);

    return () => {
      this.removeParent(parent);
    };
  }

  /**
   * Unregisters `parent` as a parent.
   */
  removeParent(parent: Parent) {
    const index = this.parents.indexOf(parent);
    if (index === -1) {
      throw new Error(`Attempt to remove non-existent parent map.`);
    }
    this.parents.splice(index, 1);
    this.parentPriorities.splice(index, 1);
  }

  /**
   * Register a direct binding.
   */
  set(key: Key, value: Value) {
    this.bindings.set(key, value);
  }

  /**
   * Unregister a direct binding.
   */
  delete(key: Key) {
    this.bindings.delete(key);
  }

  /**
   * Deletes all bindings, including parents.
   */
  clear() {
    this.bindings.clear();
    this.parents.length = 0;
    this.parentPriorities.length = 0;
  }

  /**
   * Lookup the highest priority value to which the specified key is mapped.
   */
  get(key: Key): Value|undefined {
    const {parents, parentPriorities} = this;
    const numParents = parentPriorities.length;
    let parentIndex = 0;
    let value;
    for (; parentIndex < numParents && parentPriorities[parentIndex] > 0; ++parentIndex) {
      value = parents[parentIndex].get(key);
      if (value !== undefined) {
        return value;
      }
    }
    value = this.bindings.get(key);
    if (value !== undefined) {
      return value;
    }
    for (; parentIndex < numParents; ++parentIndex) {
      value = parents[parentIndex].get(key);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * Find all values to which the specified key is mapped.
   */
  * getAll(key: Key): IterableIterator<Value> {
    const {parents, parentPriorities} = this;
    const numParents = parentPriorities.length;
    let parentIndex = 0;
    let value;
    while (parentIndex < numParents && parentPriorities[parentIndex] > 0) {
      value = parents[parentIndex].get(key);
      if (value !== undefined) {
        yield value;
      }
    }
    value = this.bindings.get(key);
    if (value !== undefined) {
      yield value;
    }
    while (parentIndex < numParents) {
      value = parents[parentIndex].get(key);
      if (value !== undefined) {
        yield value;
      }
    }
  }

  * entries(): IterableIterator<[Key, Value]> {
    const {parents, parentPriorities} = this;
    const numParents = parentPriorities.length;
    let parentIndex = 0;
    while (parentIndex < numParents && parentPriorities[parentIndex] > 0) {
      yield *parents[parentIndex].entries();
    }
    yield *this.bindings.entries();
    while (parentIndex < numParents) {
      yield *parents[parentIndex].entries();
    }
  }
}
