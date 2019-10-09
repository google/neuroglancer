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

import {AnnotationLayer, SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
import {PerspectiveViewAnnotationLayer} from 'neuroglancer/annotation/renderlayer';
import {setAnnotationHoverStateFromMouseState} from 'neuroglancer/annotation/selection';
import {GraphOperationLayerState} from 'neuroglancer/graph/graph_operation_layer_state';
import {registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentationUserLayer, SegmentationUserLayerDisplayState} from 'neuroglancer/segmentation_user_layer';
import {ChunkedGraphChunkSource, ChunkedGraphLayer, SegmentSelection} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {SupervoxelRenderLayer} from 'neuroglancer/sliceview/volume/supervoxel_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableValue, WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
import {GraphOperationTab, SelectedGraphOperationState} from 'neuroglancer/ui/graph_multicut';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyObjectProperty} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';

// Already defined in segmentation_user_layer.ts
const EQUIVALENCES_JSON_KEY = 'equivalences';

// Removed CHUNKED_GRAPH_JSON_KEY due to old links circulating with outdated graphs
// const CHUNKED_GRAPH_JSON_KEY = 'chunkedGraph';
const ROOT_SEGMENTS_JSON_KEY = 'segments';
const GRAPH_OPERATION_MARKER_JSON_KEY = 'graphOperationMarker';
const TIMESTAMP_JSON_KEY = 'timestamp';

const lastSegmentSelection: SegmentSelection = {
  segmentId: new Uint64(),
  rootId: new Uint64(),
  position: vec3.create(),
};

export type SegmentationUserLayerWithGraphDisplayState = SegmentationUserLayerDisplayState&{
  multicutSegments: Uint64Set;
  performingMulticut: TrackableBoolean;
  timestamp: TrackableValue<string>;
  timestampLimit: TrackableValue<string>;
};

interface BaseConstructor {
  new(...args: any[]): SegmentationUserLayer;
}

function helper<TBase extends BaseConstructor>(Base: TBase) {
  class C extends Base implements SegmentationUserLayerWithGraph {
    chunkedGraphUrl: string|null|undefined;
    chunkedGraphLayer: Borrowed<ChunkedGraphLayer>|undefined;
    graphOperationLayerState =
        this.registerDisposer(new WatchableRefCounted<GraphOperationLayerState>());
    selectedGraphOperationElement = this.registerDisposer(
        new SelectedGraphOperationState(this.graphOperationLayerState.addRef()));
    displayState: SegmentationUserLayerWithGraphDisplayState;
    constructor(...args: any[]) {
      super(...args);
      this.displayState = {
        ...this.displayState,
        multicutSegments: new Uint64Set(),
        performingMulticut: new TrackableBoolean(false, false),
        timestamp: new TrackableValue('', date => ((new Date(date)).valueOf() / 1000).toString()),
        timestampLimit: new TrackableValue(
            '',
            date => {
              let limit = new Date(date).valueOf().toString();
              return limit === 'NaN' ? '' : limit;
            },
            '')
      };

      this.tabs.add('graph', {
        label: 'Graph',
        order: -75,
        getter: () => new GraphOperationTab(
            this, this.selectedGraphOperationElement.addRef(), this.manager.voxelSize.addRef(),
            point => this.manager.setSpatialCoordinates(point))
      });

      const segmentationState = new WatchableValue<SegmentationDisplayState>(this.displayState);
      const graphOpState = this.graphOperationLayerState.value = new GraphOperationLayerState({
        transform: this.transform,
        segmentationState: segmentationState,
        multicutSegments: this.displayState.multicutSegments,
        performingMulticut: this.displayState.performingMulticut
      });

      graphOpState.changed.add(() => this.specificationChanged.dispatch());
      this.displayState.timestamp.changed.add(() => this.specificationChanged.dispatch());

      const {stateA, stateB} = graphOpState;
      if (stateA !== undefined) {
        const annotationLayer = new AnnotationLayer(this.manager.chunkManager, stateA.addRef());
        setAnnotationHoverStateFromMouseState(stateA, this.manager.layerSelectedValues.mouseState);
        this.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
        this.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
      }
      if (stateB !== undefined) {
        const annotationLayer = new AnnotationLayer(this.manager.chunkManager, stateB.addRef());
        setAnnotationHoverStateFromMouseState(stateB, this.manager.layerSelectedValues.mouseState);
        this.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
        this.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
      }

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
      let remaining = 0;
      if (multiscaleSource !== undefined) {
        ++remaining;
        multiscaleSource.then(volume => {
          const {displayState} = this;
          if (!this.wasDisposed) {
            if (volume.getTimestampLimit) {
              volume.getTimestampLimit().then((limit) => {
                this.displayState.timestampLimit.restoreState(limit);
              });
            }
            // Chunked Graph Server
            if (volume.getChunkedGraphUrl) {
              this.chunkedGraphUrl = volume.getChunkedGraphUrl();
            }
            // Chunked Graph Supervoxels
            if (this.chunkedGraphUrl && volume.getChunkedGraphSources) {
              let chunkedGraphSources = volume.getChunkedGraphSources(
                  {rootUri: this.chunkedGraphUrl}, displayState.rootSegments);

              if (chunkedGraphSources) {
                this.updateChunkSourceRootSegments(chunkedGraphSources);
                this.chunkedGraphLayer = new ChunkedGraphLayer(
                    this.manager.chunkManager, this.chunkedGraphUrl, chunkedGraphSources,
                    {...displayState, transform: displayState.objectToDataTransform});
                this.addRenderLayer(this.chunkedGraphLayer);

                // Have to wait for graph server initialization to fetch agglomerations
                displayState.segmentEquivalences.clear();
                verifyObjectProperty(specification, ROOT_SEGMENTS_JSON_KEY, y => {
                  if (y !== undefined) {
                    let {rootSegments} = displayState;
                    parseArray(y, value => {
                      rootSegments.add(Uint64.parseString(String(value), 10));
                    });
                  }
                });
              }
            }
            this.addRenderLayer(new SupervoxelRenderLayer(volume, {
              ...this.displayState,
              visibleSegments2D:
                  this.graphOperationLayerState.value!.annotationToSupervoxelA.supervoxelSet,
              supervoxelColor: new TrackableRGB(vec3.fromValues(1.0, 0.0, 0.0)),
              shatterSegmentEquivalences: new TrackableBoolean(true, true),
              transform: this.displayState.objectToDataTransform,
              renderScaleHistogram: this.sliceViewRenderScaleHistogram,
              renderScaleTarget: this.sliceViewRenderScaleTarget,
              isActive: this.graphOperationLayerState.value!.annotationToSupervoxelA.isActive,
              performingMulticut: this.graphOperationLayerState.value!.performingMulticut
            }));
            this.addRenderLayer(new SupervoxelRenderLayer(volume, {
              ...this.displayState,
              visibleSegments2D:
                  this.graphOperationLayerState.value!.annotationToSupervoxelB.supervoxelSet,
              supervoxelColor: new TrackableRGB(vec3.fromValues(0.0, 0.0, 1.0)),
              shatterSegmentEquivalences: new TrackableBoolean(true, true),
              transform: this.displayState.objectToDataTransform,
              renderScaleHistogram: this.sliceViewRenderScaleHistogram,
              renderScaleTarget: this.sliceViewRenderScaleTarget,
              isActive: this.graphOperationLayerState.value!.annotationToSupervoxelB.isActive,
              performingMulticut: this.graphOperationLayerState.value!.performingMulticut
            }));
            if (--remaining === 0) {
              this.isReady = true;
            }
          }
        });
      }

      if (this.graphOperationLayerState.value && specification[GRAPH_OPERATION_MARKER_JSON_KEY]) {
        this.graphOperationLayerState.value.restoreState(
            specification[GRAPH_OPERATION_MARKER_JSON_KEY]);
      }
      if (this.displayState.timestamp && specification[TIMESTAMP_JSON_KEY]) {
        this.displayState.timestamp.value = (specification[TIMESTAMP_JSON_KEY]);
      }
    }

    toJSON() {
      const x = super.toJSON();
      x['type'] = 'segmentation_with_graph';

      if (this.displayState.timestamp.value) {
        x[TIMESTAMP_JSON_KEY] = this.displayState.timestamp.value;
      }
      if (this.graphOperationLayerState.value) {
        x[GRAPH_OPERATION_MARKER_JSON_KEY] = this.graphOperationLayerState.value.toJSON();
      }

      // Graph equivalences can contain million of supervoxel IDs - don't store them in the state.
      delete x[EQUIVALENCES_JSON_KEY];
      return x;
    }

    handleAction(action: string) {
      if (this.ignoreSegmentInteractions.value) {
        return;
      }
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
        case 'shatter-segment-equivalences': {
          StatusMessage.showTemporaryMessage(
              'Shattering segment equivalences not supported for graph-enabled segmentation layers',
              5000);
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
        let {rootSegments, timestamp} = this.displayState;
        let tsValue = (timestamp.value !== '') ? timestamp.value : void (0);
        if (rootSegments.has(segment)) {
          rootSegments.delete(segment);
        } else if (this.chunkedGraphLayer) {
          if (!this.chunkedGraphLayer.leafRequestsActive.value) {
            StatusMessage.showTemporaryMessage(
                'The selected segment will not be displayed in 2D at this current zoom level. ',
                3000);
          }
          const currentSegmentSelection: SegmentSelection = {
            segmentId: segmentSelectionState.selectedSegment.clone(),
            rootId: segmentSelectionState.selectedSegment.clone(),
            position: vec3.transformMat4(
                vec3.create(), this.manager.layerSelectedValues.mouseState.position,
                this.transform.inverse)
          };

          this.chunkedGraphLayer.getRoot(currentSegmentSelection, tsValue)
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

    safeToSubmit(action: string, callback: Function) {
      if (this.displayState.timestamp.value !== '') {
        StatusMessage.showTemporaryMessage(
            `${action} can not be performed with a segmentation at an older state.`);
        return;
      }
      return callback();
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
          const cgl = this.chunkedGraphLayer;
          this.safeToSubmit('Merge', () => {
            cgl.mergeSegments(lastSegmentSelection, currentSegmentSelection).then((mergedRoot) => {
              rootSegments.delete(lastSegmentSelection.rootId);
              rootSegments.delete(currentSegmentSelection.rootId);
              rootSegments.add(mergedRoot);
            });
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
          const cgl = this.chunkedGraphLayer;
          this.safeToSubmit('Split', () => {
            cgl.splitSegments([lastSegmentSelection], [currentSegmentSelection])
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
          });
        } else {
          StatusMessage.showTemporaryMessage(
              `Split unsuccessful - graph layer not initialized.`, 3000);
        }
      }
    }

    rootSegmentChange(rootSegments: Uint64[]|null, added: boolean) {
      if (rootSegments === null) {
        if (added) {
          return;
        } else {
          // Clear all segment sets
          let leafSegmentCount = this.displayState.visibleSegments2D!.size;
          this.displayState.visibleSegments2D!.clear();
          this.displayState.visibleSegments3D.clear();
          this.displayState.segmentEquivalences.clear();
          StatusMessage.showTemporaryMessage(`Deselected all ${leafSegmentCount} segments.`, 3000);
        }
      } else if (added) {
        this.displayState.visibleSegments3D.add(rootSegments!);
        this.displayState.visibleSegments2D!.add(rootSegments!);
      } else if (!added) {
        for (const rootSegment of rootSegments) {
          const segments = [...this.displayState.segmentEquivalences.setElements(rootSegment)];
          const segmentCount = segments.length;  // Approximation
          this.displayState.visibleSegments2D!.delete(rootSegment);
          this.displayState.visibleSegments3D.delete(segments);
          this.displayState.segmentEquivalences.deleteSet(rootSegment);
          StatusMessage.showTemporaryMessage(`Deselected ${segmentCount} segments.`);
        }
      }
      this.specificationChanged.dispatch();
    }

    private updateChunkSourceRootSegments(chunkedGraphChunkSources: ChunkedGraphChunkSource[][]) {
      chunkedGraphChunkSources.forEach(chunkedGraphChunkSourceList => {
        chunkedGraphChunkSourceList.forEach(chunkedGraphChunkSource => {
          if (chunkedGraphChunkSource.rootSegments !== this.displayState.rootSegments) {
            chunkedGraphChunkSource.updateRootSegments(
                this.manager.rpc, this.displayState.rootSegments);
          }
        });
      });
    }
  }
  return C;
}

export interface SegmentationUserLayerWithGraph extends SegmentationUserLayer {
  chunkedGraphUrl: string|null|undefined;
  chunkedGraphLayer: Borrowed<ChunkedGraphLayer>|undefined;
  graphOperationLayerState: WatchableRefCounted<GraphOperationLayerState>;
  selectedGraphOperationElement: SelectedGraphOperationState;
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
