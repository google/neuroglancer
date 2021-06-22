/**
 * @license
 * Copyright 2020 Google Inc.
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

import debounce from 'lodash/debounce';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {fetchWithCredentials} from 'neuroglancer/credentials_provider/http_request';
import {CompleteUrlOptions, CompletionResult, DataSource, DataSourceProvider, DataSubsourceEntry, GetDataSourceOptions} from 'neuroglancer/datasource';
import {Credentials, NggraphCredentialsProvider} from 'neuroglancer/datasource/nggraph/credentials_provider';
import {VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {ComputedSplit, isBaseSegmentId, SegmentationGraphSource, SegmentationGraphSourceConnection, UNKNOWN_NEW_SEGMENT_ID} from 'neuroglancer/segmentation_graph/source';
import {StatusMessage} from 'neuroglancer/status';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {DisjointUint64Sets} from 'neuroglancer/util/disjoint_sets';
import {responseJson} from 'neuroglancer/util/http_request';
import {parseArray, verifyFiniteFloat, verifyInt, verifyObject, verifyObjectProperty, verifyString, verifyStringArray} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';

const urlPattern = '^(https?://[^/]+)/(.*)$';

interface GraphSegmentInfo {
  id: Uint64;
  baseSegments: Uint64[];
  baseSegmentParents: Uint64[];
  name: string, tags: string[], numVoxels: number, bounds: number[], lastLogId: Uint64|null,
}

function parseGraphSegmentInfo(obj: any): GraphSegmentInfo {
  verifyObject(obj);
  return {
    id: verifyObjectProperty(obj, 'id', x => Uint64.parseString(verifyString(x))),
    baseSegments: verifyObjectProperty(
        obj, 'base_segment_ids', x => parseArray(x, y => Uint64.parseString(verifyString(y)))),
    baseSegmentParents: verifyObjectProperty(
        obj, 'base_segment_parent_ids',
        x => parseArray(x, y => Uint64.parseString(verifyString(y)))),
    name: verifyObjectProperty(obj, 'name', verifyString),
    tags: verifyObjectProperty(obj, 'tags', verifyStringArray),
    numVoxels: verifyObjectProperty(obj, 'num_voxels', verifyInt),
    bounds: verifyObjectProperty(obj, 'bounds', x => parseArray(x, y => verifyFiniteFloat(y))),
    lastLogId: verifyObjectProperty(
        obj, 'last_log_id', x => x == null ? null : Uint64.parseString(verifyString(x))),
  };
}

/// Base-10 string representation of a segment id, used as map key.
type SegmentIdString = string;

interface ActiveSegmentQuery {
  id: Uint64;
  current: GraphSegmentInfo|undefined;
  addedEquivalences: boolean;
  seenGeneration: number;
  disposer: () => void;
}

type GraphSegmentUpdate = GraphSegmentInfo|'invalid'|'error';

// Generation used for checking if segments have been seen.
let updateGeneration = 0;

class GraphConnection extends SegmentationGraphSourceConnection {
  graph: NggraphSegmentationGraphSource;
  constructor(graph: NggraphSegmentationGraphSource, segmentsState: VisibleSegmentsState) {
    super(graph, segmentsState);
    const visibleSegmentsChanged = () => {
      if (!this.ignoreVisibleSegmentsChanged) {
        this.debouncedVisibleSegmentsChanged();
      }
    };
    this.registerDisposer(segmentsState.visibleSegments.changed.add(visibleSegmentsChanged));
    this.registerDisposer(
        segmentsState.temporaryVisibleSegments.changed.add(visibleSegmentsChanged));
    this.visibleSegmentsChanged();
  }

  computeSplit(include: Uint64, exclude: Uint64): ComputedSplit|undefined {
    const {segmentEquivalences} = this.segmentsState;
    const graphSegment = segmentEquivalences.get(include);
    if (isBaseSegmentId(graphSegment)) return undefined;
    if (!Uint64.equal(segmentEquivalences.get(exclude), graphSegment)) return undefined;
    const query = this.segmentQueries.get(graphSegment.toString());
    if (query === undefined) return undefined;
    const {current} = query;
    if (current === undefined) return undefined;
    const {baseSegments, baseSegmentParents} = current;
    let length = baseSegmentParents.length;
    const ds = new DisjointUint64Sets();
    for (let i = 0; i < length; ++i) {
      let baseSegment = baseSegments[i];
      let parent = baseSegmentParents[i];
      if (Uint64.equal(baseSegment, exclude) || Uint64.equal(parent, exclude)) continue;
      ds.link(baseSegment, parent);
      console.log(`Linking ${baseSegment} - ${parent} == ${include}? ${
          Uint64.equal(
              include, baseSegment)} ${Uint64.equal(include, parent)} :: unioned with include = ${
          Uint64.equal(
              include,
              ds.get(baseSegment))}, with exclude = ${Uint64.equal(exclude, ds.get(baseSegment))}`);
    }
    const includeSegments: Uint64[] = [];
    const excludeSegments: Uint64[] = [];
    const includeRep = ds.get(include);
    for (const segment of baseSegments) {
      if (Uint64.equal(ds.get(segment), includeRep)) {
        includeSegments.push(segment);
      } else {
        excludeSegments.push(segment);
      }
    }
    console.log('include = ' + includeSegments.map(x => x.toString()).join(','));
    console.log('exclude = ' + excludeSegments.map(x => x.toString()).join(','));
    return {
      includeRepresentative: graphSegment,
      includeBaseSegments: includeSegments,
      excludeRepresentative: UNKNOWN_NEW_SEGMENT_ID,
      excludeBaseSegments: excludeSegments
    };
  }


  private debouncedVisibleSegmentsChanged =
      this.registerCancellable(debounce(() => this.visibleSegmentsChanged(), 0));

  private segmentQueries = new Map<SegmentIdString, ActiveSegmentQuery>();

  private ignoreVisibleSegmentsChanged = false;

  private segmentEquivalencesChanged = this.registerCancellable(debounce(() => {
    this.debouncedVisibleSegmentsChanged.flush();
    this.segmentEquivalencesChanged.cancel();
    const {segmentQueries} = this;
    const {segmentEquivalences} = this.segmentsState;
    segmentEquivalences.clear();
    for (const [segmentIdString, query] of segmentQueries) {
      segmentIdString;
      if (query.current === undefined || isBaseSegmentId(query.id)) continue;
      const {id, baseSegments} = query.current;
      if (baseSegments.length > 0) {
        for (const segmentId of baseSegments) {
          segmentEquivalences.link(segmentId, id);
        }
        query.addedEquivalences = true;
      } else {
        query.addedEquivalences = false;
      }
    }
  }, 0));

  private registerVisibleSegment(segmentId: Uint64) {
    const query: ActiveSegmentQuery = {
      id: segmentId,
      current: undefined,
      addedEquivalences: false,
      seenGeneration: updateGeneration,
      disposer: this.graph.watchSegment(
          segmentId, info => this.handleSegmentUpdate(query.id.toString(), info)),
    };
    const segmentIdString = segmentId.toString();
    this.segmentQueries.set(segmentIdString, query);
    console.log(`adding to segmentQueries: ${segmentIdString}`);
  }

  private handleSegmentUpdate(segmentIdString: SegmentIdString, update: GraphSegmentUpdate) {
    console.log(`handleSegmentUpdate: ${segmentIdString}`);
    const query = this.segmentQueries.get(segmentIdString)!;
    if (update === 'invalid') {
      query.disposer();
      console.log(`removing from segmentQueries: ${segmentIdString} due to invalid`);
      this.segmentQueries.delete(segmentIdString);
      try {
        this.ignoreVisibleSegmentsChanged = true;
        this.segmentsState.visibleSegments.delete(query.id);
        this.segmentsState.temporaryVisibleSegments.delete(query.id);
      } finally {
        this.ignoreVisibleSegmentsChanged = false;
      }
      if (query.addedEquivalences) {
        this.segmentEquivalencesChanged();
      }
      return;
    }
    if (update === 'error') {
      query.current = undefined;
      if (query.addedEquivalences) {
        this.segmentEquivalencesChanged();
      }
      console.log(
          `Error from ${this.graph.serverUrl}/${this.graph.entityName}` +
          ` watching segment ${segmentIdString}`);
      return;
    }
    query.current = update;
    const oldId = query.id;
    const newId = update.id;
    if (!Uint64.equal(newId, oldId)) {
      query.id = newId;
      let newSegmentIdString = newId.toString();
      let newQuery = this.segmentQueries.get(newSegmentIdString);
      console.log(`removing from segmentQueries: ${segmentIdString} due to rename -> ${newId}`);
      this.segmentQueries.delete(segmentIdString);
      try {
        this.ignoreVisibleSegmentsChanged = true;
        if (this.segmentsState.visibleSegments.has(oldId)) {
          this.segmentsState.visibleSegments.delete(oldId);
          this.segmentsState.visibleSegments.add(newId);
        }
        if (this.segmentsState.temporaryVisibleSegments.has(oldId)) {
          this.segmentsState.temporaryVisibleSegments.delete(oldId);
          this.segmentsState.temporaryVisibleSegments.add(newId);
        }
      } finally {
        this.ignoreVisibleSegmentsChanged = false;
      }
      if (newQuery === undefined) {
        console.log(`adding to segmentQueries due to rename -> ${newId}`);
        this.segmentQueries.set(newSegmentIdString, query);
        this.segmentEquivalencesChanged();
      } else {
        if (update.lastLogId !== null &&
            (typeof newQuery.current !== 'object' || newQuery.current.lastLogId === null ||
             Uint64.less(newQuery.current.lastLogId, update.lastLogId))) {
          newQuery.current = update;
          this.segmentEquivalencesChanged();
        }
        query.disposer();
      }
    } else {
      query.current = update;
      if (!isBaseSegmentId(query.id)) {
        this.segmentEquivalencesChanged();
      }
    }
  }

  private visibleSegmentsChanged() {
    const {segmentsState} = this;
    const {segmentQueries} = this;
    const generation = ++updateGeneration;
    const processVisibleSegments = (visibleSegments: Uint64Set) => {
      for (const segmentId of visibleSegments) {
        if (Uint64.equal(segmentId, UNKNOWN_NEW_SEGMENT_ID)) continue;
        const segmentIdString = segmentId.toString();
        const existingQuery = segmentQueries.get(segmentIdString);
        if (existingQuery !== undefined) {
          existingQuery.seenGeneration = generation;
          continue;
        }
        this.registerVisibleSegment(segmentId.clone());
      }
    };
    processVisibleSegments(segmentsState.visibleSegments);
    processVisibleSegments(segmentsState.temporaryVisibleSegments);
    for (const [segmentIdString, query] of segmentQueries) {
      if (query.seenGeneration !== generation) {
        console.log(`removing from segmentQueries due to seenGeneration: ${segmentIdString}`);
        segmentQueries.delete(segmentIdString);
        query.disposer();
        if (query.addedEquivalences) {
          this.segmentEquivalencesChanged();
        }
      }
    }
  }
}

type GraphSegmentUpdateCallback = (info: GraphSegmentUpdate) => void;

interface WatchInfo {
  callback: GraphSegmentUpdateCallback;
  segment: Uint64;
  watchId: number;
}

export class NggraphSegmentationGraphSource extends SegmentationGraphSource {
  private startingWebsocket = false;
  private websocket: WebSocket|undefined = undefined;
  private watchesById = new Map<number, WatchInfo>();
  private watches = new Set<WatchInfo>();
  private nextWatchId = 0;
  private numOpenFailures = 0;

  constructor(
      public chunkManager: ChunkManager, public serverUrl: string, public entityName: string) {
    super();
  }

  get highBitRepresentative() {
    return true;
  }

  private startWebsocket() {
    if (this.startingWebsocket) return;
    if (this.watches.size === 0) return;
    this.startingWebsocket = true;
    let status: StatusMessage|undefined = new StatusMessage(this.numOpenFailures ? false : true);
    status.setText(
        `Opening websocket connection for nggraph://${this.serverUrl}/${this.entityName}`);
    (async () => {
      const {numOpenFailures} = this;
      if (numOpenFailures > 1) {
        const delay = 1000 * Math.min(16, 2 ** numOpenFailures);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      const credentials =
          (await getEntityCredentialsProvider(this.chunkManager, this.serverUrl, this.entityName)
               .get())
              .credentials;
      let url = new URL('/graph/watch/' + encodeURIComponent(credentials.token), this.serverUrl);
      url.protocol = url.protocol.replace('http', 'ws');
      const websocket = new WebSocket(url.href);
      websocket.onclose = () => {
        if (status !== undefined) {
          status.dispose();
          status = undefined;
        }
        ++this.numOpenFailures;
        this.websocket = undefined;
        this.startingWebsocket = false;
        this.watchesById.clear();
        this.startWebsocket();
      };
      websocket.onopen = () => {
        if (status !== undefined) {
          status.dispose();
          status = undefined;
        }
        this.numOpenFailures = 0;
        this.websocket = websocket;
        this.nextWatchId = 0;
        try {
          for (const watchInfo of this.watches) {
            websocket.send(JSON.stringify({'watch': {'segment_id': watchInfo.segment.toString()}}));
            let watchId = this.nextWatchId++;
            watchInfo.watchId = watchId;
            this.watchesById.set(watchId, watchInfo);
          }
        } catch {
          // Ignore send error, which indicates the connection has been closed.  The close handler
          // already deals with this case.
        }
      };
      websocket.onmessage = ev => {
        let update: GraphSegmentUpdate;
        let watchInfo: WatchInfo;
        try {
          const msg = JSON.parse(ev.data);
          verifyObject(msg);
          const watchId = verifyObjectProperty(msg, 'watch_id', verifyInt);
          const w = this.watchesById.get(watchId);
          if (w === undefined) {
            // Watch has already been cancelled.
            return;
          }
          watchInfo = w;
          const state = verifyObjectProperty(msg, 'state', verifyString);
          if (state === 'invalid' || state === 'error') {
            update = state;
          } else {
            update = verifyObjectProperty(msg, 'info', parseGraphSegmentInfo);
          }
        } catch (e) {
          console.log(`Received unexpected websocket message from ${this.serverUrl}:`, ev.data, e);
          return;
        }
        console.log('got update', update);
        watchInfo.callback(update);
      };
    })();
  }

  connect(segmentsState: VisibleSegmentsState) {
    return new GraphConnection(this, segmentsState);
  }

  trackSegment(id: Uint64, callback: (id: Uint64|null) => void): () => void {
    return this.watchSegment(id, (info: GraphSegmentUpdate) => {
      if (info === 'invalid') {
        callback(null);
      } else if (info === 'error') {
        // Ignore errors.
        return;
      } else {
        callback(info.id);
      }
    });
  }

  watchSegment(segment: Uint64, callback: GraphSegmentUpdateCallback): () => void {
    let watchInfo = {
      callback,
      segment,
      watchId: -1,
    };
    this.watches.add(watchInfo);
    const {websocket} = this;
    if (websocket !== undefined) {
      try {
        websocket.send(JSON.stringify({'watch': {'segment_id': segment.toString()}}));
        let watchId = this.nextWatchId++;
        watchInfo.watchId = watchId;
        this.watchesById.set(watchId, watchInfo);
      } catch {
        // Ignore send error, which indicates the connection has been closed.  The close handler
        // already deals with this case.
      }
    } else {
      this.startWebsocket();
    }
    const disposer = () => {
      const {websocket} = this;
      if (websocket !== undefined && websocket.readyState === WebSocket.OPEN) {
        const watchId = watchInfo.watchId;
        this.watchesById.delete(watchId);
        try {
          websocket.send(JSON.stringify({'unwatch': {'watch_id': watchId}}));
        } catch {
          // Ignore send error, which indicates the connection has been closed.  The close handler
          // already deals with this case.
        }
      }
      this.watches.delete(watchInfo);
    };
    return disposer;
  }

  async merge(a: Uint64, b: Uint64): Promise<Uint64> {
    let response = await nggraphGraphFetch(
        this.chunkManager, this.serverUrl, this.entityName, '/graph/mutate', {
          body: JSON.stringify({
            merge: {anchor: a.toString(), other: b.toString()},
          }),
          headers: {'Content-Type': 'application/json'},
          method: 'POST',
        });
    verifyObject(response);
    return verifyObjectProperty(response, 'merged', x => Uint64.parseString(x));
  }

  async split(include: Uint64, exclude: Uint64): Promise<{include: Uint64, exclude: Uint64}> {
    let response = await nggraphGraphFetch(
        this.chunkManager, this.serverUrl, this.entityName, '/graph/mutate', {
          body: JSON.stringify({
            split: {include: include.toString(), exclude: exclude.toString()},
          }),
          headers: {'Content-Type': 'application/json'},
          method: 'POST',
        });
    verifyObject(response);
    return {
      include: verifyObjectProperty(response, 'include', x => Uint64.parseString(x)),
      exclude: verifyObjectProperty(response, 'exclude', x => Uint64.parseString(x)),
    };
  }
}

function parseNggraphUrl(providerUrl: string) {
  const m = providerUrl.match(urlPattern);
  if (m === null) {
    throw new Error(`Invalid nggraph url: ${JSON.stringify(providerUrl)}`)
  }
  return {serverUrl: m[1], id: m[2]};
}

function fetchWithNggraphCredentials(
    credentialsProvider: CredentialsProvider<Credentials>, serverUrl: string, path: string,
    init: RequestInit, cancellationToken: CancellationToken = uncancelableToken): Promise<any> {
  return fetchWithCredentials(
      credentialsProvider, `${serverUrl}${path}`, init, responseJson,
      (credentials, init) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', credentials.token);
        return {...init, headers};
      },
      error => {
        const {status} = error;
        if (status === 401) return 'refresh';
        throw error;
      },
      cancellationToken);
}

interface EntityCredentials extends Credentials {
  role: string;
  entityType: string;
}

function nggraphServerFetch(
    chunkManager: ChunkManager, serverUrl: string, path: string, init: RequestInit,
    cancellationToken: CancellationToken = uncancelableToken): Promise<any> {
  return fetchWithNggraphCredentials(
      getCredentialsProvider(chunkManager, serverUrl), serverUrl, path, init, cancellationToken);
}

class NggraphEntityCredentialsProvider extends CredentialsProvider<EntityCredentials> {
  constructor(
      public parentCredentialsProvider: CredentialsProvider<Credentials>, public serverUrl: string,
      public entityName: string) {
    super();
  }

  get = makeCredentialsGetter(async () => {
    let response = await fetchWithNggraphCredentials(
        this.parentCredentialsProvider, this.serverUrl, '/entity_token', {
          body: JSON.stringify({entity: this.entityName}),
          headers: {'Content-Type': 'application/json'},
          method: 'POST',
        });
    return {token: response['token'], entityType: response['entity_type'], role: response['role']};
  });
}

function getCredentialsProvider(chunkManager: ChunkManager, serverUrl: string) {
  return chunkManager.memoize.getUncounted(
      {'type': 'nggraph:credentialsProvider', serverUrl},
      () => new NggraphCredentialsProvider(serverUrl));
}


function getEntityCredentialsProvider(
    chunkManager: ChunkManager, serverUrl: string, entityName: string) {
  return chunkManager.memoize.getUncounted(
      {'type': 'nggraph:entityCredentialsProvider', serverUrl, entityName},
      () => new NggraphEntityCredentialsProvider(
          getCredentialsProvider(chunkManager, serverUrl), serverUrl, entityName));
}

function nggraphGraphFetch(
    chunkManager: ChunkManager, serverUrl: string, entityName: string, path: string,
    init: RequestInit, cancellationToken: CancellationToken = uncancelableToken): Promise<any> {
  return fetchWithNggraphCredentials(
      getEntityCredentialsProvider(chunkManager, serverUrl, entityName), serverUrl, path, init,
      cancellationToken);
}

function parseListResponse(response: any) {
  verifyObject(response);
  return verifyObjectProperty(
      response, 'entities',
      entries => parseArray(entries, entry => {
        verifyObject(entry);
        const id = verifyObjectProperty(entry, 'entity', verifyString);
        const entityType = verifyObjectProperty(entry, 'entity_type', verifyString);
        const accessRole = verifyObjectProperty(entry, 'access_role', verifyString);
        return {id, entityType, accessRole};
      }));
}

export class NggraphDataSource extends DataSourceProvider {
  get description() {
    return 'nggraph data source';
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const {serverUrl, id} = parseNggraphUrl(options.providerUrl);
    return options.chunkManager.memoize.getUncounted(
        {'type': 'nggraph:get', serverUrl, id}, async(): Promise<DataSource> => {
          let entityCredentialsProvider =
              getEntityCredentialsProvider(options.chunkManager, serverUrl, id);
          const {entityType} = (await entityCredentialsProvider.get()).credentials;
          if (entityType != 'graph') {
            throw new Error(`Unsupported entity type: ${JSON.stringify(entityType)}`);
          }
          const {datasource_url: baseSegmentation} = await nggraphGraphFetch(
              options.chunkManager, serverUrl, id, '/graph/config', {method: 'POST'});
          let baseSegmentationDataSource =
              await options.registry.get({...options, url: baseSegmentation});
          const segmentationGraph =
              new NggraphSegmentationGraphSource(options.chunkManager, serverUrl, id);
          const subsources: DataSubsourceEntry[] = [
            ...baseSegmentationDataSource.subsources,
            {
              id: 'graph',
              default: true,
              subsource: {segmentationGraph},
            },
          ];
          const dataSource: DataSource = {
            modelTransform: baseSegmentationDataSource.modelTransform,
            subsources,
          };
          return dataSource;
        });
  }

  async completeUrl(options: CompleteUrlOptions): Promise<CompletionResult> {
    const {serverUrl, id} = parseNggraphUrl(options.providerUrl);
    const list = await options.chunkManager.memoize.getUncounted(
        {'type': 'nggraph:list', serverUrl}, async () => {
          return parseListResponse(
              await nggraphServerFetch(options.chunkManager, serverUrl, '/list', {method: 'POST'}));
        });
    return {
      offset: serverUrl.length + 1,
      completions: getPrefixMatchesWithDescriptions(
          id, list, entry => entry.id, entry => `${entry.entityType} (${entry.accessRole})`),
    };
  }
}
