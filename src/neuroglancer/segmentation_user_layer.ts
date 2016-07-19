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

import {getMeshSource, getSkeletonSource} from 'neuroglancer/datasource/factory';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer} from 'neuroglancer/mesh/frontend';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentSelectionState, SegmentationDisplayState, Uint64MapEntry} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {PerspectiveViewSkeletonLayer, SkeletonLayer, SliceViewPanelSkeletonLayer} from 'neuroglancer/skeleton/frontend';
import {trackableAlphaValue} from 'neuroglancer/sliceview/renderlayer';
import {SegmentationRenderLayer} from 'neuroglancer/sliceview/segmentation_renderlayer';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {parseArray, verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';
import {RangeWidget} from 'neuroglancer/widget/range';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

require('./segmentation_user_layer.css');

export class SegmentationUserLayer extends UserLayer implements SegmentationDisplayState {
  segmentColorHash = SegmentColorHash.getDefault();
  segmentSelectionState = new SegmentSelectionState();
  selectedAlpha = trackableAlphaValue(0.5);
  notSelectedAlpha = trackableAlphaValue(0);
  visibleSegments = Uint64Set.makeWithCounterpart(this.manager.worker);
  segmentEquivalences = SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker);
  volumePath: string|undefined;
  meshPath: string|undefined;
  meshLod: number|undefined;
  skeletonsPath: string|undefined;
  meshLayer: MeshLayer|undefined;
  wasDisposed = false;

  constructor(public manager: LayerListSpecification, x: any) {
    super([]);
    this.visibleSegments.changed.add(() => { this.specificationChanged.dispatch(); });
    this.segmentEquivalences.changed.add(() => { this.specificationChanged.dispatch(); });
    this.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.selectedAlpha.changed.add(() => { this.specificationChanged.dispatch(); });
    this.notSelectedAlpha.changed.add(() => { this.specificationChanged.dispatch(); });

    this.selectedAlpha.restoreState(x['selectedAlpha']);
    this.notSelectedAlpha.restoreState(x['notSelectedAlpha']);

    let volumePath = this.volumePath = verifyOptionalString(x['source']);
    let meshPath = this.meshPath = verifyOptionalString(x['mesh']);
    let skeletonsPath = this.skeletonsPath = verifyOptionalString(x['skeletons']);
    if (volumePath !== undefined) {
      let volumePromise = getVolumeWithStatusMessage(volumePath);
      volumePromise.then(volume => {
        if (!this.wasDisposed) {
          if (!this.meshLayer) {
            let meshSource = volume.getMeshSource(this.manager.chunkManager);
            if (meshSource != null) {
              this.addMesh(meshSource);
            }
          }
        }
      });
      this.addRenderLayer(new SegmentationRenderLayer(
          manager.chunkManager, volumePromise, this, this.selectedAlpha, this.notSelectedAlpha));
    }
    if (meshPath !== undefined) {
      let meshLod = x['meshLod'];
      if (typeof meshLod !== 'number') {
        meshLod = undefined;
      }
      this.meshLod = meshLod;
      this.addMesh(getMeshSource(manager.chunkManager, meshPath, meshLod));
    }
    if (skeletonsPath !== undefined) {
      let base = new SkeletonLayer(
          manager.chunkManager, getSkeletonSource(manager.chunkManager, skeletonsPath),
          manager.voxelSize, this);
      this.addRenderLayer(new PerspectiveViewSkeletonLayer(base));
      this.addRenderLayer(new SliceViewPanelSkeletonLayer(base));
    }

    verifyObjectProperty(x, 'equivalences', y => { this.segmentEquivalences.restoreState(y); });

    verifyObjectProperty(x, 'segments', y => {
      if (y !== undefined) {
        let {visibleSegments, segmentEquivalences} = this;
        parseArray(y, value => {
          let id = Uint64.parseString(String(value), 10);
          visibleSegments.add(segmentEquivalences.get(id));
        });
      }
    });
  }

  disposed() {
    super.disposed();
    this.wasDisposed = true;
  }

  addMesh(meshSource: MeshSource) {
    this.meshLayer = new MeshLayer(this.manager.chunkManager, meshSource, this);
    this.addRenderLayer(this.meshLayer);
  }

  toJSON() {
    let x: any = {'type': 'segmentation'};
    x['source'] = this.volumePath;
    x['mesh'] = this.meshPath;
    x['meshLod'] = this.meshLod;
    x['skeletons'] = this.skeletonsPath;
    x['selectedAlpha'] = this.selectedAlpha.toJSON();
    x['notSelectedAlpha'] = this.notSelectedAlpha.toJSON();
    let {visibleSegments} = this;
    if (visibleSegments.size > 0) {
      x['segments'] = visibleSegments.toJSON();
    }
    let {segmentEquivalences} = this;
    if (segmentEquivalences.size > 0) {
      x['equivalences'] = segmentEquivalences.toJSON();
    }
    return x;
  }

  transformPickedValue(value: any) {
    if (value == null) {
      return value;
    }
    let {segmentEquivalences} = this;
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

  makeDropdown(element: HTMLDivElement) { return new SegmentationDropdown(element, this); }

  handleAction(action: string) {
    switch (action) {
      case 'recolor': {
        this.segmentColorHash.randomize();
        break;
      }
      case 'clear-segments': {
        this.visibleSegments.clear();
        break;
      }
      case 'select': {
        let {segmentSelectionState} = this;
        if (segmentSelectionState.hasSelectedSegment) {
          let segment = segmentSelectionState.selectedSegment;
          let {visibleSegments} = this;
          if (visibleSegments.has(segment)) {
            visibleSegments.delete(segment);
          } else {
            visibleSegments.add(segment);
          }
        }
        break;
      }
    }
  }
};

class SegmentationDropdown extends UserLayerDropdown {
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  selectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.selectedAlpha));
  notSelectedAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.notSelectedAlpha));
  constructor(public element: HTMLDivElement, public layer: SegmentationUserLayer) {
    super();
    element.classList.add('segmentation-dropdown');
    let {selectedAlphaWidget, notSelectedAlphaWidget} = this;
    selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';

    element.appendChild(this.selectedAlphaWidget.element);
    element.appendChild(this.notSelectedAlphaWidget.element);
    this.addSegmentWidget.element.classList.add('add-segment');
    this.addSegmentWidget.element.title = 'Add segment ID';
    element.appendChild(this.registerDisposer(this.addSegmentWidget).element);
    this.registerSignalBinding(this.addSegmentWidget.valueEntered.add(
        (value: Uint64) => { this.layer.visibleSegments.add(value); }));
    element.appendChild(this.registerDisposer(this.visibleSegmentWidget).element);
  }
};
