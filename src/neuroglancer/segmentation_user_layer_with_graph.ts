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

import { mat4 } from 'gl-matrix';
// import {AnnotationLayer, SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
// import {PerspectiveViewAnnotationLayer} from 'neuroglancer/annotation/renderlayer';
// import {setAnnotationHoverStateFromMouseState} from 'neuroglancer/annotation/selection';
import {GRAPHENE_MANIFEST_REFRESH_PROMISE} from 'neuroglancer/datasource/graphene/base';
// import {GraphOperationLayerState} from 'neuroglancer/graph/graph_operation_layer_state';
// import {PathFinderState} from 'neuroglancer/graph/path_finder_state';
import {registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer';
// import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentationUserLayer, SegmentationUserLayerDisplayState} from 'neuroglancer/segmentation_user_layer';
import {ChunkedGraphChunkSource, ChunkedGraphLayer, SegmentSelection} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {SupervoxelRenderLayer} from 'neuroglancer/sliceview/volume/supervoxel_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableValue, WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
// import {GraphOperationTab, SelectedGraphOperationState} from 'neuroglancer/ui/graph_multicut';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyObjectProperty} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
// import { makeCoordinateSpace } from './coordinate_transform';
import { LayerActionContext } from './layer';
import { SliceViewSingleResolutionSource } from './sliceview/frontend';

import {NullarySignal} from './util/signal';
import { SpecialProtocolCredentialsProvider } from './util/special_protocol_request';

// Already defined in segmentation_user_layer.ts
const EQUIVALENCES_JSON_KEY = 'equivalences';

// Removed CHUNKED_GRAPH_JSON_KEY due to old links circulating with outdated graphs
// const CHUNKED_GRAPH_JSON_KEY = 'chunkedGraph';
const ROOT_SEGMENTS_JSON_KEY = 'segments';
const GRAPH_OPERATION_MARKER_JSON_KEY = 'graphOperationMarker';
const TIMESTAMP_JSON_KEY = 'timestamp';
// const PATH_FINDER_JSON_KEY = 'pathFinder';

const lastSegmentSelection: SegmentSelection = {
  segmentId: new Uint64(),
  rootId: new Uint64(),
  position: vec3.create(),
};

// export class MulticutDisplayInformation extends RefCounted {
//   changed = new NullarySignal();

//   constructor(
//       public multicutSegments = new Uint64Set(),
//       public focusMulticutSegments = new TrackableBoolean(false, false),
//       public otherSegmentsAlpha = trackableAlphaValue(0.5)) {
//     super();
//     this.registerDisposer(multicutSegments.changed.add(this.changed.dispatch));
//     this.registerDisposer(focusMulticutSegments.changed.add(this.changed.dispatch));
//     this.registerDisposer(otherSegmentsAlpha.changed.add(this.changed.dispatch));
//   }
// }

export type SegmentationUserLayerWithGraphDisplayState = SegmentationUserLayerDisplayState&{
  // multicutDisplayInformation: MulticutDisplayInformation;
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
    // graphOperationLayerState =
    //     this.registerDisposer(new WatchableRefCounted<GraphOperationLayerState>());
    // pathFinderState = this.registerDisposer(new PathFinderState(this.transform));
    // selectedGraphOperationElement = this.registerDisposer(
    //     new SelectedGraphOperationState(this.graphOperationLayerState.addRef()));
    displayState: SegmentationUserLayerWithGraphDisplayState;
    private multiscaleVolumeChunkSource: MultiscaleVolumeChunkSource|undefined;

    public credentialsProvider: SpecialProtocolCredentialsProvider;
    constructor(...args: any[]) {
      super(...args);
      this.displayState = {
        ...this.displayState,
        // multicutDisplayInformation: new MulticutDisplayInformation(),
        timestamp: new TrackableValue('', date => ((new Date(date)).valueOf() / 1000).toString()),
        timestampLimit: new TrackableValue(
            '',
            date => {
              let limit = new Date(date).valueOf().toString();
              return limit === 'NaN' ? '' : limit;
            },
            '')
      };

      // this.tabs.add('graph', {
      //   label: 'Graph',
      //   order: -75,
      //   getter: () => new GraphOperationTab(
      //       this, this.selectedGraphOperationElement.addRef(), this.manager.voxelSize.addRef(),
      //       point => this.manager.setSpatialCoordinates(point))
      // });

      // const segmentationState = new WatchableValue<SegmentationDisplayState>(this.displayState);
      // const graphOpState = this.graphOperationLayerState.value = new GraphOperationLayerState({
      //   transform: this.transform,
      //   segmentationState: segmentationState,
      //   multicutSegments: this.displayState.multicutDisplayInformation.multicutSegments,
      //   performingMulticut: new TrackableBoolean(false, false)
      // });

      // graphOpState.registerDisposer(graphOpState.performingMulticut.changed.add(() => {
      //   this.displayState.multicutDisplayInformation.focusMulticutSegments.value =
      //       graphOpState.performingMulticut.value;
      // }));

      // graphOpState.registerDisposer(
      //     graphOpState.changed.add(() => this.specificationChanged.dispatch()));
      // this.registerDisposer(
      //     this.displayState.timestamp.changed.add(() => this.specificationChanged.dispatch()));

      // const {stateA, stateB} = graphOpState;
      // if (stateA !== undefined) {
      //   const annotationLayer = new AnnotationLayer(this.manager.chunkManager, stateA.addRef());
      //   setAnnotationHoverStateFromMouseState(stateA, this.manager.layerSelectedValues.mouseState);
      //   this.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
      //   this.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
      // }
      // if (stateB !== undefined) {
      //   const annotationLayer = new AnnotationLayer(this.manager.chunkManager, stateB.addRef());
      //   setAnnotationHoverStateFromMouseState(stateB, this.manager.layerSelectedValues.mouseState);
      //   this.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
      //   this.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
      // }

      // {
      //   const pathFinderAnnotationLayer = new AnnotationLayer(
      //       this.manager.chunkManager, this.pathFinderState.annotationLayerState.value!.addRef());
      //   setAnnotationHoverStateFromMouseState(
      //       this.pathFinderState.annotationLayerState.value!,
      //       this.manager.layerSelectedValues.mouseState);
      //   this.addRenderLayer(new SliceViewAnnotationLayer(pathFinderAnnotationLayer));
      //   this.addRenderLayer(new PerspectiveViewAnnotationLayer(pathFinderAnnotationLayer.addRef()));
      //   this.registerDisposer(this.pathFinderState.changed.add(this.specificationChanged.dispatch));
      // }

      this.tabs.default = 'rendering';
    }

    get volumeOptions() {
      return {volumeType: VolumeType.SEGMENTATION_WITH_GRAPH};
    }


    restoreState(specification: any) {
      super.restoreState(specification);

      // Ignore user-specified equivalences for graph layer
      this.displayState.segmentationGroupState.value.segmentEquivalences.clear();

      const doStuff = (volume: MultiscaleVolumeChunkSource) => {
        let remaining = 0;
      // if (multiscaleSource !== undefined) {
        ++remaining;
        // multiscaleSource.then(volume => {
          this.multiscaleVolumeChunkSource = volume;
          const {displayState} = this;
          if (!this.wasDisposed) {
            // if (volume.getTimestampLimit) {
            //   volume.getTimestampLimit().then((limit) => {
            //     this.displayState.timestampLimit.restoreState(limit);
            //   });
            // }
            // Chunked Graph Server
            if (volume.getChunkedGraphUrl) {
              const res = volume.getChunkedGraphUrl();
              if (res) {
                [this.chunkedGraphUrl, this.credentialsProvider] = res;
              }
            }
            // Chunked Graph Supervoxels
            if (this.chunkedGraphUrl && volume.getChunkedGraphSources) {
              let chunkedGraphSources = volume.getChunkedGraphSources(
                  {rootUri: this.chunkedGraphUrl}, displayState.segmentationGroupState.value.rootSegments);

              if (chunkedGraphSources) {
                this.updateChunkSourceRootSegments(chunkedGraphSources);
                const transform = this.someSegmentationRenderLayer()?.displayState.transform!; //  yuck?
                this.chunkedGraphLayer = new ChunkedGraphLayer(this.chunkedGraphUrl, chunkedGraphSources, volume, // volume not actually used
                    {
                      ...displayState,
                      ...displayState.segmentationGroupState.value,
                      localPosition: this.localPosition,
                      transform,
                    },
                    this.credentialsProvider);
                this.addRenderLayer(this.chunkedGraphLayer);

                // Have to wait for graph server initialization to fetch agglomerations
                displayState.segmentationGroupState.value.segmentEquivalences.clear();
                if (displayState.segmentationGroupState.value.rootSegmentsAfterEdit !== undefined) {
                  displayState.segmentationGroupState.value.rootSegmentsAfterEdit.clear();
                }
                verifyObjectProperty(specification, ROOT_SEGMENTS_JSON_KEY, y => {
                  if (y !== undefined) {
                    let {rootSegments} = displayState.segmentationGroupState.value;
                    parseArray(y, value => {
                      rootSegments.add(Uint64.parseString(String(value), 10));
                    });
                  }
                });
              }
            }
            // this.addSupervoxelRenderLayer({
            //   supervoxelSet:
            //       this.graphOperationLayerState.value!.annotationToSupervoxelA.supervoxelSet,
            //   supervoxelColor: new TrackableRGB(vec3.fromValues(1.0, 0.0, 0.0)),
            //   isActive: this.graphOperationLayerState.value!.annotationToSupervoxelA.isActive,
            //   performingMulticut: this.graphOperationLayerState.value!.performingMulticut
            // });
            // this.addSupervoxelRenderLayer({
            //   supervoxelSet:
            //       this.graphOperationLayerState.value!.annotationToSupervoxelB.supervoxelSet,
            //   supervoxelColor: new TrackableRGB(vec3.fromValues(0.0, 0.0, 1.0)),
            //   isActive: this.graphOperationLayerState.value!.annotationToSupervoxelB.isActive,
            //   performingMulticut: this.graphOperationLayerState.value!.performingMulticut
            // });
            if (--remaining === 0) {
              // this.isReady = true; // TODO is this no longer needed?
            }
      }
    }

      let segmentationRenderLayer = this.someSegmentationRenderLayer();

      if (segmentationRenderLayer === undefined) {
        let started = false;
        this.has2dLayer.changed.add(() => {
          segmentationRenderLayer = this.someSegmentationRenderLayer();
          
          if (started || !(segmentationRenderLayer = this.someSegmentationRenderLayer())) {
            return;
          }
          started = true;

          doStuff(segmentationRenderLayer.multiscaleSource);
        });
        return;
      }

      doStuff(segmentationRenderLayer.multiscaleSource);

      // this.multiscaleVolumeChunkSource.

      // const {multiscaleSource: volume} = segmentationRenderLayer;

      // if (this.graphOperationLayerState.value && specification[GRAPH_OPERATION_MARKER_JSON_KEY]) {
      //   this.graphOperationLayerState.value.restoreState(
      //       specification[GRAPH_OPERATION_MARKER_JSON_KEY]);
      // }
      // if (this.displayState.timestamp && specification[TIMESTAMP_JSON_KEY]) {
      //   this.displayState.timestamp.value = (specification[TIMESTAMP_JSON_KEY]);
      // }
      // if (specification[PATH_FINDER_JSON_KEY] !== undefined) {
      //   this.pathFinderState.restoreState(specification[PATH_FINDER_JSON_KEY]);
      // }
    }

    toJSON() {
      const x = super.toJSON();
      x['type'] = 'segmentation_with_graph';

      if (this.displayState.timestamp.value) {
        x[TIMESTAMP_JSON_KEY] = this.displayState.timestamp.value;
      }
      // if (this.graphOperationLayerState.value) {
      //   x[GRAPH_OPERATION_MARKER_JSON_KEY] = this.graphOperationLayerState.value.toJSON();
      // }
      // x[PATH_FINDER_JSON_KEY] = this.pathFinderState.toJSON();

      // Graph equivalences can contain million of supervoxel IDs - don't store them in the state.
      delete x[EQUIVALENCES_JSON_KEY];
      return x;
    }

    handleAction(action: string) {
      // if (this.ignoreSegmentInteractions.value) {
      //   return;
      // }
      switch (action) {
        case 'clear-segments': {
          this.displayState.segmentationGroupState.value.rootSegments.clear();
          this.displayState.segmentationGroupState.value.visibleSegments2D!.clear();
          this.displayState.segmentationGroupState.value.visibleSegments3D.clear();
          this.displayState.segmentationGroupState.value.segmentEquivalences.clear();
          if (this.displayState.segmentationGroupState.value.rootSegmentsAfterEdit !== undefined) {
            this.displayState.segmentationGroupState.value.rootSegmentsAfterEdit.clear();
          }
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
          this.selectSegment2();
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
        case 'refresh-mesh': {
          this.reloadManifest();
          break;
        }
        default:
          const context = new LayerActionContext();
          super.handleAction(action, context);
          break;
      }
    }

    getRootOfSelectedSupervoxel() {
      let {segmentSelectionState, timestamp} = this.displayState;
      let tsValue = (timestamp.value !== '') ? timestamp.value : void (0);
      const mousePosition = this.manager.layerSelectedValues.mouseState.position;
      const mousePositionVec3 = vec3.fromValues(mousePosition[0], mousePosition[1], mousePosition[2]);

      const meshLayer = this.someSegmentationRenderLayer()!;
      const transform = meshLayer.displayState.transform.value!; //  TODO not being used
      const inverseTransform = mat4.create(); // TODO empty transform

      const currentSegmentSelection: SegmentSelection = {
        segmentId: segmentSelectionState.selectedSegment.clone(),
        rootId: segmentSelectionState.selectedSegment.clone(),
        position: vec3.transformMat4(
            vec3.create(), mousePositionVec3,
            inverseTransform)
      };

      return this.chunkedGraphLayer!.getRoot(currentSegmentSelection, tsValue);
    }

    selectSegment2() {
      let {segmentSelectionState} = this.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        let segment = segmentSelectionState.selectedSegment;
        let {rootSegments} = this.displayState.segmentationGroupState.value;
        if (rootSegments.has(segment)) {
          rootSegments.delete(segment);
        } else if (this.chunkedGraphLayer) {
          if (!this.chunkedGraphLayer.leafRequestsActive.value) {
            StatusMessage.showTemporaryMessage(
                'The selected segment will not be displayed in 2D at this current zoom level. ',
                3000);
          }
          this.getRootOfSelectedSupervoxel()
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
/*
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
      const {segmentSelectionState, rootSegments, rootSegmentsAfterEdit} = this.displayState;
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
              rootSegmentsAfterEdit!.clear();
              rootSegments.delete(lastSegmentSelection.rootId);
              rootSegments.delete(currentSegmentSelection.rootId);
              rootSegments.add(mergedRoot);
              rootSegmentsAfterEdit!.add(mergedRoot);
              // TODO: Merge unsupported with edits
              const view = (<any>window)['viewer'];
              view.deactivateEditMode();
              view.differ.purgeHistory();
              view.differ.ignoreChanges();
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
      const {segmentSelectionState, rootSegments, rootSegmentsAfterEdit} = this.displayState;
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
                  rootSegmentsAfterEdit!.clear();
                  rootSegments.delete(currentSegmentSelection.rootId);
                  rootSegments.add(splitRoots);
                  rootSegmentsAfterEdit!.add(splitRoots);
                  // TODO: Merge unsupported with edits
                  const view = (<any>window)['viewer'];
                  view.deactivateEditMode();
                  view.differ.purgeHistory();
                  view.differ.ignoreChanges();
                });
          });
        } else {
          StatusMessage.showTemporaryMessage(
              `Split unsuccessful - graph layer not initialized.`, 3000);
        }
      }
    }*/

    reloadManifest() {
      let {segmentSelectionState} = this.displayState;
      if (segmentSelectionState.hasSelectedSegment) {
        let segment = segmentSelectionState.selectedSegment;
        let {rootSegments} = this.displayState.segmentationGroupState.value;
        if (rootSegments.has(segment)) {
          const meshLayer = this.someRenderLayer();
          if (meshLayer) {
            const meshSource = meshLayer.source;
            const promise = meshSource.rpc!.promiseInvoke<any>(
              GRAPHENE_MANIFEST_REFRESH_PROMISE,
              {'rpcId': meshSource.rpcId!, 'segment': segment.toString()});
            const msgTail = 'if full mesh does not appear try again after this message disappears.';
            this.chunkedGraphLayer!.withErrorMessage(promise, {
              initialMessage: `Reloading mesh for segment ${segment}, ${msgTail}`,
              errorPrefix: `Could not fetch mesh manifest: `
            });
          }          
        }
      }
    }

    private lastDeselectionMessage: StatusMessage|undefined;
    private lastDeselectionMessageExists = false;
    rootSegmentChange(rootSegments: Uint64[]|null, added: boolean) {
      if (rootSegments === null) {
        if (added) {
          return;
        } else {
          // Clear all segment sets
          let leafSegmentCount = this.displayState.segmentationGroupState.value.visibleSegments2D!.size;
          this.displayState.segmentationGroupState.value.visibleSegments2D!.clear();
          this.displayState.segmentationGroupState.value.visibleSegments3D.clear();
          this.displayState.segmentationGroupState.value.segmentEquivalences.clear();
          if (this.displayState.segmentationGroupState.value.rootSegmentsAfterEdit !== undefined) {
            this.displayState.segmentationGroupState.value.rootSegmentsAfterEdit.clear();
          }
          StatusMessage.showTemporaryMessage(`Deselected all ${leafSegmentCount} segments.`, 3000);
        }
      } else if (added) {
        this.displayState.segmentationGroupState.value.visibleSegments3D.add(rootSegments!);
        this.displayState.segmentationGroupState.value.visibleSegments2D!.add(rootSegments!);
      } else if (!added) {
        for (const rootSegment of rootSegments) {
          const segments = [...this.displayState.segmentationGroupState.value.segmentEquivalences.setElements(rootSegment)];
          const segmentCount = segments.length;  // Approximation
          this.displayState.segmentationGroupState.value.visibleSegments2D!.delete(rootSegment);
          this.displayState.segmentationGroupState.value.visibleSegments3D.delete(segments);
          this.displayState.segmentationGroupState.value.segmentEquivalences.deleteSet(rootSegment);
          if (this.lastDeselectionMessage && this.lastDeselectionMessageExists) {
            this.lastDeselectionMessage.dispose();
            this.lastDeselectionMessageExists = false;
          }
          this.lastDeselectionMessage =
              StatusMessage.showMessage(`Deselected ${segmentCount} segments.`);
          this.lastDeselectionMessageExists = true;
          setTimeout(() => {
            if (this.lastDeselectionMessageExists) {
              this.lastDeselectionMessage!.dispose();
              this.lastDeselectionMessageExists = false;
            }
          }, 2000);
        }
      }
      this.specificationChanged.dispatch();
    }

    private updateChunkSourceRootSegments(chunkedGraphChunkSources: SliceViewSingleResolutionSource<ChunkedGraphChunkSource>[][]) {
      chunkedGraphChunkSources.forEach(chunkedGraphChunkSourceList => {
        chunkedGraphChunkSourceList.forEach(({chunkSource: chunkedGraphChunkSource}) => {
          if (chunkedGraphChunkSource.rootSegments !== this.displayState.segmentationGroupState.value.rootSegments) {
            chunkedGraphChunkSource.updateRootSegments(
                this.manager.rpc, this.displayState.segmentationGroupState.value.rootSegments);
          }
        });
      });
    }

    addSupervoxelRenderLayer({supervoxelSet, supervoxelColor, isActive, performingMulticut}: {
      supervoxelSet: Uint64Set,
      supervoxelColor: TrackableRGB,
      isActive: TrackableBoolean,
      performingMulticut: TrackableBoolean
    }): SupervoxelRenderLayer {
      if (!this.multiscaleVolumeChunkSource) {
        // Should never happen
        throw new Error(
            'Attempt to add Supervoxel Render Layer before segmentation volume retrieved');
      }

      const transform = this.someSegmentationRenderLayer()?.displayState.transform!; //  yuck?

      const supervoxelRenderLayer = new SupervoxelRenderLayer(this.multiscaleVolumeChunkSource, {
        ...this.displayState,
        ...this.displayState.segmentationGroupState.value,
        visibleSegments2D: supervoxelSet,
        supervoxelColor,
        shatterSegmentEquivalences: new TrackableBoolean(true, true),
        transform: transform,//this.displayState.objectToDataTransform,
        renderScaleHistogram: this.sliceViewRenderScaleHistogram,
        renderScaleTarget: this.sliceViewRenderScaleTarget,
        localPosition: this.localPosition,
        isActive,
        performingMulticut
      });
      this.addRenderLayer(supervoxelRenderLayer);
      return supervoxelRenderLayer;
    }
  }
  return C;
}

export interface SegmentationUserLayerWithGraph extends SegmentationUserLayer {
  chunkedGraphUrl: string|null|undefined;
  chunkedGraphLayer: Borrowed<ChunkedGraphLayer>|undefined;
  // graphOperationLayerState: WatchableRefCounted<GraphOperationLayerState>;
  // selectedGraphOperationElement: SelectedGraphOperationState;
  addSupervoxelRenderLayer: ({supervoxelSet, supervoxelColor, isActive, performingMulticut}: {
    supervoxelSet: Uint64Set,
    supervoxelColor: TrackableRGB,
    isActive: TrackableBoolean,
    performingMulticut: TrackableBoolean
  }) => SupervoxelRenderLayer;
  // pathFinderState: PathFinderState;
  getRootOfSelectedSupervoxel: () => Promise<Uint64>;
}

/**
 * Mixin that expands the SegmentationUserLayer with graph-related properties.
 */
export function
SegmentationUserLayerWithGraphMixin<TBase extends {new (...args: any[]): SegmentationUserLayer}>(
    Base: TBase) {
  return helper(Base);
}

export function isSegmentationUserLayerWithGraph(layer: SegmentationUserLayer):
    layer is SegmentationUserLayerWithGraph {
  return 'chunkedGraphLayer' in layer;
}

registerLayerType(
    'segmentation_with_graph', SegmentationUserLayerWithGraphMixin(SegmentationUserLayer));
registerVolumeLayerType(
    VolumeType.SEGMENTATION_WITH_GRAPH, SegmentationUserLayerWithGraphMixin(SegmentationUserLayer));
