/**
 * @license
 * Copyright 2019 Google Inc.
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

import 'neuroglancer/ui/statistics.css';

import debounce from 'lodash/debounce';
import {ChunkDownloadStatistics, ChunkMemoryStatistics, ChunkPriorityTier, ChunkState, getChunkDownloadStatisticIndex, getChunkStateStatisticIndex, numChunkMemoryStatistics, numChunkStates, REQUEST_CHUNK_STATISTICS_RPC_ID} from 'neuroglancer/chunk_manager/base';
import {ChunkQueueManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {verifyPositiveInt} from 'neuroglancer/util/json';
import {CompoundTrackable, Trackable} from 'neuroglancer/util/trackable';

export class StatisticsDisplayState implements Trackable {
  private tracker = new CompoundTrackable();
  get changed() {
    return this.tracker.changed;
  }
  visible = new TrackableBoolean(false);
  size = new TrackableValue<number>(100, verifyPositiveInt);
  sortBy?: WatchableValueInterface<string>;
  constructor() {
    this.tracker.add('visible', this.visible);
    this.tracker.add('size', this.size);
  }

  restoreState(obj: any) {
    this.tracker.restoreState(obj);
  }

  reset() {
    this.tracker.reset();
  }

  toJSON() {
    const obj = this.tracker.toJSON();
    for (const k of Object.keys(obj)) {
      if (obj[k as keyof typeof obj] !== undefined) return obj;
    }
    return undefined;
  }
}

function getProperties(obj: any): Map<string, string> {
  const map = new Map<string, string>();
  function handleObject(o: any, prefix: string) {
    if (typeof o !== 'object') {
      map.set(prefix, '' + o);
      return;
    }
    for (const key of Object.keys(o)) {
      handleObject(o[key], prefix + '.' + key);
    }
  }
  handleObject(obj, '');
  return map;
}

function getDistinguishingProperties(properties: Map<string,string>[]): string[] {
  const selected = new Set<string>();
  selected.add('.type');
  const allProps = new Set<string>();
  function areDistinguished(i: number, j: number) {
    for (const prop of selected) {
      if (properties[i].get(prop) !== properties[j].get(prop)) {
        return true;
      }
    }
    return false;
  }
  for (let i = 0, n = properties.length; i < n; ++i) {
    for (const prop of properties[i].keys()) {
      allProps.add(prop);
    }
    let matches: number[] = [];
    for (let j = 0; j < i; ++j) {
      if (!areDistinguished(i, j)) {
        matches.push(j);
      }
    }
    while (matches.length > 0) {
      let bestReducedMatches: number[] = matches;
      let bestProp: string|undefined = undefined;
      for (const prop of allProps) {
        if (selected.has(prop)) continue;
        const reducedMatches: number[] = [];
        for (const j of matches) {
          if (properties[j].get(prop) === properties[i].get(prop)) {
            reducedMatches.push(j);
          }
        }
        if (reducedMatches.length < bestReducedMatches.length) {
          bestReducedMatches = reducedMatches;
          bestProp = prop;
        }
        if (reducedMatches.length === 0) break;
      }
      // Prevent infinite loop if there are no distinguishing properties.
      if (bestProp === undefined) break;
      matches = bestReducedMatches;
      selected.add(bestProp);
    }
  }
  return Array.from(selected);
}

function getNameFromProps(properties: Map<string,string>, selected: string[]) {
  const result: any = {};
  for (const prop of selected) {
    const value = properties.get(prop);
    if (value === undefined) continue;
    if (prop === '') return value;
    result[prop] = value;
  }
  return JSON.stringify(result);
}

function getFormattedNames(objects: any[]) {
  const properties = objects.map(getProperties);
  const selectedProps = getDistinguishingProperties(properties);
  return properties.map(p => getNameFromProps(p, selectedProps));
}

type ChunkStatistics = Map<number, Float64Array>;

/**
 * Interval in ms at which to request new statistics from the backend thread.
 */
const requestDataInterval = 1000;

export class StatisticsPanel extends RefCounted {
  element = document.createElement('div');
  columns = new Map<string, (statistics: Float64Array) => number>();
  data: ChunkStatistics|undefined = undefined;
  private requestDataTimerId = -1;
  private dataRequested = false;
  constructor(
      public chunkQueueManager: Borrowed<ChunkQueueManager>,
      public displayState: StatisticsDisplayState) {
    super();

    const {element} = this;
    element.className = 'neuroglancer-statistics-panel';

    this.registerDisposer(this.displayState.changed.add(this.debouncedUpdateView));
    this.registerDisposer(this.displayState.visible.changed.add(() => this.requestData()));
    this.requestData();

    const {columns} = this;
    // Total number of visible-priority chunks
    //    number in downloading state
    //    number in other system memory state
    //    number in gpu memory state
    //    number in failed state
    columns.set('Visible chunks/T', (statistics) => {
      let sum = 0;
      for (let state: ChunkState = 0; state < numChunkStates; ++state) {
        sum += statistics[getChunkStateStatisticIndex(state, ChunkPriorityTier.VISIBLE) *
                          numChunkMemoryStatistics + ChunkMemoryStatistics.numChunks];
      }
      return sum;
    });

    columns.set('Visible chunks/D', (statistics) => {
      return (
          statistics
              [getChunkStateStatisticIndex(ChunkState.DOWNLOADING, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.numChunks] +
          statistics
              [getChunkStateStatisticIndex(ChunkState.COMPUTING, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.numChunks]);
    });

    columns.set('Visible chunks/M', (statistics) => {
      return (
          statistics
              [getChunkStateStatisticIndex(ChunkState.SYSTEM_MEMORY, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.numChunks] +
          statistics
              [getChunkStateStatisticIndex(
                   ChunkState.SYSTEM_MEMORY_WORKER, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.numChunks]);
    });

    columns.set('Visible chunks/G', (statistics) => {
      return statistics[getChunkStateStatisticIndex(ChunkState.GPU_MEMORY, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.numChunks];
    });

    columns.set('Visible chunks/F', (statistics) => {
      return statistics[getChunkStateStatisticIndex(ChunkState.FAILED, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.numChunks];
    });

    columns.set('Visible memory', (statistics) => {
      return statistics[getChunkStateStatisticIndex(ChunkState.GPU_MEMORY, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.gpuMemoryBytes];
    });

    columns.set('Download latency', (statistics) => {
      return statistics[getChunkDownloadStatisticIndex(ChunkDownloadStatistics.totalTime)] /
          statistics[getChunkDownloadStatisticIndex(ChunkDownloadStatistics.totalChunks)];
    });
  }

  disposed() {
    clearTimeout(this.requestDataTimerId);
    removeFromParent(this.element);
    super.disposed();
  }

  private requestData() {
    if (!this.displayState.visible) return;
    if (this.dataRequested) return;
    const {chunkQueueManager} = this;
    const rpc = chunkQueueManager.rpc!;
    this.dataRequested = true;
    rpc.promiseInvoke<ChunkStatistics>(
           REQUEST_CHUNK_STATISTICS_RPC_ID, {queue: chunkQueueManager.rpcId})
        .then(data => {
          this.dataRequested = false;
          this.data = data;
          this.debouncedUpdateView();
          this.requestDataTimerId = setTimeout(() => {
            this.requestDataTimerId = -1;
            this.requestData();
          }, requestDataInterval);
        });
  }

  private debouncedUpdateView = this.registerCancellable(debounce(() => this.updateView(), 0));

  private updateView() {
    if (!this.displayState.visible.value) return;
    const {data} = this;
    if (data === undefined) return;
    const {columns} = this;
    const rpc = this.chunkQueueManager.rpc!;
    const table = document.createElement('table');
    const rows: [ChunkSource, ...number[]][] = [];
    for (const [id, statistics] of data) {
      const source = rpc.get(id) as ChunkSource | undefined;
      if (source === undefined) continue;
      const row: [ChunkSource, ...number[]] = [source];
      for (const column of columns.values()) {
        row.push(column(statistics));
      }
      rows.push(row);
    }

    const formattedNames =
        getFormattedNames(rows.map(x => Object.assign({type: x[0].RPC_TYPE_ID}, x[0].key || {})));
    const sourceFormattedNames = new Map<ChunkSource, string>();
    formattedNames.forEach((name, i) => {
      sourceFormattedNames.set(rows[i][0], name);
    });

    {
      const thead = document.createElement('thead');
      let tr = document.createElement('tr');
      thead.appendChild(tr);
      const addHeaderColumn = (label: string) => {
        const td = document.createElement('td');
        td.textContent = label;
        tr.appendChild(td);
      };
      addHeaderColumn('Name');
      let prevPrefix: string|undefined = undefined;
      for (const column of columns.keys()) {
        const sepIndex = column.indexOf('/');
        let prefix = column;
        if (sepIndex !== -1) {
          prefix = column.substring(0, sepIndex);
          if (prefix === prevPrefix) {
            ++(tr.lastElementChild! as HTMLTableCellElement).colSpan;
            continue;
          }
          prevPrefix = prefix;
        }
        addHeaderColumn(prefix);
      }
      tr = document.createElement('tr');
      thead.appendChild(tr);
      {
        const td = document.createElement('td');
        tr.appendChild(td);
      }
      for (const column of columns.keys()) {
        const sepIndex = column.indexOf('/');
        let suffix = '';
        if (sepIndex !== -1) {
          suffix = column.substring(sepIndex+1);
        }
        const td = document.createElement('td');
        td.textContent = suffix;
        tr.appendChild(td);
      }
      table.appendChild(thead);
    }
    const tbody = document.createElement('tbody');
    // TODO: sort rows
    for (const [source, ...values] of rows) {
      const tr = document.createElement('tr');
      const addColumn = (label: string) => {
        const td = document.createElement('td');
        td.textContent = label;
        tr.appendChild(td);
      };
      addColumn(sourceFormattedNames.get(source)!);
      for (const value of values) {
        addColumn('' + value);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    removeChildren(this.element);
    this.element.appendChild(table);
  }
}
