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

import type {
  CoordinateSpace,
  CoordinateTransformSpecification,
} from "#src/coordinate_transform.js";
import {
  coordinateTransformSpecificationFromJson,
  coordinateTransformSpecificationToJson,
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type {
  DataSource,
  DataSourceSpecification,
  DataSourceWithRedirectInfo,
  DataSubsourceEntry,
  DataSubsourceSpecification,
} from "#src/datasource/index.js";
import { makeEmptyDataSourceSpecification } from "#src/datasource/index.js";
import type { UserLayer } from "#src/layer/index.js";
import { getWatchableRenderLayerTransform } from "#src/render_coordinate_transform.js";
import type { RenderLayer } from "#src/renderlayer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { arraysEqual } from "#src/util/array.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { disposableOnce, RefCounted } from "#src/util/disposable.js";
import { formatErrorMessage } from "#src/util/error.js";
import {
  verifyBoolean,
  verifyObject,
  verifyObjectAsMap,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import { MessageList, MessageSeverity } from "#src/util/message_list.js";
import { MultiConsumerProgressListener } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";

export function parseDataSubsourceSpecificationFromJson(
  json: unknown,
): DataSubsourceSpecification {
  if (typeof json === "boolean") {
    return { enabled: json };
  }
  verifyObject(json);
  return {
    enabled: verifyOptionalObjectProperty(json, "enabled", verifyBoolean),
  };
}

export function layerDataSourceSpecificationFromJson(
  obj: unknown,
  legacyTransform: CoordinateTransformSpecification | undefined = undefined,
): DataSourceSpecification {
  if (typeof obj === "string") {
    return {
      url: obj,
      transform: legacyTransform,
      enableDefaultSubsources: true,
      subsources: new Map(),
    };
  }
  verifyObject(obj);
  return {
    url: verifyObjectProperty(obj, "url", verifyString),
    transform:
      verifyObjectProperty(
        obj,
        "transform",
        coordinateTransformSpecificationFromJson,
      ) || legacyTransform,
    enableDefaultSubsources: verifyOptionalObjectProperty(
      obj,
      "enableDefaultSubsources",
      verifyBoolean,
      true,
    ),
    subsources: verifyOptionalObjectProperty(
      obj,
      "subsources",
      (subsourcesObj) =>
        verifyObjectAsMap(
          subsourcesObj,
          parseDataSubsourceSpecificationFromJson,
        ),
      new Map<string, DataSubsourceSpecification>(),
    ),
    state: verifyOptionalObjectProperty(obj, "state", verifyObject),
  };
}

function dataSubsourceSpecificationToJson(spec: DataSubsourceSpecification) {
  return spec.enabled;
}

export function layerDataSourceSpecificationToJson(
  spec: DataSourceSpecification,
) {
  const transform = coordinateTransformSpecificationToJson(spec.transform);
  const subsourcesJson: any = {};
  let emptySubsources = true;
  for (const [id, subsource] of spec.subsources) {
    const j = dataSubsourceSpecificationToJson(subsource);
    if (j !== undefined) {
      subsourcesJson[id] = j;
      emptySubsources = false;
    }
  }
  if (
    transform === undefined &&
    emptySubsources &&
    spec.enableDefaultSubsources === true &&
    spec.state === undefined
  ) {
    return spec.url;
  }
  return {
    url: spec.url,
    transform,
    subsources: emptySubsources ? undefined : subsourcesJson,
    enableDefaultSubsources:
      spec.enableDefaultSubsources === true ? undefined : false,
    state: spec.state,
  };
}

export class LoadedDataSubsource {
  subsourceToModelSubspaceTransform: Float32Array;
  modelSubspaceDimensionIndices: number[];
  enabled: boolean;
  activated: RefCounted | undefined = undefined;
  guardValues: any[] = [];
  messages = new MessageList();
  isActiveChanged = new NullarySignal();
  constructor(
    public loadedDataSource: LoadedLayerDataSource,
    public subsourceEntry: DataSubsourceEntry,
    public subsourceSpec: DataSubsourceSpecification | undefined,
    public subsourceIndex: number,
    enableDefaultSubsources: boolean,
  ) {
    let enabled: boolean;
    if (subsourceSpec === undefined || subsourceSpec.enabled === undefined) {
      enabled = subsourceEntry.default && enableDefaultSubsources;
    } else {
      enabled = subsourceSpec.enabled;
    }
    const modelRank = loadedDataSource.dataSource.modelTransform.sourceRank;
    let { modelSubspaceDimensionIndices } = subsourceEntry;
    if (modelSubspaceDimensionIndices === undefined) {
      modelSubspaceDimensionIndices = new Array<number>(modelRank);
      for (let i = 0; i < modelRank; ++i) {
        modelSubspaceDimensionIndices[i] = i;
      }
    }
    const {
      subsourceToModelSubspaceTransform = matrix.createIdentity(
        Float32Array,
        modelSubspaceDimensionIndices.length + 1,
      ),
    } = subsourceEntry;
    this.enabled = enabled;
    this.subsourceToModelSubspaceTransform = subsourceToModelSubspaceTransform;
    this.modelSubspaceDimensionIndices = modelSubspaceDimensionIndices;
    this.isActiveChanged.add(
      loadedDataSource.activatedSubsourcesChanged.dispatch,
    );
  }

  activate(callback: (refCounted: RefCounted) => void, ...guardValues: any[]) {
    this.messages.clearMessages();
    if (this.activated !== undefined) {
      if (arraysEqual(guardValues, this.guardValues)) return;
      this.activated.dispose();
    }
    this.guardValues = guardValues;
    const activated = (this.activated = new RefCounted());
    callback(activated);
    this.isActiveChanged.dispatch();
  }

  deactivate(error: string) {
    this.messages.clearMessages();
    this.messages.addMessage({
      severity: MessageSeverity.error,
      message: error,
    });
    const { activated } = this;
    if (activated === undefined) return;
    this.activated = undefined;
    activated.dispose();
    this.isActiveChanged.dispatch();
  }

  addRenderLayer(renderLayer: Owned<RenderLayer>) {
    const activated = this.activated!;
    activated.registerDisposer(
      this.loadedDataSource.layer.addRenderLayer(renderLayer),
    );
    activated.registerDisposer(this.messages.addChild(renderLayer.messages));
  }

  getRenderLayerTransform(
    channelCoordinateSpace?: WatchableValueInterface<CoordinateSpace>,
  ) {
    const activated = this.activated!;
    const { layer, transform } = this.loadedDataSource;
    return activated.registerDisposer(
      getWatchableRenderLayerTransform(
        layer.manager.root.coordinateSpace,
        layer.localPosition.coordinateSpace,
        transform,
        this,
        channelCoordinateSpace,
      ),
    );
  }
}

export class LoadedLayerDataSource extends RefCounted {
  error = undefined;
  enabledSubsourcesChanged = new NullarySignal();
  activatedSubsourcesChanged = new NullarySignal();
  messages = new MessageList();
  transform: WatchableCoordinateSpaceTransform;
  subsources: LoadedDataSubsource[];
  enableDefaultSubsources: boolean;
  get enabledSubsources() {
    return this.subsources.filter((x) => x.enabled);
  }
  get layer() {
    return this.layerDataSource.layer;
  }
  constructor(
    public layerDataSource: LayerDataSource,
    public dataSource: DataSource,
    spec: DataSourceSpecification,
  ) {
    super();
    if (dataSource.canChangeModelSpaceRank) {
      this.transform = new WatchableCoordinateSpaceTransform(
        makeIdentityTransform(
          makeCoordinateSpace({
            rank: 0,
            scales: new Float64Array(0),
            units: [],
            names: [],
          }),
        ),
        true,
      );
      this.transform.value = dataSource.modelTransform;
    } else {
      this.transform = new WatchableCoordinateSpaceTransform(
        dataSource.modelTransform,
      );
    }
    if (spec.transform !== undefined) {
      this.transform.spec = spec.transform;
    }
    const subsourceSpecs = spec.subsources;
    this.enableDefaultSubsources = spec.enableDefaultSubsources;
    this.subsources = dataSource.subsources.map(
      (subsourceEntry, subsourceIndex): LoadedDataSubsource =>
        new LoadedDataSubsource(
          this,
          subsourceEntry,
          subsourceSpecs.get(subsourceEntry.id),
          subsourceIndex,
          this.enableDefaultSubsources,
        ),
    );
  }

  disposed() {
    for (const subsource of this.subsources) {
      const { activated } = subsource;
      if (activated !== undefined) {
        subsource.activated = undefined;
        activated.dispose();
      }
    }
  }
}

export type LayerDataSourceLoadState =
  | {
      error: Error;
    }
  | LoadedLayerDataSource
  | undefined;

export class LayerDataSource extends RefCounted {
  changed = new NullarySignal();
  messages = new MessageList();
  progressListener = new MultiConsumerProgressListener();
  private loadState_: LayerDataSourceLoadState = undefined;
  private spec_: DataSourceSpecification;
  private specGeneration = -1;
  private refCounted_: RefCounted | undefined = undefined;

  constructor(
    public layer: Borrowed<UserLayer>,
    spec: DataSourceSpecification | undefined = undefined,
  ) {
    super();
    this.registerDisposer(this.changed.add(layer.dataSourcesChanged.dispatch));
    this.registerDisposer(layer.messages.addChild(this.messages));
    if (spec === undefined) {
      this.spec_ = makeEmptyDataSourceSpecification();
    } else {
      this.spec = spec;
    }
  }

  get spec() {
    const { loadState } = this;
    if (loadState !== undefined && loadState.error === undefined) {
      const generation = this.changed.count;
      if (generation !== this.specGeneration) {
        this.specGeneration = generation;
        this.spec_ = {
          url: this.spec.url,
          transform: loadState.transform.spec,
          enableDefaultSubsources: loadState.enableDefaultSubsources,
          subsources: new Map(
            Array.from(loadState.subsources, (loadedSubsource) => {
              const defaultEnabledValue =
                loadState.enableDefaultSubsources &&
                loadedSubsource.subsourceEntry.default;
              return [
                loadedSubsource.subsourceEntry.id,
                {
                  enabled:
                    loadedSubsource.enabled !== defaultEnabledValue
                      ? loadedSubsource.enabled
                      : undefined,
                },
              ];
            }),
          ),
          state: this.spec.state,
        };
      }
    }
    return this.spec_;
  }

  get loadState() {
    return this.loadState_;
  }

  set spec(spec: DataSourceSpecification) {
    const { layer } = this;
    this.messages.clearMessages();
    if (spec.url.length === 0) {
      if (layer.dataSources.length !== 1) {
        const index = layer.dataSources.indexOf(this);
        if (index !== -1) {
          layer.dataSources.splice(index, 1);
          layer.dataSourcesChanged.dispatch();
          this.dispose();
          return;
        }
      }
      this.spec_ = spec;
      if (this.refCounted_ !== undefined) {
        this.refCounted_.dispose();
        this.refCounted_ = undefined;
        this.loadState_ = undefined;
        this.changed.dispatch();
      }
      return;
    }
    const refCounted = new RefCounted();
    const retainer = refCounted.registerDisposer(
      disposableOnce(layer.markLoading()),
    );
    if (this.refCounted_ !== undefined) {
      this.refCounted_.dispose();
      this.loadState_ = undefined;
    }
    this.refCounted_ = refCounted;
    this.spec_ = spec;
    const registry = layer.manager.dataSourceProviderRegistry;
    const abortController = new AbortController();
    registry
      .get({
        url: spec.url,
        signal: abortController.signal,
        globalCoordinateSpace: layer.manager.root.coordinateSpace,
        transform: spec.transform,
        state: spec.state,
        progressListener: this.progressListener,
      })
      .then((source: DataSourceWithRedirectInfo) => {
        if (refCounted.wasDisposed) return;
        this.messages.clearMessages();
        const loaded = refCounted.registerDisposer(
          new LoadedLayerDataSource(this, source, spec),
        );
        loaded.registerDisposer(
          layer.addCoordinateSpace(loaded.transform.outputSpace),
        );
        loaded.registerDisposer(
          loaded.transform.changed.add(this.changed.dispatch),
        );
        this.loadState_ = loaded;
        loaded.registerDisposer(
          loaded.enabledSubsourcesChanged.add(this.changed.dispatch),
        );
        this.changed.dispatch();
        if (source.state) {
          refCounted.registerDisposer(
            source.state.changed.add(() => {
              this.spec.state = source.state?.toJSON();
              layer.specificationChanged.dispatch();
            }),
          );
        }
        const { originalCanonicalUrl } = source;
        const layerType = this.layer.type;
        if (
          (layerType === "auto" || layerType === "new" || spec.setManually) &&
          originalCanonicalUrl !== undefined &&
          originalCanonicalUrl !== spec.url
        ) {
          this.spec = { ...spec, url: originalCanonicalUrl };
        }
        retainer();
      })
      .catch((error) => {
        if (refCounted.wasDisposed) return;
        this.loadState_ = { error };
        this.messages.clearMessages();
        this.messages.addMessage({
          severity: MessageSeverity.error,
          message: formatErrorMessage(error),
        });
        this.changed.dispatch();
      });
    refCounted.registerDisposer(() => {
      abortController.abort();
    });
    this.changed.dispatch();
  }

  disposed() {
    const refCounted = this.refCounted_;
    if (refCounted !== undefined) {
      refCounted.dispose();
    }
  }

  toJSON() {
    const { loadState } = this;
    if (loadState === undefined || loadState.error !== undefined) {
      return layerDataSourceSpecificationToJson(this.spec);
    }
    return layerDataSourceSpecificationToJson({
      url: this.spec.url,
      transform: loadState.transform.spec,
      enableDefaultSubsources: loadState.enableDefaultSubsources,
      subsources: new Map(
        Array.from(loadState.subsources, (loadedSubsource) => {
          const defaultEnabledValue =
            loadState.enableDefaultSubsources &&
            loadedSubsource.subsourceEntry.default;
          return [
            loadedSubsource.subsourceEntry.id,
            {
              enabled:
                loadedSubsource.enabled !== defaultEnabledValue
                  ? loadedSubsource.enabled
                  : undefined,
            },
          ];
        }),
      ),
      state: this.spec.state,
    });
  }
}
