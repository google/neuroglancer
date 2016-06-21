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
import {getVolume} from 'neuroglancer/datasource/factory';
import {ImageUserLayer} from 'neuroglancer/image_user_layer';
import {LayerManager, LayerSelectedValues, ManagedUserLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {VolumeType} from 'neuroglancer/sliceview/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {Trackable} from 'neuroglancer/url_hash_state';
import {RefCounted} from 'neuroglancer/util/disposable';
import {verifyObject, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {RPC} from 'neuroglancer/worker_rpc';
import {Signal} from 'signals';

export function getVolumeWithStatusMessage(x: string): Promise<MultiscaleVolumeChunkSource> {
  return StatusMessage.forPromise(new Promise(function(resolve) { resolve(getVolume(x)); }), {
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
    if (!this.visible) {
      layerSpec['visible'] = false;
    }
    return layerSpec;
  }
};

export class LayerListSpecification extends RefCounted implements Trackable {
  changed = new Signal();
  constructor(
      public layerManager: LayerManager, public chunkManager: ChunkManager, public worker: RPC,
      public layerSelectedValues: LayerSelectedValues, public voxelSize: VoxelSize) {
    super();
    this.registerSignalBinding(layerManager.layersChanged.add(this.changed.dispatch, this.changed));
    this.registerSignalBinding(
        layerManager.specificationChanged.add(this.changed.dispatch, this.changed));
  }

  restoreState(x: any) {
    verifyObject(x);
    this.layerManager.clear();
    for (let key of Object.keys(x)) {
      this.layerManager.addManagedLayer(this.getLayer(key, x[key]));
    }
  }

  getLayer(name: string, spec: any) {
    let managedLayer = new ManagedUserLayerWithSpecification(name, spec, this);
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
    let sourceUrl = managedLayer.sourceUrl =
        verifyObjectProperty(spec, 'source', verifyOptionalString);
    if (layerType === undefined) {
      if (sourceUrl === undefined) {
        throw new Error(`Either layer 'type' or 'source' URL must be specified.`);
      }
      let volumeSourcePromise = getVolumeWithStatusMessage(sourceUrl);
      volumeSourcePromise.then(source => {
        if (this.layerManager.managedLayers.indexOf(managedLayer) === -1) {
          // Layer was removed before promise became ready.
          return;
        }
        switch (source.volumeType) {
          case VolumeType.IMAGE: {
            let userLayer = new ImageUserLayer(this, spec);
            managedLayer.layer = userLayer;
          } break;
          case VolumeType.SEGMENTATION: {
            let userLayer = new SegmentationUserLayer(this, spec);
            managedLayer.layer = userLayer;
          } break;
          default:
            throw new Error('Unsupported source type.');
        }
      });
    } else {
      if (layerType === 'image') {
        managedLayer.layer = new ImageUserLayer(this, spec);
      } else if (layerType === 'segmentation') {
        managedLayer.layer = new SegmentationUserLayer(this, spec);
      } else {
        throw new Error('Layer type not specified.');
      }
    }
    return managedLayer;
  }

  toJSON() {
    let result: any = {};
    let numResults = 0;
    for (let managedLayer of this.layerManager.managedLayers) {
      result[managedLayer.name] = (<ManagedUserLayerWithSpecification>managedLayer).toJSON();
      ++numResults;
    }
    if (numResults === 0) {
      return undefined;
    }
    return result;
  }
};
