/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import {registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {ChunkedGraphLayer, SegmentSelection} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {StatusMessage} from 'neuroglancer/status';
import {Borrowed} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {SegmentationUserLayer} from './segmentation_user_layer';

// Already defined in segmentation_user_layer.ts
const EQUIVALENCES_JSON_KEY = 'equivalences';

const CHUNKED_GRAPH_JSON_KEY = 'chunkedGraph';
const ROOT_SEGMENTS_JSON_KEY = 'segments';

const lastSegmentSelection: SegmentSelection = {
  segmentId: new Uint64(),
  rootId: new Uint64(),
  position: vec3.create(),
};

interface BaseConstructor {
  new(...args: any[]): SegmentationUserLayer;
}

function helper<TBase extends BaseConstructor>(Base: TBase) {
  class C extends Base implements SegmentationUserLayerWithGraph {
    chunkedGraphUrl: string|null|undefined;
    chunkedGraphLayer: Borrowed<ChunkedGraphLayer>|undefined;

    constructor(...args: any[]) {
      super(...args);
      this.tabs.default = 'rendering';
    }

    get volumeOptions() {
      return {volumeType: VolumeType.SEGMENTATION_WITH_GRAPH};
    }

    restoreState(specification: any) {
      super.restoreState(specification);

      // Ignore user-specified equivalences for graph layer
      this.displayState.segmentEquivalences.clear();

      const {multiscaleSource} = this;
      this.chunkedGraphUrl = specification[CHUNKED_GRAPH_JSON_KEY] === null ?
          null :
          verifyOptionalString(specification[CHUNKED_GRAPH_JSON_KEY]);

      let remaining = 0;
      if (multiscaleSource !== undefined) {
        ++remaining;
        multiscaleSource.then(volume => {
          if (!this.wasDisposed) {
            // Chunked Graph Server
            if (this.chunkedGraphUrl === undefined && volume.getChunkedGraphUrl) {
              this.chunkedGraphUrl = volume.getChunkedGraphUrl();
            }
            // Chunked Graph Supervoxels
            if (this.chunkedGraphUrl && volume.getChunkedGraphSources) {
              let chunkedGraphSources = volume.getChunkedGraphSources(
                  {rootUri: this.chunkedGraphUrl}, this.displayState.rootSegments);

              if (chunkedGraphSources) {
                this.chunkedGraphLayer = new ChunkedGraphLayer(
                    this.manager.chunkManager, this.chunkedGraphUrl, chunkedGraphSources,
                    this.displayState);
                this.addRenderLayer(this.chunkedGraphLayer);

                // Have to wait for graph server initialization to fetch agglomerations
                this.displayState.segmentEquivalences.clear();
                verifyObjectProperty(specification, ROOT_SEGMENTS_JSON_KEY, y => {
                  if (y !== undefined) {
                    let {rootSegments} = this.displayState;
                    parseArray(y, value => {
                      rootSegments.add(Uint64.parseString(String(value), 10));
                    });
                  }
                });
              }
            }
            if (--remaining === 0) {
              this.isReady = true;
            }
          }
        });
      }
    }

    toJSON() {
      const x = super.toJSON();
      x['type'] = 'segmentation_with_graph';
      x[CHUNKED_GRAPH_JSON_KEY] = this.chunkedGraphUrl;

      // Graph equivalences can contain million of supervoxel IDs - don't store them in the state.
      delete x[EQUIVALENCES_JSON_KEY];
      return x;
    }

    handleAction(action: string) {
      switch (action) {
        case 'clear-segments': {
          this.displayState.rootSegments.clear();
          this.displayState.visibleSegments2D!.clear();
          this.displayState.visibleSegments3D.clear();
          this.displayState.segmentEquivalences.clear();
          break;
        }
        case 'merge-selected': {
          StatusMessage.showTemporaryMessage(
              `Graph-enabled segmentation layers only support 2-point-merge.`, 3000);
          break;
        }
        case 'cut-selected': {
          StatusMessage.showTemporaryMessage(
              `Graph-enabled segmentation layers only support 2-point-split.`, 3000);
          break;
        }
        case 'select': {
          this.selectSegment();
          break;
        }
        case 'merge-select-first': {
          this.mergeSelectFirst();
          break;
        }
        case 'merge-select-second': {
          this.mergeSelectSecond();
          break;
        }
        case 'split-select-first': {
          this.splitSelectFirst();
          break;
        }
        case 'split-select-second': {
          this.splitSelectSecond();
          break;
        }
        default:
          super.handleAction(action);
          break;
      }
    }

    selectSegment() {
      let {segmentSelectionState} = this.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        let segment = segmentSelectionState.selectedSegment;
        let {rootSegments} = this.displayState;
        if (rootSegments.has(segment)) {
          rootSegments.delete(segment);
        } else if (this.chunkedGraphLayer) {
          const currentSegmentSelection: SegmentSelection = {
            segmentId: segmentSelectionState.selectedSegment.clone(),
            rootId: segmentSelectionState.selectedSegment.clone(),
            position: vec3.transformMat4(
                vec3.create(), this.manager.layerSelectedValues.mouseState.position,
                this.transform.inverse)
          };

          this.chunkedGraphLayer.getRoot(currentSegmentSelection)
              .then(rootSegment => {
                rootSegments.add(rootSegment);
              })
              .catch((e: Error) => {
                console.log(e);
                StatusMessage.showTemporaryMessage(e.message, 3000);
              });
        } else {
          StatusMessage.showTemporaryMessage(
              `Can't fetch root segment - graph layer not initialized.`, 3000);
        }
      }
    }

    mergeSelectFirst() {
      const {segmentSelectionState} = this.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        lastSegmentSelection.segmentId.assign(segmentSelectionState.rawSelectedSegment);
        lastSegmentSelection.rootId.assign(segmentSelectionState.selectedSegment);
        vec3.transformMat4(
            lastSegmentSelection.position, this.manager.layerSelectedValues.mouseState.position,
            this.transform.inverse);

        StatusMessage.showTemporaryMessage(
            `Selected ${lastSegmentSelection.segmentId} as source for merge. Pick a sink.`, 3000);
      }
    }

    mergeSelectSecond() {
      const {segmentSelectionState, rootSegments} = this.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        const currentSegmentSelection: SegmentSelection = {
          segmentId: segmentSelectionState.rawSelectedSegment.clone(),
          rootId: segmentSelectionState.selectedSegment.clone(),
          position: vec3.transformMat4(
              vec3.create(), this.manager.layerSelectedValues.mouseState.position,
              this.transform.inverse)
        };

        StatusMessage.showTemporaryMessage(
            `Selected ${currentSegmentSelection.segmentId} as sink for merge.`, 3000);

        if (this.chunkedGraphLayer) {
          this.chunkedGraphLayer.mergeSegments(lastSegmentSelection, currentSegmentSelection)
              .then((mergedRoot) => {
                rootSegments.delete(lastSegmentSelection.rootId);
                rootSegments.delete(currentSegmentSelection.rootId);
                rootSegments.add(mergedRoot);
              });
        } else {
          StatusMessage.showTemporaryMessage(
              `Merge unsuccessful - graph layer not initialized.`, 3000);
        }
      }
    }

    splitSelectFirst() {
      const {segmentSelectionState} = this.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        lastSegmentSelection.segmentId.assign(segmentSelectionState.rawSelectedSegment);
        lastSegmentSelection.rootId.assign(segmentSelectionState.selectedSegment);
        vec3.transformMat4(
            lastSegmentSelection.position, this.manager.layerSelectedValues.mouseState.position,
            this.transform.inverse);

        StatusMessage.showTemporaryMessage(
            `Selected ${lastSegmentSelection.segmentId} as source for split. Pick a sink.`, 3000);
      }
    }

    splitSelectSecond() {
      const {segmentSelectionState, rootSegments} = this.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        const currentSegmentSelection: SegmentSelection = {
          segmentId: segmentSelectionState.rawSelectedSegment.clone(),
          rootId: segmentSelectionState.selectedSegment.clone(),
          position: vec3.transformMat4(
              vec3.create(), this.manager.layerSelectedValues.mouseState.position,
              this.transform.inverse)
        };

        StatusMessage.showTemporaryMessage(
            `Selected ${currentSegmentSelection.segmentId} as sink for split.`, 3000);

        if (this.chunkedGraphLayer) {
          this.chunkedGraphLayer.splitSegments([lastSegmentSelection], [currentSegmentSelection])
              .then((splitRoots) => {
                if (splitRoots.length === 0) {
                  StatusMessage.showTemporaryMessage(`No split found.`, 3000);
                  return;
                }
                rootSegments.delete(currentSegmentSelection.rootId);
                for (const splitRoot of splitRoots) {
                  rootSegments.add(splitRoot);
                }
              });
        } else {
          StatusMessage.showTemporaryMessage(
              `Split unsuccessful - graph layer not initialized.`, 3000);
        }
      }
    }

    rootSegmentChange(rootSegment: Uint64|null, added: boolean) {
      if (rootSegment === null && !added) {
        // Clear all segment sets
        let leafSegmentCount = this.displayState.visibleSegments2D!.size;
        this.displayState.visibleSegments2D!.clear();
        this.displayState.visibleSegments3D.clear();
        this.displayState.segmentEquivalences.clear();
        StatusMessage.showTemporaryMessage(`Deselected all ${leafSegmentCount} segments.`, 3000);
      } else if (added) {
        this.displayState.visibleSegments3D.add(rootSegment!);
        this.displayState.visibleSegments2D!.add(rootSegment!);
      } else if (!added) {
        let segments = [...this.displayState.segmentEquivalences.setElements(rootSegment!)];
        let segmentCount = segments.length;  // Approximation
        this.displayState.visibleSegments2D!.delete(rootSegment!);
        this.displayState.visibleSegments3D.delete(segments);
        this.displayState.segmentEquivalences.deleteSet(rootSegment!);
        StatusMessage.showTemporaryMessage(`Deselected ${segmentCount} segments.`);
      }
      this.specificationChanged.dispatch();
    }
  }
  return C;
}

export interface SegmentationUserLayerWithGraph extends SegmentationUserLayer {
  chunkedGraphUrl: string|null|undefined;
  chunkedGraphLayer: Borrowed<ChunkedGraphLayer>|undefined;
}

/**
 * Mixin that expands the SegmentationUserLayer with graph-related properties.
 */
export function
SegmentationUserLayerWithGraphMixin<TBase extends {new (...args: any[]): SegmentationUserLayer}>(
    Base: TBase) {
  return helper(Base);
}

registerLayerType(
    'segmentation_with_graph', SegmentationUserLayerWithGraphMixin(SegmentationUserLayer));
registerVolumeLayerType(
    VolumeType.SEGMENTATION_WITH_GRAPH, SegmentationUserLayerWithGraphMixin(SegmentationUserLayer));
