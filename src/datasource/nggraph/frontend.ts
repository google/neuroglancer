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

import { debounce } from "lodash-es";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { fetchOkWithCredentials } from "#src/credentials_provider/http_request.js";
import {
  CredentialsProvider,
  makeCredentialsGetter,
} from "#src/credentials_provider/index.js";
import type {
  CompleteUrlOptions,
  CompletionResult,
  DataSource,
  DataSubsourceEntry,
  GetDataSourceOptions,
  DataSourceProvider,
} from "#src/datasource/index.js";
import type { Credentials } from "#src/datasource/nggraph/credentials_provider.js";
import { NggraphCredentialsProvider } from "#src/datasource/nggraph/credentials_provider.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import {
  isBaseSegmentId,
  UNKNOWN_NEW_SEGMENT_ID,
  VisibleSegmentEquivalencePolicy,
} from "#src/segmentation_graph/segment_id.js";
import type { ComputedSplit } from "#src/segmentation_graph/source.js";
import {
  SegmentationGraphSource,
  SegmentationGraphSourceConnection,
} from "#src/segmentation_graph/source.js";
import { StatusMessage } from "#src/status.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { getPrefixMatchesWithDescriptions } from "#src/util/completion.js";
import { DisjointUint64Sets } from "#src/util/disjoint_sets.js";
import type { RequestInitWithProgress } from "#src/util/http_request.js";
import {
  parseArray,
  parseUint64,
  verifyFiniteFloat,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";

const urlPattern = "^(https?://[^/]+)/(.*)$";

interface GraphSegmentInfo {
  id: bigint;
  baseSegments: bigint[];
  baseSegmentParents: bigint[];
  name: string;
  tags: string[];
  numVoxels: number;
  bounds: number[];
  lastLogId: bigint | null;
}

function parseGraphSegmentInfo(obj: any): GraphSegmentInfo {
  verifyObject(obj);
  return {
    id: verifyObjectProperty(obj, "id", parseUint64),
    baseSegments: verifyObjectProperty(obj, "base_segment_ids", (x) =>
      parseArray(x, parseUint64),
    ),
    baseSegmentParents: verifyObjectProperty(
      obj,
      "base_segment_parent_ids",
      (x) => parseArray(x, parseUint64),
    ),
    name: verifyObjectProperty(obj, "name", verifyString),
    tags: verifyObjectProperty(obj, "tags", verifyStringArray),
    numVoxels: verifyObjectProperty(obj, "num_voxels", verifyInt),
    bounds: verifyObjectProperty(obj, "bounds", (x) =>
      parseArray(x, (y) => verifyFiniteFloat(y)),
    ),
    lastLogId: verifyObjectProperty(obj, "last_log_id", (x) =>
      x == null ? null : parseUint64(x),
    ),
  };
}

interface ActiveSegmentQuery {
  id: bigint;
  current: GraphSegmentInfo | undefined;
  addedEquivalences: boolean;
  seenGeneration: number;
  disposer: () => void;
}

type GraphSegmentUpdate = GraphSegmentInfo | "invalid" | "error";

// Generation used for checking if segments have been seen.
let updateGeneration = 0;

class GraphConnection extends SegmentationGraphSourceConnection {
  declare graph: NggraphSegmentationGraphSource;
  constructor(
    graph: NggraphSegmentationGraphSource,
    segmentsState: VisibleSegmentsState,
  ) {
    super(graph, segmentsState);
    const visibleSegmentsChanged = () => {
      if (!this.ignoreVisibleSegmentsChanged) {
        this.debouncedVisibleSegmentsChanged();
      }
    };
    this.registerDisposer(
      segmentsState.visibleSegments.changed.add(visibleSegmentsChanged),
    );
    this.registerDisposer(
      segmentsState.temporaryVisibleSegments.changed.add(
        visibleSegmentsChanged,
      ),
    );
    this.visibleSegmentsChanged();
  }

  computeSplit(include: bigint, exclude: bigint): ComputedSplit | undefined {
    const { segmentEquivalences } = this.segmentsState;
    const graphSegment = segmentEquivalences.get(include);
    if (isBaseSegmentId(graphSegment)) return undefined;
    if (segmentEquivalences.get(exclude) !== graphSegment) return undefined;
    const query = this.segmentQueries.get(graphSegment);
    if (query === undefined) return undefined;
    const { current } = query;
    if (current === undefined) return undefined;
    const { baseSegments, baseSegmentParents } = current;
    const length = baseSegmentParents.length;
    const ds = new DisjointUint64Sets();
    for (let i = 0; i < length; ++i) {
      const baseSegment = baseSegments[i];
      const parent = baseSegmentParents[i];
      if (baseSegment === exclude || parent === exclude) continue;
      ds.link(baseSegment, parent);
      console.log(
        `Linking ${baseSegment} - ${parent} == ${include}? ${
          include === baseSegment
        } ${include === parent} :: unioned with include = ${
          include === ds.get(baseSegment)
        }, with exclude = ${exclude === ds.get(baseSegment)}`,
      );
    }
    const includeSegments: bigint[] = [];
    const excludeSegments: bigint[] = [];
    const includeRep = ds.get(include);
    for (const segment of baseSegments) {
      if (ds.get(segment) === includeRep) {
        includeSegments.push(segment);
      } else {
        excludeSegments.push(segment);
      }
    }
    console.log(
      "include = " + includeSegments.map((x) => x.toString()).join(","),
    );
    console.log(
      "exclude = " + excludeSegments.map((x) => x.toString()).join(","),
    );
    return {
      includeRepresentative: graphSegment,
      includeBaseSegments: includeSegments,
      excludeRepresentative: UNKNOWN_NEW_SEGMENT_ID,
      excludeBaseSegments: excludeSegments,
    };
  }

  private debouncedVisibleSegmentsChanged = this.registerCancellable(
    debounce(() => this.visibleSegmentsChanged(), 0),
  );

  private segmentQueries = new Map<bigint, ActiveSegmentQuery>();

  private ignoreVisibleSegmentsChanged = false;

  private segmentEquivalencesChanged = this.registerCancellable(
    debounce(() => {
      this.debouncedVisibleSegmentsChanged.flush();
      this.segmentEquivalencesChanged.cancel();
      const { segmentQueries } = this;
      const { segmentEquivalences } = this.segmentsState;
      segmentEquivalences.clear();
      for (const [_segmentId, query] of segmentQueries) {
        if (query.current === undefined || isBaseSegmentId(query.id)) continue;
        const { id, baseSegments } = query.current;
        if (baseSegments.length > 0) {
          for (const segmentId of baseSegments) {
            segmentEquivalences.link(segmentId, id);
          }
          query.addedEquivalences = true;
        } else {
          query.addedEquivalences = false;
        }
      }
    }, 0),
  );

  private registerVisibleSegment(segmentId: bigint) {
    const query: ActiveSegmentQuery = {
      id: segmentId,
      current: undefined,
      addedEquivalences: false,
      seenGeneration: updateGeneration,
      disposer: this.graph.watchSegment(segmentId, (info) =>
        this.handleSegmentUpdate(query.id, info),
      ),
    };
    this.segmentQueries.set(segmentId, query);
    console.log(`adding to segmentQueries: ${segmentId}`);
  }

  private handleSegmentUpdate(segmentId: bigint, update: GraphSegmentUpdate) {
    console.log(`handleSegmentUpdate: ${segmentId}`);
    const query = this.segmentQueries.get(segmentId)!;
    if (update === "invalid") {
      query.disposer();
      console.log(`removing from segmentQueries: ${segmentId} due to invalid`);
      this.segmentQueries.delete(segmentId);
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
    if (update === "error") {
      query.current = undefined;
      if (query.addedEquivalences) {
        this.segmentEquivalencesChanged();
      }
      console.log(
        `Error from ${this.graph.serverUrl}/${this.graph.entityName}` +
          ` watching segment ${segmentId}`,
      );
      return;
    }
    query.current = update;
    const oldId = query.id;
    const newId = update.id;
    if (newId !== oldId) {
      query.id = newId;
      const newQuery = this.segmentQueries.get(newId);
      console.log(
        `removing from segmentQueries: ${segmentId} due to rename -> ${newId}`,
      );
      this.segmentQueries.delete(segmentId);
      try {
        this.ignoreVisibleSegmentsChanged = true;
        if (this.segmentsState.visibleSegments.has(oldId)) {
          this.segmentsState.visibleSegments.add(newId);
        }
        if (this.segmentsState.selectedSegments.has(oldId)) {
          this.segmentsState.selectedSegments.delete(oldId);
          this.segmentsState.selectedSegments.add(newId);
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
        this.segmentQueries.set(newId, query);
        this.segmentEquivalencesChanged();
      } else {
        if (
          update.lastLogId !== null &&
          (typeof newQuery.current !== "object" ||
            newQuery.current.lastLogId === null ||
            newQuery.current.lastLogId < update.lastLogId)
        ) {
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
    const { segmentsState } = this;
    const { segmentQueries } = this;
    const generation = ++updateGeneration;
    const processVisibleSegments = (visibleSegments: Uint64Set) => {
      for (const segmentId of visibleSegments.keys()) {
        if (segmentId === UNKNOWN_NEW_SEGMENT_ID) continue;
        const existingQuery = segmentQueries.get(segmentId);
        if (existingQuery !== undefined) {
          existingQuery.seenGeneration = generation;
          continue;
        }
        this.registerVisibleSegment(segmentId);
      }
    };
    processVisibleSegments(segmentsState.visibleSegments);
    processVisibleSegments(segmentsState.temporaryVisibleSegments);
    for (const [segmentId, query] of segmentQueries) {
      if (query.seenGeneration !== generation) {
        console.log(
          `removing from segmentQueries due to seenGeneration: ${segmentId}`,
        );
        segmentQueries.delete(segmentId);
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
  segment: bigint;
  watchId: number;
}

export class NggraphSegmentationGraphSource extends SegmentationGraphSource {
  private startingWebsocket = false;
  private websocket: WebSocket | undefined = undefined;
  private watchesById = new Map<number, WatchInfo>();
  private watches = new Set<WatchInfo>();
  private nextWatchId = 0;
  private numOpenFailures = 0;

  constructor(
    public chunkManager: ChunkManager,
    public serverUrl: string,
    public entityName: string,
  ) {
    super();
  }

  get visibleSegmentEquivalencePolicy() {
    return (
      VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE |
      VisibleSegmentEquivalencePolicy.REPRESENTATIVE_EXCLUDED
    );
  }

  private startWebsocket() {
    if (this.startingWebsocket) return;
    if (this.watches.size === 0) return;
    this.startingWebsocket = true;
    let status: StatusMessage | undefined = new StatusMessage(
      this.numOpenFailures ? false : true,
    );
    status.setText(
      `Opening websocket connection for nggraph://${this.serverUrl}/${this.entityName}`,
    );
    (async () => {
      const { numOpenFailures } = this;
      if (numOpenFailures > 1) {
        const delay = 1000 * Math.min(16, 2 ** numOpenFailures);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const credentials = (
        await getEntityCredentialsProvider(
          this.chunkManager,
          this.serverUrl,
          this.entityName,
        ).get()
      ).credentials;
      const url = new URL(
        "/graph/watch/" + encodeURIComponent(credentials.token),
        this.serverUrl,
      );
      url.protocol = url.protocol.replace("http", "ws");
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
            websocket.send(
              JSON.stringify({
                watch: { segment_id: watchInfo.segment.toString() },
              }),
            );
            const watchId = this.nextWatchId++;
            watchInfo.watchId = watchId;
            this.watchesById.set(watchId, watchInfo);
          }
        } catch {
          // Ignore send error, which indicates the connection has been closed.  The close handler
          // already deals with this case.
        }
      };
      websocket.onmessage = (ev) => {
        let update: GraphSegmentUpdate;
        let watchInfo: WatchInfo;
        try {
          const msg = JSON.parse(ev.data);
          verifyObject(msg);
          const watchId = verifyObjectProperty(msg, "watch_id", verifyInt);
          const w = this.watchesById.get(watchId);
          if (w === undefined) {
            // Watch has already been cancelled.
            return;
          }
          watchInfo = w;
          const state = verifyObjectProperty(msg, "state", verifyString);
          if (state === "invalid" || state === "error") {
            update = state;
          } else {
            update = verifyObjectProperty(msg, "info", parseGraphSegmentInfo);
          }
        } catch (e) {
          console.log(
            `Received unexpected websocket message from ${this.serverUrl}:`,
            ev.data,
            e,
          );
          return;
        }
        console.log("got update", update);
        watchInfo.callback(update);
      };
    })();
  }

  connect(layer: SegmentationUserLayer) {
    const segmentsState = layer.displayState.segmentationGroupState.value;
    return new GraphConnection(this, segmentsState);
  }

  trackSegment(id: bigint, callback: (id: bigint | null) => void): () => void {
    return this.watchSegment(id, (info: GraphSegmentUpdate) => {
      if (info === "invalid") {
        callback(null);
      } else if (info === "error") {
        // Ignore errors.
        return;
      } else {
        callback(info.id);
      }
    });
  }

  watchSegment(
    segment: bigint,
    callback: GraphSegmentUpdateCallback,
  ): () => void {
    const watchInfo = {
      callback,
      segment,
      watchId: -1,
    };
    this.watches.add(watchInfo);
    const { websocket } = this;
    if (websocket !== undefined) {
      try {
        websocket.send(
          JSON.stringify({ watch: { segment_id: segment.toString() } }),
        );
        const watchId = this.nextWatchId++;
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
      const { websocket } = this;
      if (websocket !== undefined && websocket.readyState === WebSocket.OPEN) {
        const watchId = watchInfo.watchId;
        this.watchesById.delete(watchId);
        try {
          websocket.send(JSON.stringify({ unwatch: { watch_id: watchId } }));
        } catch {
          // Ignore send error, which indicates the connection has been closed.  The close handler
          // already deals with this case.
        }
      }
      this.watches.delete(watchInfo);
    };
    return disposer;
  }

  async merge(a: bigint, b: bigint): Promise<bigint> {
    const response = await nggraphGraphFetch(
      this.chunkManager,
      this.serverUrl,
      this.entityName,
      "/graph/mutate",
      {
        body: JSON.stringify({
          merge: { anchor: a.toString(), other: b.toString() },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    verifyObject(response);
    return verifyObjectProperty(response, "merged", parseUint64);
  }

  async split(
    include: bigint,
    exclude: bigint,
  ): Promise<{ include: bigint; exclude: bigint }> {
    const response = await nggraphGraphFetch(
      this.chunkManager,
      this.serverUrl,
      this.entityName,
      "/graph/mutate",
      {
        body: JSON.stringify({
          split: { include: include.toString(), exclude: exclude.toString() },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    verifyObject(response);
    return {
      include: verifyObjectProperty(response, "include", parseUint64),
      exclude: verifyObjectProperty(response, "exclude", parseUint64),
    };
  }
}

function parseNggraphUrl(providerUrl: string) {
  const m = providerUrl.match(urlPattern);
  if (m === null) {
    throw new Error(`Invalid nggraph url: ${JSON.stringify(providerUrl)}`);
  }
  return { serverUrl: m[1], id: m[2] };
}

function fetchWithNggraphCredentials(
  credentialsProvider: CredentialsProvider<Credentials>,
  serverUrl: string,
  path: string,
  init: RequestInit,
): Promise<any> {
  return fetchOkWithCredentials(
    credentialsProvider,
    `${serverUrl}${path}`,
    init,
    (credentials, init) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", credentials.token);
      return { ...init, headers };
    },
    (error) => {
      const { status } = error;
      if (status === 401) return "refresh";
      throw error;
    },
  ).then((response) => response.json());
}

interface EntityCredentials extends Credentials {
  role: string;
  entityType: string;
}

function nggraphServerFetch(
  chunkManager: ChunkManager,
  serverUrl: string,
  path: string,
  init: RequestInit,
): Promise<any> {
  return fetchWithNggraphCredentials(
    getCredentialsProvider(chunkManager, serverUrl),
    serverUrl,
    path,
    init,
  );
}

class NggraphEntityCredentialsProvider extends CredentialsProvider<EntityCredentials> {
  constructor(
    public parentCredentialsProvider: CredentialsProvider<Credentials>,
    public serverUrl: string,
    public entityName: string,
  ) {
    super();
  }

  get = makeCredentialsGetter(async () => {
    const response = await fetchWithNggraphCredentials(
      this.parentCredentialsProvider,
      this.serverUrl,
      "/entity_token",
      {
        body: JSON.stringify({ entity: this.entityName }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    return {
      token: response.token,
      entityType: response.entity_type,
      role: response.role,
    };
  });
}

function getCredentialsProvider(chunkManager: ChunkManager, serverUrl: string) {
  return chunkManager.memoize.getUncounted(
    { type: "nggraph:credentialsProvider", serverUrl },
    () => new NggraphCredentialsProvider(serverUrl),
  );
}

function getEntityCredentialsProvider(
  chunkManager: ChunkManager,
  serverUrl: string,
  entityName: string,
) {
  return chunkManager.memoize.getUncounted(
    { type: "nggraph:entityCredentialsProvider", serverUrl, entityName },
    () =>
      new NggraphEntityCredentialsProvider(
        getCredentialsProvider(chunkManager, serverUrl),
        serverUrl,
        entityName,
      ),
  );
}

function nggraphGraphFetch(
  chunkManager: ChunkManager,
  serverUrl: string,
  entityName: string,
  path: string,
  init: RequestInitWithProgress,
): Promise<any> {
  return fetchWithNggraphCredentials(
    getEntityCredentialsProvider(chunkManager, serverUrl, entityName),
    serverUrl,
    path,
    init,
  );
}

function parseListResponse(response: any) {
  verifyObject(response);
  return verifyObjectProperty(response, "entities", (entries) =>
    parseArray(entries, (entry) => {
      verifyObject(entry);
      const id = verifyObjectProperty(entry, "entity", verifyString);
      const entityType = verifyObjectProperty(
        entry,
        "entity_type",
        verifyString,
      );
      const accessRole = verifyObjectProperty(
        entry,
        "access_role",
        verifyString,
      );
      return { id, entityType, accessRole };
    }),
  );
}

export class NggraphDataSource implements DataSourceProvider {
  get scheme() {
    return "nggraph";
  }
  get description() {
    return "nggraph data source";
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const { serverUrl, id } = parseNggraphUrl(options.providerUrl);
    return options.registry.chunkManager.memoize.getAsync(
      { type: "nggraph:get", serverUrl, id },
      options,
      async (progressOptions): Promise<DataSource> => {
        const entityCredentialsProvider = getEntityCredentialsProvider(
          options.registry.chunkManager,
          serverUrl,
          id,
        );
        const { entityType } = (
          await entityCredentialsProvider.get(undefined, progressOptions)
        ).credentials;
        if (entityType !== "graph") {
          throw new Error(
            `Unsupported entity type: ${JSON.stringify(entityType)}`,
          );
        }
        const { datasource_url: baseSegmentation } = await nggraphGraphFetch(
          options.registry.chunkManager,
          serverUrl,
          id,
          "/graph/config",
          { method: "POST", ...progressOptions },
        );
        const baseSegmentationDataSource = await options.registry.get({
          ...options,
          url: baseSegmentation,
        });
        const segmentationGraph = new NggraphSegmentationGraphSource(
          options.registry.chunkManager,
          serverUrl,
          id,
        );
        const subsources: DataSubsourceEntry[] = [
          ...baseSegmentationDataSource.subsources,
          {
            id: "graph",
            default: true,
            subsource: { segmentationGraph },
          },
        ];
        const dataSource: DataSource = {
          modelTransform: baseSegmentationDataSource.modelTransform,
          subsources,
        };
        return dataSource;
      },
    );
  }

  async completeUrl(options: CompleteUrlOptions): Promise<CompletionResult> {
    const { serverUrl, id } = parseNggraphUrl(options.providerUrl);
    const list = await options.registry.chunkManager.memoize.getAsync(
      { type: "nggraph:list", serverUrl },
      options,
      async (progressOptions) => {
        return parseListResponse(
          await nggraphServerFetch(
            options.registry.chunkManager,
            serverUrl,
            "/list",
            {
              method: "POST",
              ...progressOptions,
            },
          ),
        );
      },
    );
    return {
      offset: serverUrl.length + 1,
      completions: getPrefixMatchesWithDescriptions(
        id,
        list,
        (entry) => entry.id,
        (entry) => `${entry.entityType} (${entry.accessRole})`,
      ),
    };
  }
}
