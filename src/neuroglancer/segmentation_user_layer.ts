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

import {ChunkedGraph} from 'neuroglancer/chunked_graph/frontend';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer} from 'neuroglancer/mesh/frontend';
import {Overlay} from 'neuroglancer/overlay';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentationDisplayState3D, SegmentSelection, SegmentSelectionState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {FRAGMENT_MAIN_START as SKELETON_FRAGMENT_MAIN_START, getTrackableFragmentMain, PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonLayerDisplayState, SkeletonSource, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {SegmentationRenderLayer, SliceViewSegmentationDisplayState} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {parseArray, verifyObjectProperty, verifyOptionalString, verify3dVec} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ChunkedGraphWidget} from 'neuroglancer/widget/chunked_graph_widget';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {Bounds} from 'neuroglancer/segmentation_display_state/base';
import {vec3} from 'neuroglancer/util/geom';

require('neuroglancer/noselect.css');
require('./segmentation_user_layer.css');

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';


export class SegmentationUserLayer extends UserLayer {
  displayState: SliceViewSegmentationDisplayState&SegmentationDisplayState3D&
      SkeletonLayerDisplayState = {
        segmentColorHash: SegmentColorHash.getDefault(),
        segmentSelectionState: new SegmentSelectionState(),
        selectedAlpha: trackableAlphaValue(0.5),
        notSelectedAlpha: trackableAlphaValue(0),
        objectAlpha: trackableAlphaValue(1.0),
        clipBounds: SharedWatchableValue.make<Bounds|undefined>(this.manager.worker, undefined),
        hideSegmentZero: new TrackableBoolean(true, true),
        rootSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
        visibleSegments2D: new Uint64Set(),
        visibleSegments3D: Uint64Set.makeWithCounterpart(this.manager.worker),
        segmentEquivalences: SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker),
        volumeSourceOptions: {},
        objectToDataTransform: new CoordinateTransform(),
        fragmentMain: getTrackableFragmentMain(),
        shaderError: makeWatchableShaderError(),
      };
  volumePath: string|undefined;

  /**
   * If meshPath is undefined, a default mesh source provided by the volume may be used.  If
   * meshPath is null, the default mesh source is not used.
   */
  chunkedGraphUrl: string|null|undefined;
  meshPath: string|null|undefined;
  skeletonsPath: string|null|undefined;
  chunkedGraph: ChunkedGraph;
  meshLayer: MeshLayer|undefined;

  private pendingGraphMod: {
    source: SegmentSelection[],
    sink: SegmentSelection[],
  };

  constructor(public manager: LayerListSpecification, x: any) {
    super([]);
    this.displayState.rootSegments.changed.add((segmentId: Uint64|null, add: boolean) => {
      this.rootSegmentChange(segmentId, add);
    });
    this.displayState.visibleSegments2D!.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.visibleSegments3D.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.segmentEquivalences.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.notSelectedAlpha.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.objectAlpha.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.hideSegmentZero.changed.add(() => {
      this.specificationChanged.dispatch();
    });
    this.displayState.fragmentMain.changed.add(() => {
      this.specificationChanged.dispatch();
    });

    this.displayState.selectedAlpha.restoreState(x[SELECTED_ALPHA_JSON_KEY]);
    this.displayState.notSelectedAlpha.restoreState(x[NOT_SELECTED_ALPHA_JSON_KEY]);
    this.displayState.objectAlpha.restoreState(x[OBJECT_ALPHA_JSON_KEY]);
    this.displayState.hideSegmentZero.restoreState(x[HIDE_SEGMENT_ZERO_JSON_KEY]);
    this.displayState.objectToDataTransform.restoreState(x['transform']);
    this.displayState.volumeSourceOptions.transform =
        this.displayState.objectToDataTransform.transform;
    this.displayState.fragmentMain.restoreState(x['skeletonShader']);

    let volumePath = this.volumePath = verifyOptionalString(x['source']);
    let chunkedGraphUrl = this.chunkedGraphUrl = x['chunkedGraph'] === null ? null : verifyOptionalString(x['chunkedGraph']);
    let meshPath = this.meshPath = x['mesh'] === null ? null : verifyOptionalString(x['mesh']);
    let skeletonsPath = this.skeletonsPath = x['skeleton'] === null ? null : verifyOptionalString(x['skeleton']);
    if (volumePath !== undefined) {
      getVolumeWithStatusMessage(manager.dataSourceProvider, manager.chunkManager, volumePath, {
        volumeType: VolumeType.SEGMENTATION
      }).then(volume => {
        if (!this.wasDisposed) {
          this.addRenderLayer(new SegmentationRenderLayer(volume, this.displayState));
          if (chunkedGraphUrl === undefined) {
            if (volume.getChunkedGraphUrl != null) {
              this.chunkedGraphUrl = volume.getChunkedGraphUrl();
            }
          }
          this.chunkedGraph = this.registerDisposer(new ChunkedGraph(manager.chunkManager.rpc!, {url: this.chunkedGraphUrl || ''}));
          if (meshPath === undefined) {
            let meshSource = volume.getMeshSource();
            if (meshSource != null) {
              this.addMesh(this.chunkedGraph, meshSource);
            }
          }
          if (skeletonsPath === undefined) {
            if (volume.getSkeletonSource != null) {
              let skeletonSource = volume.getSkeletonSource();
              if (skeletonSource != null) {
                this.skeletonsPath = 'from_info_file'; // this makes the dropdown menu visible
                this.addSkeleton(this.chunkedGraph, skeletonSource);
              }
            }
          }

          // Have to wait for graph server initialization to fetch agglomerations
          if (this.chunkedGraphUrl) {
            this.displayState.segmentEquivalences.clear();
            verifyObjectProperty(x, 'segments', y => {
              if (y !== undefined) {
                let {rootSegments} = this.displayState;
                parseArray(y, value => {
                  rootSegments.add(Uint64.parseString(String(value), 10));
                });
              }
            });
          }
        }
      });
    }

    if (meshPath != null) {
      this.manager.dataSourceProvider.getMeshSource(manager.chunkManager, meshPath)
          .then(meshSource => {
            if (!this.wasDisposed) {
              this.addMesh(this.chunkedGraph, meshSource);
            }
          });
    }

    if (skeletonsPath != null) {
      this.manager.dataSourceProvider.getSkeletonSource(manager.chunkManager, skeletonsPath)
          .then(skeletonSource => {
            if (!this.wasDisposed) {
              this.addSkeleton(this.chunkedGraph, skeletonSource);
            }
          });
    }

    if (!this.chunkedGraphUrl) {
      verifyObjectProperty(x, 'equivalences', y => {
        this.displayState.segmentEquivalences.restoreState(y);
      });

      verifyObjectProperty(x, 'segments', y => {
        if (y !== undefined) {
          let {rootSegments, segmentEquivalences} = this.displayState;
          parseArray(y, value => {
            let id = Uint64.parseString(String(value), 10);
            rootSegments.add(segmentEquivalences.get(id));
          });
        }
      });
    }

    verifyObjectProperty(x, 'clipBounds', y => {
      if (y === undefined) {
        return;
      }
      let center: vec3|undefined, size: vec3|undefined;
      verifyObjectProperty(y, 'center', z => center = verify3dVec(z));
      verifyObjectProperty(y, 'size', z => size = verify3dVec(z));
      if (!center || !size) {
        return;
      }
      let bounds = {center, size};
      this.displayState.clipBounds.value = bounds;
    });
  }

  addMesh(chunkedGraph: ChunkedGraph, meshSource: MeshSource) {
    this.meshLayer = new MeshLayer(this.manager.chunkManager, chunkedGraph, meshSource, this.displayState);
    this.addRenderLayer(this.meshLayer);
  }

  addSkeleton(chunkedGraph: ChunkedGraph, skeletonSource: SkeletonSource) {
    let base = new SkeletonLayer(
              this.manager.chunkManager, chunkedGraph, skeletonSource, this.manager.voxelSize, this.displayState);
    this.addRenderLayer(new PerspectiveViewSkeletonLayer(base.addRef()));
    this.addRenderLayer(new SliceViewPanelSkeletonLayer(/* transfer ownership */ base));
  }

  toJSON() {
    let x: any = {'type': 'segmentation'};
    x['source'] = this.volumePath;
    x['mesh'] = this.meshPath;
    x['skeletons'] = this.skeletonsPath;
    x['chunkedGraph'] = this.chunkedGraphUrl;
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.displayState.hideSegmentZero.toJSON();
    let {rootSegments} = this.displayState;
    if (rootSegments.size > 0) {
      x['segments'] = rootSegments.toJSON();
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size > 0 && !this.chunkedGraphUrl) { // Too many equivalences when using Chunked Graph
      x['equivalences'] = segmentEquivalences.toJSON();
    }
    let {clipBounds} = this.displayState;
    if (clipBounds.value) {
      x['clipBounds'] = {
        center: clipBounds.value.center,
        size: clipBounds.value.size,
      };
    }
    x['transform'] = this.displayState.objectToDataTransform.toJSON();
    x['skeletonShader'] = this.displayState.fragmentMain.toJSON();
    return x;
  }

  transformPickedValue(value: any) {
    if (value == null) {
      return value;
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size === 0) {
      return value;
    }
    if (typeof value === 'number') {
      value = new Uint64(value, 0);
    }
    let mappedValue = segmentEquivalences.get(value);
    if (Uint64.equal(mappedValue, value)) {
      return value;
    }
    return new Uint64MapEntry(value, mappedValue);
  }

  makeDropdown(element: HTMLDivElement) {
    return new SegmentationDropdown(element, this);
  }

  handleAction(action: string) {
    switch (action) {
      case 'recolor': {
        this.displayState.segmentColorHash.randomize();
        break;
      }
      case 'clear-segments': {
        this.displayState.rootSegments.clear();
        this.displayState.visibleSegments2D!.clear();
        this.displayState.visibleSegments3D.clear();
        this.displayState.segmentEquivalences.clear();
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
    }
  }

  selectSegment() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.selectedSegment;
      let {rootSegments} = this.displayState;
      if (rootSegments.has(segment)) {
        rootSegments.delete(segment);
      } else {
        this.chunkedGraph.getRoot(segment).then(rootSegment => {
          rootSegments.add(rootSegment);
        }).catch((e: Error) => {
          console.log(e);
          StatusMessage.showTemporaryMessage(e.message, 3000);
        });
      }
    }
  }

  mergeSelectFirst() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.rawSelectedSegment;
      let root = segmentSelectionState.selectedSegment;
      let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
        return Math.round(v / this.manager.voxelSize.size[i]);
      });

      this.pendingGraphMod = {
        source: [{segmentId: segment.clone(), rootId: root.clone(), position: coordinates}],
        sink: [{segmentId: new Uint64(0), rootId: new Uint64(0), position: coordinates}]
      };
      StatusMessage.showTemporaryMessage(`Selected ${segment} as source for merge. Pick a sink.`, 3000);
    }
  }

  mergeSelectSecond() {
    let {segmentSelectionState, rootSegments} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.rawSelectedSegment;
      let root = segmentSelectionState.selectedSegment;
      let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
        return Math.round(v / this.manager.voxelSize.size[i]);
      });

      this.pendingGraphMod.sink[0] = {segmentId: segment.clone(), rootId: root.clone(), position: coordinates};
      StatusMessage.showTemporaryMessage(`Selected ${segment} as sink for merge.`, 3000);

      if (this.chunkedGraphUrl) {
        this.chunkedGraph.mergeSegments(this.pendingGraphMod.source[0], this.pendingGraphMod.sink[0]).then((mergedRoot) => {
          rootSegments.delete(this.pendingGraphMod.sink[0].rootId);
          rootSegments.delete(this.pendingGraphMod.source[0].rootId);
          rootSegments.add(mergedRoot);
        });
      }
      else {
        this.displayState.segmentEquivalences.link(this.pendingGraphMod.source[0].segmentId, this.pendingGraphMod.sink[0].segmentId);
      }
    }
  }

  splitSelectFirst() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.rawSelectedSegment;
      let root = segmentSelectionState.selectedSegment;
      let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
        return Math.round(v / this.manager.voxelSize.size[i]);
      });

      this.pendingGraphMod = {
        source: [{segmentId: segment.clone(), rootId: root.clone(), position: coordinates}],
        sink: [{segmentId: new Uint64(0), rootId: new Uint64(0), position: coordinates}]
      };
      StatusMessage.showTemporaryMessage(`Selected ${segment} as source for split. Pick a sink.`, 3000);
    }
  }

  splitSelectSecond() {
    let {segmentSelectionState, rootSegments} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.rawSelectedSegment;
      let root = segmentSelectionState.selectedSegment;
      let coordinates = [...this.manager.layerSelectedValues.mouseState.position.values()].map((v, i) => {
        return Math.round(v / this.manager.voxelSize.size[i]);
      });

      this.pendingGraphMod.sink[0] = {segmentId: segment.clone(), rootId: root.clone(), position: coordinates};
      StatusMessage.showTemporaryMessage(`Selected ${segment} as sink for split.`, 3000);

      if (this.chunkedGraphUrl) {
        this.chunkedGraph.splitSegments(this.pendingGraphMod.source, this.pendingGraphMod.sink).then((splitRoots) => {
          if (splitRoots.length === 0) {
            StatusMessage.showTemporaryMessage(`No split found.`, 3000);
            return;
          }
          for (let sink of this.pendingGraphMod.sink) {
            rootSegments.delete(sink.rootId);
          }
          for (let splitRoot of splitRoots) {
            rootSegments.add(splitRoot);
          }
        });
      }
      else {
        StatusMessage.showTemporaryMessage('Cut without graph server not yet implemented.', 3000);
      }
    }
  }

  rootSegmentChange(rootSegment: Uint64 | null, added: boolean) {
    if (rootSegment === null && !added) {
      // Clear all segment sets
      let leafSegmentCount = this.displayState.visibleSegments2D!.size;
      this.displayState.visibleSegments2D!.clear();
      this.displayState.visibleSegments3D.clear();
      this.displayState.segmentEquivalences.clear();
      StatusMessage.showTemporaryMessage(`Deselected all ${leafSegmentCount} segments.`, 3000);
    } else if (added) {
      // No Graph Server:
      if (!this.chunkedGraphUrl) {
        this.displayState.visibleSegments3D.add(rootSegment!);
        this.displayState.visibleSegments2D!.add(rootSegment!);
        return;
      }

      // Add root to 3D set, and leaves to 2D set
      this.displayState.visibleSegments3D.add(rootSegment!);
      this.chunkedGraph.getLeaves(rootSegment!).then(leafSegments => {
        if (!this.displayState.rootSegments.has(rootSegment!)) {
          console.log('Adding 2D segments canceled due to missing root.');
          return;
        }

        for (let e of leafSegments) {
          this.displayState.visibleSegments2D!.add(e);
          this.displayState.segmentEquivalences.link(rootSegment!, e);
        }

        StatusMessage.showTemporaryMessage(`Selected ${leafSegments.length} segments.`, 3000);
      });
    } else if (!added) {
      let segments = [...this.displayState.segmentEquivalences.setElements(rootSegment!)];
      let segmentCount = segments.length; // Wrong count, but faster than below

      // let segmentCount = 0;
      // for (let seg of segments) {
      //   if (this.displayState.visibleSegments2D.has(seg)) {
      //     ++segmentCount;
      //   }
      // }

      for (let e of segments) {
        this.displayState.visibleSegments2D!.delete(e);
        this.displayState.visibleSegments3D.delete(e);
      }
      if (!this.chunkedGraphUrl) {
        // Without graph server, equivalent segments are also stored in `rootSegments`
        for (let e of segments) {
          this.displayState.rootSegments.delete(e);
        }
      }

      this.displayState.segmentEquivalences.deleteSet(rootSegment!);
      StatusMessage.showTemporaryMessage(`Deselected ${segmentCount} segments.`);
    }
    this.specificationChanged.dispatch();
  }
}

function makeSkeletonShaderCodeWidget(layer: SegmentationUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.fragmentMain,
    shaderError: layer.displayState.shaderError,
    fragmentMainStartLine: SKELETON_FRAGMENT_MAIN_START,
  });
}

class SegmentationDropdown extends UserLayerDropdown {
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer.displayState));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  skeletonDialog: HTMLElement|null|undefined;
  selectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.selectedAlpha));
  notSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.notSelectedAlpha));
  objectAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.objectAlpha));
  codeWidget: ShaderCodeWidget|undefined;
  chunkedGraphWidget: ChunkedGraphWidget|undefined;

  constructor(public element: HTMLDivElement, public layer: SegmentationUserLayer) {
    super();
    element.classList.add('segmentation-dropdown');
    let {selectedAlphaWidget, notSelectedAlphaWidget, objectAlphaWidget} = this;
    selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';
    objectAlphaWidget.promptElement.textContent = 'Opacity (3d)';

    element.appendChild(this.selectedAlphaWidget.element);
    element.appendChild(this.notSelectedAlphaWidget.element);
    element.appendChild(this.objectAlphaWidget.element);

    {
      const checkbox =
          this.registerDisposer(new TrackableBooleanCheckbox(layer.displayState.hideSegmentZero));
      checkbox.element.className =
          'neuroglancer-segmentation-dropdown-hide-segment-zero neuroglancer-noselect';
      const label = document.createElement('label');
      label.className =
          'neuroglancer-segmentation-dropdown-hide-segment-zero neuroglancer-noselect';
      label.appendChild(document.createTextNode('Hide segment ID 0'));
      label.appendChild(checkbox.element);
      element.appendChild(label);
    }

    if (layer.chunkedGraphUrl && this.chunkedGraphWidget == null) {
      const chunkedGraphWidget =
          this.registerDisposer(new ChunkedGraphWidget({url: layer.chunkedGraphUrl || ''}));
      element.appendChild(chunkedGraphWidget.element);
    }

    this.addSegmentWidget.element.classList.add('add-segment');
    this.addSegmentWidget.element.title = 'Add one or more segment IDs';
    element.appendChild(this.registerDisposer(this.addSegmentWidget).element);
    this.registerDisposer(this.addSegmentWidget.valuesEntered.add((values: Uint64[]) => {
      if (this.layer.chunkedGraphUrl) {
        for (const value of values) {
          this.layer.chunkedGraph.getRoot(value).then((rootSegment: Uint64) => {
            this.layer.displayState.rootSegments.add(rootSegment);
          }).catch((e: Error) => {
            console.log(e);
            StatusMessage.showTemporaryMessage(e.message, 3000);
          });
        }
      } else {
        for (const value of values) {
          this.layer.displayState.rootSegments.add(value);
        }
      }
    }));
    element.appendChild(this.registerDisposer(this.visibleSegmentWidget).element);
  }

  buildSkeletonDialog(element: HTMLDivElement) {
    let topRow = document.createElement('div');
    topRow.className = 'neuroglancer-segmentation-dropdown-skeleton-shader-header';
    let label = document.createElement('div');
    label.style.flex = '1';
    label.textContent = 'Skeleton shader:';
    let helpLink = document.createElement('a');
    let helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.textContent = '?';
    helpButton.className = 'help-link';
    helpLink.appendChild(helpButton);
    helpLink.title = 'Documentation on skeleton rendering';
    helpLink.target = '_blank';
    helpLink.href =
        'https://github.com/seung-lab/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md';

    let maximizeButton = document.createElement('button');
    maximizeButton.innerHTML = '&square;';
    maximizeButton.className = 'maximize-button';
    maximizeButton.title = 'Show larger editor view';
    this.registerEventListener(maximizeButton, 'click', () => {
      new ShaderCodeOverlay(this.layer);
    });

    topRow.appendChild(label);
    topRow.appendChild(maximizeButton);
    topRow.appendChild(helpLink);

    element.appendChild(topRow);

    const codeWidget = this.codeWidget =
        this.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
    element.appendChild(codeWidget.element);
    codeWidget.textEditor.refresh();
    this.skeletonDialog = topRow;
  }

  onShow() {
    if (this.codeWidget !== undefined) {
      this.codeWidget.textEditor.refresh();
    }

    if (this.layer.skeletonsPath !== undefined && this.skeletonDialog == null) {
      this.buildSkeletonDialog(this.element);
    }
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
  constructor(public layer: SegmentationUserLayer) {
    super();
    this.content.classList.add('neuroglancer-segmentation-layer-skeleton-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType('segmentation', SegmentationUserLayer);
registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);
