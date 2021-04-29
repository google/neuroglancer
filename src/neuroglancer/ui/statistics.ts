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
import {ChunkDownloadStatistics, ChunkMemoryStatistics, ChunkPriorityTier, ChunkState, getChunkDownloadStatisticIndex, getChunkStateStatisticIndex, numChunkMemoryStatistics, numChunkStates} from 'neuroglancer/chunk_manager/base';
import {ChunkQueueManager, ChunkSource, ChunkStatistics} from 'neuroglancer/chunk_manager/frontend';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {SidePanelLocation, TrackableSidePanelLocation} from 'neuroglancer/ui/side_panel_location';
import {Borrowed} from 'neuroglancer/util/disposable';
import {removeChildren} from 'neuroglancer/util/dom';
import {emptyToUndefined} from 'neuroglancer/util/json';
import {Trackable} from 'neuroglancer/util/trackable';

import {SidePanel, SidePanelManager} from './side_panel';

const DEFAULT_STATISTICS_PANEL_LOCATION: SidePanelLocation = {
  side: 'bottom',
  size: 100,
  minSize: 50,
  row: 0,
  col: 0,
  flex: 1,
  visible: false,
};

export class StatisticsDisplayState implements Trackable {
  get changed() {
    return this.location.changed;
  }
  location = new TrackableSidePanelLocation(DEFAULT_STATISTICS_PANEL_LOCATION);
  sortBy?: WatchableValueInterface<string>;

  restoreState(obj: any) {
    this.location.restoreState(obj);
  }

  reset() {
    this.location.reset();
  }

  toJSON() {
    return emptyToUndefined(this.location.toJSON());
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

function getDistinguishingProperties(properties: Map<string, string>[]): string[] {
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

function getNameFromProps(properties: Map<string, string>, selected: string[]) {
  const result: any = {};
  for (const prop of selected) {
    const value = properties.get(prop);
    if (value === undefined) continue;
    if (prop === '') return value;
    result[prop] = value;
  }
  return JSON.stringify(result);
}

export function getChunkSourceIdentifier(source: ChunkSource) {
  return Object.assign({type: source.RPC_TYPE_ID}, source.key || {});
}

export function getFormattedNames(objects: any[]) {
  const properties = objects.map(getProperties);
  const selectedProps = getDistinguishingProperties(properties);
  return properties.map(p => getNameFromProps(p, selectedProps));
}

/**
 * Interval in ms at which to request new statistics from the backend thread.
 */
const requestDataInterval = 1000;

export interface ChunkStatisticsColumn {
  label: string;
  key: string;
  getter: (statistics: Float64Array) => number;
}

export const columnSpecifications: ChunkStatisticsColumn[] = [
  {
    label: 'Visible chunks/T',
    key: 'visibleChunksTotal',
    getter: statistics => {
      let sum = 0;
      for (let state: ChunkState = 0; state < numChunkStates; ++state) {
        sum += statistics[getChunkStateStatisticIndex(state, ChunkPriorityTier.VISIBLE) *
                          numChunkMemoryStatistics + ChunkMemoryStatistics.numChunks];
      }
      return sum;
    },
  },
  {
    label: 'Visible chunks/D',
    key: 'visibleChunksDownloading',
    getter: statistics => {
      return (statistics
                  [getChunkStateStatisticIndex(ChunkState.DOWNLOADING, ChunkPriorityTier.VISIBLE) *
                       numChunkMemoryStatistics +
                   ChunkMemoryStatistics.numChunks]);
    },
  },
  {
    label: 'Visible chunks/M',
    key: 'visibleChunksSystemMemory',
    getter: statistics => {
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
    },
  },
  {
    label: 'Visible chunks/G',
    key: 'visibleChunksGpuMemory',
    getter: statistics => {
      return statistics[getChunkStateStatisticIndex(ChunkState.GPU_MEMORY, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.numChunks];
    },
  },
  {
    label: 'Visible chunks/F',
    key: 'visibleChunksFailed',
    getter: statistics => {
      return statistics[getChunkStateStatisticIndex(ChunkState.FAILED, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.numChunks];
    },
  },
  {
    label: 'Visible memory',
    key: 'visibleGpuMemory',
    getter: statistics => {
      return statistics[getChunkStateStatisticIndex(ChunkState.GPU_MEMORY, ChunkPriorityTier.VISIBLE) *
                   numChunkMemoryStatistics +
               ChunkMemoryStatistics.gpuMemoryBytes];
    },
  },
  {
    label: 'Download latency',
    key: 'downloadLatency',
    getter: statistics => {
      return statistics[getChunkDownloadStatisticIndex(ChunkDownloadStatistics.totalTime)] /
          statistics[getChunkDownloadStatisticIndex(ChunkDownloadStatistics.totalChunks)];
    },
  },
];

export class StatisticsPanel extends SidePanel {
  data: ChunkStatistics|undefined = undefined;
  private requestDataTimerId = -1;
  private dataRequested = false;
  body = document.createElement('div');
  constructor(
      sidePanelManager: SidePanelManager, public chunkQueueManager: Borrowed<ChunkQueueManager>,
      public displayState: StatisticsDisplayState) {
    super(sidePanelManager, displayState.location);

    const {body} = this;
    body.classList.add('neuroglancer-statistics-panel-body');
    this.addTitleBar({title: 'Chunk statistics'});
    this.addBody(body);
    this.requestData();
  }

  disposed() {
    window.clearTimeout(this.requestDataTimerId);
    super.disposed();
  }

  private requestData() {
    if (this.dataRequested) return;
    const {chunkQueueManager} = this;
    this.dataRequested = true;
    chunkQueueManager.getStatistics().then(data => {
      this.dataRequested = false;
      this.data = data;
      this.debouncedUpdateView();
      this.requestDataTimerId = window.setTimeout(() => {
        this.requestDataTimerId = -1;
        this.requestData();
      }, requestDataInterval);
    });
  }

  private debouncedUpdateView = this.registerCancellable(debounce(() => this.updateView(), 0));

  private updateView() {
    const {data} = this;
    if (data === undefined) return;
    const table = document.createElement('table');
    const rows: [ChunkSource, ...number[]][] = [];
    for (const [source, statistics] of data) {
      const row: [ChunkSource, ...number[]] = [source];
      for (const {getter} of columnSpecifications) {
        row.push(getter(statistics));
      }
      rows.push(row);
    }

    const formattedNames = getFormattedNames(rows.map(x => getChunkSourceIdentifier(x[0])));
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
      for (const {label: column} of columnSpecifications) {
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
      for (const {label: column} of columnSpecifications) {
        const sepIndex = column.indexOf('/');
        let suffix = '';
        if (sepIndex !== -1) {
          suffix = column.substring(sepIndex + 1);
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
    removeChildren(this.body);
    this.body.appendChild(table);
  }
}
