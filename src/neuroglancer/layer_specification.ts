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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {DataSourceProvider, GetVolumeOptions} from 'neuroglancer/datasource';
import {LayerManager, LayerSelectedValues, ManagedUserLayer, UserLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyObject, verifyObjectProperty, verifyOptionalString, verifyString} from 'neuroglancer/util/json';
import {NullarySignal, Signal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import {RPC} from 'neuroglancer/worker_rpc';

export function getVolumeWithStatusMessage(
    dataSourceProvider: DataSourceProvider, chunkManager: ChunkManager, x: string,
    options: GetVolumeOptions = {}): Promise<MultiscaleVolumeChunkSource> {
  return StatusMessage.forPromise(
      new Promise(function(resolve) {
        resolve(dataSourceProvider.getVolume(chunkManager, x, options));
      }),
      {
        initialMessage: `Retrieving metadata for volume ${x}.`,
        delay: true,
        errorPrefix: `Error retrieving metadata for volume ${x}: `,
      });
}

export class ManagedUserLayerWithSpecification extends ManagedUserLayer {
  sourceUrl: string|undefined;

  constructor(
      name: string, public initialSpecification: any, public manager: LayerListSpecification) {
    super(name);
  }

  toJSON() {
    let userLayer = this.layer;
    if (!userLayer) {
      return this.initialSpecification;
    }
    let layerSpec = userLayer.toJSON();
    layerSpec.name = this.name;
    if (!this.visible) {
      layerSpec['visible'] = false;
    }
    return layerSpec;
  }
}

export interface LayerListSpecification extends RefCounted, Trackable {
  changed: NullarySignal;
  voxelCoordinatesSet: Signal<(coordinates: vec3) => void>;
  spatialCoordinatesSet: Signal<(coordinates: vec3) => void>;

  /**
   * @deprecated
   */
  worker: RPC;

  rpc: RPC;

  dataSourceProvider: Borrowed<DataSourceProvider>;
  layerManager: Borrowed<LayerManager>;
  chunkManager: Borrowed<ChunkManager>;
  layerSelectedValues: Borrowed<LayerSelectedValues>;
  voxelSize: Borrowed<VoxelSize>;


  initializeLayerFromSpec(managedLayer: ManagedUserLayerWithSpecification, spec: any): void;

  getLayer(name: string, spec: any): ManagedUserLayerWithSpecification;

  add(layer: Owned<ManagedUserLayer>, index?: number|undefined): void;

  /**
   * Called by user layers to indicate that a voxel position has been selected interactively.
   */
  setVoxelCoordinates(voxelCoordinates: vec3): void;
  setSpatialCoordinates(spatialCoordinates: vec3): void;

  rootLayers: Borrowed<LayerManager>;
}

export class TopLevelLayerListSpecification extends RefCounted implements LayerListSpecification {
  changed = new NullarySignal();
  voxelCoordinatesSet = new Signal<(coordinates: vec3) => void>();
  spatialCoordinatesSet = new Signal<(coordinates: vec3) => void>();

  /**
   * @deprecated
   */
  get worker() {
    return this.chunkManager.rpc!;
  }

  get rpc() {
    return this.chunkManager.rpc!;
  }

  constructor(
      public dataSourceProvider: DataSourceProvider, public layerManager: LayerManager,
      public chunkManager: ChunkManager, public layerSelectedValues: LayerSelectedValues,
      public voxelSize: VoxelSize) {
    super();
    this.registerDisposer(layerManager.layersChanged.add(this.changed.dispatch));
    this.registerDisposer(layerManager.specificationChanged.add(this.changed.dispatch));
  }

  reset() {
    this.layerManager.clear();
  }

  restoreState(x: any) {
    this.layerManager.clear();
    if (Array.isArray(x)) {
      // If array, layers have an order
      for (const layerObj of x) {
        verifyObject(layerObj);
        const name = this.layerManager.getUniqueLayerName(
            verifyObjectProperty(layerObj, 'name', verifyString));
        this.layerManager.addManagedLayer(this.getLayer(name, layerObj));
      }
    } else {
      // Keep for backwards compatibility
      verifyObject(x);
      for (let key of Object.keys(x)) {
        this.layerManager.addManagedLayer(this.getLayer(key, x[key]));
      }
    }
  }

  initializeLayerFromSpec(managedLayer: ManagedUserLayerWithSpecification, spec: any) {
    managedLayer.initialSpecification = spec;
    if (typeof spec === 'string') {
      spec = {'source': spec};
    }
    verifyObject(spec);
    let layerType = verifyObjectProperty(spec, 'type', verifyOptionalString);
    managedLayer.visible = verifyObjectProperty(spec, 'visible', x => {
      if (x === undefined || x === true) {
        return true;
      }
      if (x === false) {
        return false;
      }
      throw new Error(`Expected boolean, but received: ${JSON.stringify(x)}.`);
    });

    const makeUserLayer = (layerConstructor: UserLayerConstructor, spec: any) => {
      const userLayer = new layerConstructor(this, spec);
      userLayer.restoreState(spec);
      managedLayer.layer = userLayer;
    };
    let sourceUrl = managedLayer.sourceUrl =
        verifyObjectProperty(spec, 'source', verifyOptionalString);

    // Compatibility for old graphene links with type: `segmentation`
    if (sourceUrl !== undefined &&
        this.dataSourceProvider.getDataSource(sourceUrl)[2] === 'graphene' &&
        layerType === 'segmentation') {
      spec['type'] = layerType = 'segmentation_with_graph';
      StatusMessage.showMessage(`The layer specification for ${
          sourceUrl} is deprecated. Key 'layerType' must be 'segmentation_with_graph'. Please reload this page.`);
    }

    if (layerType === undefined) {
      if (sourceUrl === undefined) {
        throw new Error(`Either layer 'type' or 'source' URL must be specified.`);
      }
      let volumeSourcePromise =
          getVolumeWithStatusMessage(this.dataSourceProvider, this.chunkManager, sourceUrl);
      volumeSourcePromise.then(source => {
        if (this.layerManager.managedLayers.indexOf(managedLayer) === -1) {
          // Layer was removed before promise became ready.
          return;
        }
        let layerConstructor = volumeLayerTypes.get(source.volumeType);
        if (layerConstructor !== undefined) {
          makeUserLayer(layerConstructor, spec);
        } else {
          throw new Error(`Unsupported volume type: ${VolumeType[source.volumeType]}.`);
        }
      });
    } else {
      let layerConstructor = layerTypes.get(layerType);
      if (layerConstructor !== undefined) {
        makeUserLayer(layerConstructor, spec);
      } else {
        throw new Error(`Unsupported layer type: ${JSON.stringify(layerType)}.`);
      }
    }
  }

  getLayer(name: string, spec: any): ManagedUserLayerWithSpecification {
    let managedLayer = new ManagedUserLayerWithSpecification(name, spec, this);
    this.initializeLayerFromSpec(managedLayer, spec);
    return managedLayer;
  }

  add(layer: ManagedUserLayer, index?: number|undefined) {
    if (this.layerManager.managedLayers.indexOf(layer) === -1) {
      layer.name = this.layerManager.getUniqueLayerName(layer.name);
    }
    this.layerManager.addManagedLayer(layer, index);
  }

  toJSON() {
    const result = [];
    let numResults = 0;
    for (let managedLayer of this.layerManager.managedLayers) {
      const layerJson = (<ManagedUserLayerWithSpecification>managedLayer).toJSON();
      // A `null` layer specification is used to indicate a transient drag target, and should not be
      // serialized.
      if (layerJson != null) {
        result.push(layerJson);
        ++numResults;
      }
    }
    if (numResults === 0) {
      return undefined;
    }
    return result;
  }

  /**
   * Called by user layers to indicate that a voxel position has been selected interactively.
   */
  setVoxelCoordinates(voxelCoordinates: vec3) {
    this.voxelCoordinatesSet.dispatch(voxelCoordinates);
  }

  setSpatialCoordinates(spatialCoordinates: vec3) {
    this.spatialCoordinatesSet.dispatch(spatialCoordinates);
  }

  get rootLayers() {
    return this.layerManager;
  }
}

/**
 * Class for specifying a subset of a TopLevelLayerListsSpecification.
 */
export class LayerSubsetSpecification extends RefCounted implements LayerListSpecification {
  changed = new NullarySignal();

  get voxelCoordinatesSet() {
    return this.master.voxelCoordinatesSet;
  }
  get spatialCoordinatesSet() {
    return this.master.spatialCoordinatesSet;
  }

  get worker() {
    return this.master.rpc;
  }
  get rpc() {
    return this.master.rpc;
  }

  get dataSourceProvider() {
    return this.master.dataSourceProvider;
  }
  get chunkManager() {
    return this.master.chunkManager;
  }
  get voxelSize() {
    return this.master.voxelSize;
  }
  get layerSelectedValues() {
    return this.master.layerSelectedValues;
  }

  layerManager = new LayerManager(this.messageWithUndo.bind(this));

  constructor(public master: Owned<LayerListSpecification>) {
    super();
    this.registerDisposer(master);
    const {layerManager} = this;
    this.registerDisposer(layerManager.layersChanged.add(this.changed.dispatch));
    this.registerDisposer(layerManager.specificationChanged.add(this.changed.dispatch));
  }

  reset() {
    this.layerManager.clear();
  }

  restoreState(x: any) {
    const masterLayerManager = this.master.layerManager;
    const layers: ManagedUserLayer[] = [];
    for (const name of new Set(parseArray(x, verifyString))) {
      const layer = masterLayerManager.getLayerByName(name);
      if (layer === undefined) {
        throw new Error(
            `Undefined layer referenced in subset specification: ${JSON.stringify(name)}`);
      }
      layers.push(layer);
    }
    this.layerManager.clear();
    for (const layer of layers) {
      this.layerManager.addManagedLayer(layer.addRef());
    }
  }

  toJSON() {
    return this.layerManager.managedLayers.map(x => x.name);
  }

  initializeLayerFromSpec(managedLayer: ManagedUserLayerWithSpecification, spec: any) {
    this.master.initializeLayerFromSpec(managedLayer, spec);
  }

  getLayer(name: string, spec: any): ManagedUserLayerWithSpecification {
    return this.master.getLayer(name, spec);
  }

  add(layer: ManagedUserLayer, index?: number|undefined) {
    if (this.master.layerManager.managedLayers.indexOf(layer) === -1) {
      layer.name = this.master.layerManager.getUniqueLayerName(layer.name);
      this.master.layerManager.addManagedLayer(layer.addRef());
    }
    this.layerManager.addManagedLayer(layer, index);
  }

  setVoxelCoordinates(voxelCoordinates: vec3) {
    this.master.setVoxelCoordinates(voxelCoordinates);
  }

  setSpatialCoordinates(spatialCoordinates: vec3) {
    this.master.setSpatialCoordinates(spatialCoordinates);
  }

  get rootLayers() {
    return this.master.rootLayers;
  }

  private getStateRevertingFunction() {
    const currentState = this.toJSON();
    return () => {
      this.restoreState(currentState);
    };
  }
  messageWithUndo(message: string, actionMessage: string, closeAfter: number = 10000) {
    const undo = this.getStateRevertingFunction();
    StatusMessage.messageWithAction(message, [{message: actionMessage, action: undo}], closeAfter);
  }
}

interface UserLayerConstructor {
  new(manager: LayerListSpecification, x: any): UserLayer;
}

const layerTypes = new Map<string, UserLayerConstructor>();
const volumeLayerTypes = new Map<VolumeType, UserLayerConstructor>();

export function registerLayerType(name: string, layerConstructor: UserLayerConstructor) {
  layerTypes.set(name, layerConstructor);
}

export function registerVolumeLayerType(
    volumeType: VolumeType, layerConstructor: UserLayerConstructor) {
  volumeLayerTypes.set(volumeType, layerConstructor);
}
