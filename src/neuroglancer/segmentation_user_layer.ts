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

import 'neuroglancer/noselect.css';
import 'neuroglancer/segmentation_user_layer.css';

import {UserLayer} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {MeshLayer, MultiscaleMeshLayer} from 'neuroglancer/mesh/frontend';
import {Overlay} from 'neuroglancer/overlay';
import {getRenderMeshByDefault} from 'neuroglancer/preferences/user_preferences';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {SegmentMetadata, SegmentToVoxelCountMap} from 'neuroglancer/segment_metadata';
import {SegmentSelectionState, Uint64MapEntry, SegmentationDisplayState3D} from 'neuroglancer/segmentation_display_state/frontend';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {FRAGMENT_MAIN_START as SKELETON_FRAGMENT_MAIN_START, PerspectiveViewSkeletonLayer, SkeletonLayer, SkeletonRenderingOptions, SkeletonSource, SliceViewPanelSkeletonLayer, ViewSpecificSkeletonRenderingOptions, SkeletonLayerDisplayState} from 'neuroglancer/skeleton/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {SegmentationRenderLayer, SliceViewSegmentationDisplayState} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {ElementVisibilityFromTrackableBoolean, TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {ComputedWatchableValue} from 'neuroglancer/trackable_value';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {Uint64Map} from 'neuroglancer/uint64_map';
import {UserLayerWithVolumeSourceMixin} from 'neuroglancer/user_layer_with_volume_source';
import {parseRGBColorSpecification, packColor} from 'neuroglancer/util/color';
import {Borrowed} from 'neuroglancer/util/disposable';
import {parseArray, verifyObjectProperty, verifyOptionalString, verifyObjectAsMap} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {EnumSelectWidget} from 'neuroglancer/widget/enum_widget';
import {MinimizableGroupWidget} from 'neuroglancer/widget/minimizable_group';
import {OmniSegmentWidget} from 'neuroglancer/widget/omni_segment_widget';
import {RangeWidget} from 'neuroglancer/widget/range';
import {RenderScaleWidget} from 'neuroglancer/widget/render_scale_widget';
import {SegmentSetWidget} from 'neuroglancer/widget/segment_set_widget';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';
import {Tab} from 'neuroglancer/widget/tab_view';
import {Uint64EntryWidget} from 'neuroglancer/widget/uint64_entry_widget';

const SELECTED_ALPHA_JSON_KEY = 'selectedAlpha';
const NOT_SELECTED_ALPHA_JSON_KEY = 'notSelectedAlpha';
const OBJECT_ALPHA_JSON_KEY = 'objectAlpha';
const SATURATION_JSON_KEY = 'saturation';
const HIDE_SEGMENT_ZERO_JSON_KEY = 'hideSegmentZero';
const MESH_JSON_KEY = 'mesh';
const SKELETONS_JSON_KEY = 'skeletons';
const ROOT_SEGMENTS_JSON_KEY = 'segments';
const HIDDEN_ROOT_SEGMENTS_JSON_KEY = 'hiddenSegments';
const HIGHLIGHTS_JSON_KEY = 'highlights';
const EQUIVALENCES_JSON_KEY = 'equivalences';
const COLOR_SEED_JSON_KEY = 'colorSeed';
const SEGMENT_STATED_COLORS_JSON_KEY = 'segmentColors';
const MESH_RENDER_SCALE_JSON_KEY = 'meshRenderScale';

const SKELETON_RENDERING_JSON_KEY = 'skeletonRendering';
const SKELETON_SHADER_JSON_KEY = 'skeletonShader';
const SEGMENTS_TO_VOXEL_COUNT_MAP_PATH_JSON_KEY = 'segmentMetadata';
const SEGMENT_CATEGORIES_JSON_KEY = 'segmentCategories';
const CATEGORIZED_SEGMENTS_JSON_KEY = 'categorizedSegments';
const SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY = 'shatterSegmentEquivalences';

export type SegmentationUserLayerDisplayState =
    SliceViewSegmentationDisplayState&SkeletonLayerDisplayState&SegmentationDisplayState3D;

const lastSegmentSelection = new Uint64();

const Base = UserLayerWithVolumeSourceMixin(UserLayer);
export class SegmentationUserLayer extends Base {
  displayState: SegmentationUserLayerDisplayState = {
    segmentColorHash: SegmentColorHash.getDefault(),
    segmentStatedColors: Uint64Map.makeWithCounterpart(this.manager.worker),
    segmentSelectionState: new SegmentSelectionState(),
    selectedAlpha: trackableAlphaValue(0.5),
    saturation: trackableAlphaValue(1.0),
    notSelectedAlpha: trackableAlphaValue(0),
    objectAlpha: trackableAlphaValue(1.0),
    hideSegmentZero: new TrackableBoolean(true, true),
    rootSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    hiddenRootSegments: new Uint64Set(),
    visibleSegments2D: new Uint64Set(),
    visibleSegments3D: Uint64Set.makeWithCounterpart(this.manager.worker),
    highlightedSegments: Uint64Set.makeWithCounterpart(this.manager.worker),
    segmentEquivalences: SharedDisjointUint64Sets.makeWithCounterpart(this.manager.worker),
    objectToDataTransform: this.transform,
    skeletonRenderingOptions: new SkeletonRenderingOptions(),
    shaderError: makeWatchableShaderError(),
    renderScaleHistogram: new RenderScaleHistogram(),
    renderScaleTarget: trackableRenderScaleTarget(1),
    shatterSegmentEquivalences: new TrackableBoolean(false, false),
  };

  /**
   * If meshPath is undefined, a default mesh source provided by the volume may be used.  If
   * meshPath is null, the default mesh source is not used.
   */
  meshPath: string|null|undefined;
  skeletonsPath: string|null|undefined;
  segmentToVoxelCountMapPath: string|undefined;
  meshLayer: Borrowed<MeshLayer|MultiscaleMeshLayer>|undefined;
  skeletonLayer: Borrowed<SkeletonLayer>|undefined;
  segmentMetadata: Borrowed<SegmentMetadata>|undefined;

  // Dispatched when either meshLayer or skeletonLayer changes.
  objectLayerStateChanged = new NullarySignal();

  constructor(public manager: LayerListSpecification, x: any) {
    super(manager, x);
    this.displayState.rootSegments.changed.add((segmentIds: Uint64[]|Uint64|null, add: boolean) => {
      if (segmentIds !== null) {
        segmentIds = Array<Uint64>().concat(segmentIds);
      }
      this.rootSegmentChange(segmentIds, add);
    });
    this.displayState.visibleSegments2D!.changed.add(this.specificationChanged.dispatch);
    this.displayState.visibleSegments3D.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentEquivalences.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentSelectionState.bindTo(manager.layerSelectedValues, this);
    this.displayState.selectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.saturation.changed.add(this.specificationChanged.dispatch);
    this.displayState.notSelectedAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.objectAlpha.changed.add(this.specificationChanged.dispatch);
    this.displayState.hideSegmentZero.changed.add(this.specificationChanged.dispatch);
    this.displayState.skeletonRenderingOptions.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentColorHash.changed.add(this.specificationChanged.dispatch);
    this.displayState.segmentStatedColors.changed.add(this.specificationChanged.dispatch);
    this.displayState.renderScaleTarget.changed.add(this.specificationChanged.dispatch);
    this.displayState.shatterSegmentEquivalences.changed.add(this.specificationChanged.dispatch);
    this.tabs.add(
        'rendering', {label: 'Rendering', order: -100, getter: () => new DisplayOptionsTab(this)});
    this.tabs.default = 'rendering';
  }

  get volumeOptions() {
    return {volumeType: VolumeType.SEGMENTATION};
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    this.displayState.selectedAlpha.restoreState(specification[SELECTED_ALPHA_JSON_KEY]);
    this.displayState.saturation.restoreState(specification[SATURATION_JSON_KEY]);
    this.displayState.notSelectedAlpha.restoreState(specification[NOT_SELECTED_ALPHA_JSON_KEY]);
    this.displayState.objectAlpha.restoreState(specification[OBJECT_ALPHA_JSON_KEY]);
    this.displayState.hideSegmentZero.restoreState(specification[HIDE_SEGMENT_ZERO_JSON_KEY]);

    const {skeletonRenderingOptions} = this.displayState;
    skeletonRenderingOptions.restoreState(specification[SKELETON_RENDERING_JSON_KEY]);
    const skeletonShader = specification[SKELETON_SHADER_JSON_KEY];
    if (skeletonShader !== undefined) {
      skeletonRenderingOptions.shader.restoreState(skeletonShader);
    }
    this.displayState.segmentColorHash.restoreState(specification[COLOR_SEED_JSON_KEY]);
    this.displayState.renderScaleTarget.restoreState(specification[MESH_RENDER_SCALE_JSON_KEY]);
    this.displayState.shatterSegmentEquivalences.restoreState(
        specification[SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY]);

    verifyObjectProperty(specification, EQUIVALENCES_JSON_KEY, y => {
      this.displayState.segmentEquivalences.restoreState(y);
    });

    const restoreSegmentsList = (key: string, segments: Uint64Set) => {
      verifyObjectProperty(specification, key, y => {
        if (y !== undefined) {
          let {segmentEquivalences} = this.displayState;
          parseArray(y, value => {
            let id = Uint64.parseString(String(value), 10);
            segments.add(segmentEquivalences.get(id));
          });
        }
      });
    };

    restoreSegmentsList(ROOT_SEGMENTS_JSON_KEY, this.displayState.rootSegments);
    restoreSegmentsList(HIDDEN_ROOT_SEGMENTS_JSON_KEY, this.displayState.hiddenRootSegments!);
    restoreSegmentsList(HIGHLIGHTS_JSON_KEY, this.displayState.highlightedSegments);

    this.displayState.highlightedSegments.changed.add(() => {
      this.specificationChanged.dispatch();
    });

    verifyObjectProperty(specification, SEGMENT_STATED_COLORS_JSON_KEY, y => {
      if (y !== undefined) {
        let {segmentEquivalences} = this.displayState;
        let result = verifyObjectAsMap(y, x => parseRGBColorSpecification(String(x)));
        for (let [idStr, colorVec] of result) {
          const id = Uint64.parseString(String(idStr));
          const color = new Uint64(packColor(colorVec));
          this.displayState.segmentStatedColors.set(segmentEquivalences.get(id), color);
        }
      }
    });

    const {multiscaleSource} = this;
    let meshPath = this.meshPath = specification[MESH_JSON_KEY] === null ?
        null :
        verifyOptionalString(specification[MESH_JSON_KEY]);
    let skeletonsPath = this.skeletonsPath = specification[SKELETONS_JSON_KEY] === null ?
        null :
        verifyOptionalString(specification[SKELETONS_JSON_KEY]);
    const segmentToVoxelCountMapPath = this.segmentToVoxelCountMapPath =
        verifyOptionalString(specification[SEGMENTS_TO_VOXEL_COUNT_MAP_PATH_JSON_KEY]);
    let remaining = 0;
    if (meshPath != null && getRenderMeshByDefault()) {
      ++remaining;
      this.manager.dataSourceProvider.getMeshSource(this.manager.chunkManager, meshPath)
          .then(meshSource => {
            if (!this.wasDisposed && getRenderMeshByDefault()) {
              this.addMesh(meshSource);
              if (--remaining === 0) {
                this.isReady = true;
              }
            }
          });
    }

    if (skeletonsPath != null) {
      ++remaining;
      this.manager.dataSourceProvider.getSkeletonSource(this.manager.chunkManager, skeletonsPath)
          .then(skeletonSource => {
            if (!this.wasDisposed) {
              this.addSkeleton(skeletonSource);
              if (--remaining === 0) {
                this.isReady = true;
              }
            }
          });
    }

    if (segmentToVoxelCountMapPath) {
      ++remaining;
      this.manager.dataSourceProvider
          .getSegmentToVoxelCountMap(this.manager.chunkManager, segmentToVoxelCountMapPath)
          .then(segmentToVoxelCountMap => {
            if (!this.wasDisposed) {
              if (--remaining === 0) {
                this.isReady = true;
              }
            }
            if (segmentToVoxelCountMap) {
              this.restoreSegmentMetadata(
                  segmentToVoxelCountMap, specification[SEGMENT_CATEGORIES_JSON_KEY],
                  specification[CATEGORIZED_SEGMENTS_JSON_KEY]);
            } else {
              StatusMessage.showTemporaryMessage(
                  'Segment metadata file specified in JSON state does not exist so omni segment widget won\'t be shown',
                  6000);
            }
          });
    }

    if (multiscaleSource !== undefined) {
      ++remaining;
      multiscaleSource.then(volume => {
        if (!this.wasDisposed) {
          const {displayState} = this;
          this.addRenderLayer(new SegmentationRenderLayer(volume, {
            ...displayState,
            transform: displayState.objectToDataTransform,
            renderScaleHistogram: this.sliceViewRenderScaleHistogram,
            renderScaleTarget: this.sliceViewRenderScaleTarget,
          }));
          // Meshes
          if (meshPath === undefined && getRenderMeshByDefault()) {
            ++remaining;
            Promise.resolve(volume.getMeshSource()).then(meshSource => {
              if (this.wasDisposed) {
                if (meshSource !== null) {
                  meshSource.dispose();
                }
                return;
              }
              if (--remaining === 0) {
                this.isReady = true;
              }
              if ((meshSource instanceof MeshSource) ||
                  (meshSource instanceof MultiscaleMeshSource)) {
                this.addMesh(meshSource);
              }
            });
          }
          if (skeletonsPath === undefined && volume.getSkeletonSource) {
            ++remaining;
            Promise.resolve(volume.getSkeletonSource()).then(skeletonSource => {
              if (this.wasDisposed) {
                if (skeletonSource !== null) {
                  skeletonSource.dispose();
                }
                return;
              }
              if (--remaining === 0) {
                this.isReady = true;
              }
              if (skeletonSource) {
                this.addSkeleton(skeletonSource);
              }
            });
          }
          if (segmentToVoxelCountMapPath === undefined && volume.getSegmentToVoxelCountMap) {
            ++remaining;
            Promise.resolve(volume.getSegmentToVoxelCountMap()).then(segmentToVoxelCountMap => {
              if (this.wasDisposed) {
                return;
              }
              if (--remaining === 0) {
                this.isReady = true;
              }
              if (segmentToVoxelCountMap) {
                this.restoreSegmentMetadata(
                    segmentToVoxelCountMap, specification[SEGMENT_CATEGORIES_JSON_KEY],
                    specification[CATEGORIZED_SEGMENTS_JSON_KEY]);
              }
            });
          }
          if (--remaining === 0) {
            this.isReady = true;
          }
        }
      });
    }
  }

  addMesh(meshSource: MeshSource|MultiscaleMeshSource) {
    if (meshSource instanceof MeshSource) {
      this.meshLayer = new MeshLayer(this.manager.chunkManager, meshSource, this.displayState);
    } else {
      this.meshLayer =
          new MultiscaleMeshLayer(this.manager.chunkManager, meshSource, this.displayState);
    }
    this.addRenderLayer(this.meshLayer);
    this.objectLayerStateChanged.dispatch();
  }

  addSkeleton(skeletonSource: SkeletonSource) {
    let base = new SkeletonLayer(
        this.manager.chunkManager, skeletonSource, this.manager.voxelSize, this.displayState);
    this.skeletonLayer = base;
    this.addRenderLayer(new PerspectiveViewSkeletonLayer(base.addRef()));
    this.addRenderLayer(new SliceViewPanelSkeletonLayer(/* transfer ownership */ base));
    this.objectLayerStateChanged.dispatch();
  }

  toJSON() {
    const x = super.toJSON();
    x['type'] = 'segmentation';
    x[MESH_JSON_KEY] = this.meshPath;
    x[SKELETONS_JSON_KEY] = this.skeletonsPath;
    x[SELECTED_ALPHA_JSON_KEY] = this.displayState.selectedAlpha.toJSON();
    x[NOT_SELECTED_ALPHA_JSON_KEY] = this.displayState.notSelectedAlpha.toJSON();
    x[SATURATION_JSON_KEY] = this.displayState.saturation.toJSON();
    x[OBJECT_ALPHA_JSON_KEY] = this.displayState.objectAlpha.toJSON();
    x[HIDE_SEGMENT_ZERO_JSON_KEY] = this.displayState.hideSegmentZero.toJSON();
    x[COLOR_SEED_JSON_KEY] = this.displayState.segmentColorHash.toJSON();
    let {segmentStatedColors} = this.displayState;
    if (segmentStatedColors.size > 0) {
      let json = segmentStatedColors.toJSON();
      // Convert colors from decimal integers to CSS "#RRGGBB" format.
      Object.keys(json).map(k => json[k] = '#' + parseInt(json[k], 10).toString(16).padStart(6, '0'));
      x[SEGMENT_STATED_COLORS_JSON_KEY] = json;
    }
    let {rootSegments} = this.displayState;
    if (rootSegments.size > 0) {
      x[ROOT_SEGMENTS_JSON_KEY] = rootSegments.toJSON();
    }
    const {hiddenRootSegments} = this.displayState;
    if (hiddenRootSegments!.size > 0) {
      x[HIDDEN_ROOT_SEGMENTS_JSON_KEY] = hiddenRootSegments!.toJSON();
    }
    let {highlightedSegments} = this.displayState;
    if (highlightedSegments.size > 0) {
      x[HIGHLIGHTS_JSON_KEY] = highlightedSegments.toJSON();
    }
    let {segmentEquivalences} = this.displayState;
    if (segmentEquivalences.size > 0) {
      x[EQUIVALENCES_JSON_KEY] = segmentEquivalences.toJSON();
    }
    x[SKELETON_RENDERING_JSON_KEY] = this.displayState.skeletonRenderingOptions.toJSON();
    x[MESH_RENDER_SCALE_JSON_KEY] = this.displayState.renderScaleTarget.toJSON();
    x[SEGMENTS_TO_VOXEL_COUNT_MAP_PATH_JSON_KEY] = this.segmentToVoxelCountMapPath;
    if (this.segmentMetadata) {
      const segmentCategories = this.segmentMetadata.segmentCategoriesToJSON();
      if (segmentCategories.length > 0) {
        x[SEGMENT_CATEGORIES_JSON_KEY] = segmentCategories;
        const categorizedSegments = this.segmentMetadata.categorizedSegmentsToJSON();
        if (categorizedSegments.length > 0) {
          x[CATEGORIZED_SEGMENTS_JSON_KEY] = categorizedSegments;
        }
      }
    }
    x[SHATTER_SEGMENT_EQUIVALENCES_JSON_KEY] =
        this.displayState.shatterSegmentEquivalences.toJSON();
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
      case 'merge-selected': {
        // Merge all visible segments
        const {segmentEquivalences, rootSegments} = this.displayState;
        const [firstSegment, ...segments] = rootSegments;
        segmentEquivalences.link(firstSegment, segments);

        // Cleanup by removing all old root segments
        const newRootSegment = segmentEquivalences.get(firstSegment);
        rootSegments.delete([...rootSegments].filter(id => !Uint64.equal(id, newRootSegment)));
        break;
      }
      case 'cut-selected': {
        const {segmentEquivalences, rootSegments} = this.displayState;
        for (const rootSegment of rootSegments) {
          const segments = [...segmentEquivalences.setElements(rootSegment)];
          segmentEquivalences.deleteSet(rootSegment);
          rootSegments.add(segments.filter(id => !Uint64.equal(id, rootSegment)));
        }
        break;
      }
      case 'select': {
        this.selectSegment();
        break;
      }
      case 'highlight': {
        this.highlightSegment();
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
        this.displayState.shatterSegmentEquivalences.value =
            !this.displayState.shatterSegmentEquivalences.value;
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
        rootSegments.add(segment);
      }
    }
  }

  highlightSegment() {
    let {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      let segment = segmentSelectionState.selectedSegment;
      let {highlightedSegments} = this.displayState;
      if (highlightedSegments.has(segment)) {
        highlightedSegments.delete(segment);
      } else {
        highlightedSegments.add(segment);
      }
    }
  }

  mergeSelectFirst() {
    const {segmentSelectionState} = this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      lastSegmentSelection.assign(segmentSelectionState.rawSelectedSegment);
      StatusMessage.showTemporaryMessage(
          `Selected ${lastSegmentSelection} as source for merge. Pick a sink.`, 3000);
    }
  }

  mergeSelectSecond() {
    const {segmentSelectionState, segmentEquivalences, rootSegments, visibleSegments3D} =
        this.displayState;
    if (segmentSelectionState.hasSelectedSegment) {
      // Merge both selected segments
      const segment = segmentSelectionState.rawSelectedSegment.clone();
      segmentEquivalences.link(lastSegmentSelection, segment);

      // Cleanup by removing superseded root segments
      const newRootSegment = segmentEquivalences.get(segment);
      const equivalentSegments = [...segmentEquivalences.setElements(newRootSegment)];
      rootSegments.delete(equivalentSegments.filter(
          id => rootSegments.has(id) && !Uint64.equal(id, newRootSegment)));

      // Ensure merged group will be fully visible
      if (rootSegments.has(newRootSegment)) {
        visibleSegments3D.add(equivalentSegments);
      } else {
        rootSegments.add(newRootSegment);
      }
    }
  }

  splitSelectFirst() {
    StatusMessage.showTemporaryMessage('Cut without graph server not yet implemented.', 3000);
  }

  splitSelectSecond() {
    StatusMessage.showTemporaryMessage('Cut without graph server not yet implemented.', 3000);
  }

  rootSegmentChange(rootSegments: Uint64[]|null, added: boolean) {
    if (rootSegments === null) {
      if (added) {
        return;
      } else {
        this.displayState.visibleSegments2D!.clear();
        this.displayState.visibleSegments3D.clear();
      }
    } else if (added) {
      const segments = rootSegments.flatMap(
          rootSegment => [...this.displayState.segmentEquivalences.setElements(rootSegment)]);
      this.displayState.visibleSegments2D!.add(rootSegments!);
      this.displayState.visibleSegments3D.add(segments);
    } else if (!added) {
      for (const rootSegment of rootSegments) {
        const equivalentSegments =
            [...this.displayState.segmentEquivalences.setElements(rootSegment)];
        let removeVisibleSegments = true;
        for (const equivalentSegment of equivalentSegments) {
          if (this.displayState.rootSegments.has(equivalentSegment)) {
            removeVisibleSegments = false;
            break;
          }
        }
        if (removeVisibleSegments) {
          this.displayState.visibleSegments2D!.delete(rootSegment);
          this.displayState.visibleSegments3D.delete(equivalentSegments);
        }
      }
    }
    this.specificationChanged.dispatch();
  }

  restoreSegmentMetadata(
      segmentToVoxelCountMap: SegmentToVoxelCountMap, segmentCategoriesObj: any,
      categorizedSegmentsObj: any) {
    this.segmentMetadata = SegmentMetadata.restoreState(
        segmentToVoxelCountMap, segmentCategoriesObj, categorizedSegmentsObj);
    this.segmentMetadata.changed.add(this.specificationChanged.dispatch);
    this.objectLayerStateChanged.dispatch();
  }
}

function makeSkeletonShaderCodeWidget(layer: SegmentationUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.skeletonRenderingOptions.shader,
    shaderError: layer.displayState.shaderError,
    fragmentMainStartLine: SKELETON_FRAGMENT_MAIN_START,
  });
}

class DisplayOptionsTab extends Tab {
  private group2D = this.registerDisposer(new MinimizableGroupWidget('2D Visualization'));
  private group3D = this.registerDisposer(new MinimizableGroupWidget('3D Visualization'));
  private groupSegmentSelection =
      this.registerDisposer(new MinimizableGroupWidget('Segment Selection'));
  private groupOmniInfo = this.registerDisposer(new MinimizableGroupWidget('Omni Segment Info'));
  visibleSegmentWidget = this.registerDisposer(new SegmentSetWidget(this.layer.displayState));
  addSegmentWidget = this.registerDisposer(new Uint64EntryWidget());
  selectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.selectedAlpha));
  notSelectedAlphaWidget =
      this.registerDisposer(new RangeWidget(this.layer.displayState.notSelectedAlpha));
  saturationWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.saturation));
  objectAlphaWidget = this.registerDisposer(new RangeWidget(this.layer.displayState.objectAlpha));
  codeWidget: ShaderCodeWidget|undefined;
  omniWidget: OmniSegmentWidget|undefined;

  constructor(public layer: SegmentationUserLayer) {
    super();
    const {element} = this;
    element.classList.add('segmentation-dropdown');
    const {group2D, group3D, groupSegmentSelection, groupOmniInfo} = this;
    let {selectedAlphaWidget, notSelectedAlphaWidget, saturationWidget, objectAlphaWidget} = this;
    selectedAlphaWidget.promptElement.textContent = 'Opacity (on)';
    notSelectedAlphaWidget.promptElement.textContent = 'Opacity (off)';
    saturationWidget.promptElement.textContent = 'Saturation';
    objectAlphaWidget.promptElement.textContent = 'Opacity (3d)';

    if (this.layer.volumePath !== undefined) {
      group2D.appendFixedChild(this.selectedAlphaWidget.element);
      group2D.appendFixedChild(this.notSelectedAlphaWidget.element);
      group2D.appendFixedChild(this.saturationWidget.element);

      {
        const renderScaleWidget = this.registerDisposer(new RenderScaleWidget(
            this.layer.sliceViewRenderScaleHistogram, this.layer.sliceViewRenderScaleTarget));
        renderScaleWidget.label.textContent = 'Resolution (slice)';
        group2D.appendFixedChild(renderScaleWidget.element);
      }
    }
    const has3dLayer = this.registerDisposer(new ComputedWatchableValue(
        () => this.layer.meshPath || this.layer.meshLayer || this.layer.skeletonsPath ||
                this.layer.skeletonLayer ?
            true :
            false,
        this.layer.objectLayerStateChanged));
    this.registerDisposer(
        new ElementVisibilityFromTrackableBoolean(has3dLayer, this.objectAlphaWidget.element));

    {
      const renderScaleWidget = this.registerDisposer(new RenderScaleWidget(
          this.layer.displayState.renderScaleHistogram, this.layer.displayState.renderScaleTarget));
      renderScaleWidget.label.textContent = 'Resolution (mesh)';
      group3D.appendFixedChild(renderScaleWidget.element);
      this.registerDisposer(
          new ElementVisibilityFromTrackableBoolean(has3dLayer, renderScaleWidget.element));
    }
    group3D.appendFixedChild(this.objectAlphaWidget.element);

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
      groupSegmentSelection.appendFixedChild(label);
    }

    this.addSegmentWidget.element.classList.add('add-segment');
    this.addSegmentWidget.element.title = 'Add one or more segment IDs';
    groupSegmentSelection.appendFixedChild(this.registerDisposer(this.addSegmentWidget).element);
    this.registerDisposer(this.addSegmentWidget.valuesEntered.add((values: Uint64[]) => {
      for (const value of values) {
        this.layer.displayState.rootSegments.add(value);
      }
    }));
    groupSegmentSelection.appendFlexibleChild(
        this.registerDisposer(this.visibleSegmentWidget).element);

    const maybeAddOmniSegmentWidget = () => {
      if (this.omniWidget || (!layer.segmentMetadata)) {
        return;
      }
      {
        this.omniWidget =
            this.registerDisposer(new OmniSegmentWidget(layer.displayState, layer.segmentMetadata));
        groupOmniInfo.appendFlexibleChild(this.omniWidget.element);
      }
    };

    const maybeAddSkeletonShaderUI = () => {
      if (this.codeWidget !== undefined) {
        return;
      }
      if (this.layer.skeletonsPath === null || this.layer.skeletonLayer === undefined) {
        return;
      }
      const addViewSpecificSkeletonRenderingControls =
          (options: ViewSpecificSkeletonRenderingOptions, viewName: string) => {
            {
              const widget = this.registerDisposer(new EnumSelectWidget(options.mode));
              const label = document.createElement('label');
              label.className =
                  'neuroglancer-segmentation-dropdown-skeleton-render-mode neuroglancer-noselect';
              label.appendChild(document.createTextNode(`Skeleton mode (${viewName})`));
              label.appendChild(widget.element);
              group3D.appendFixedChild(label);
            }
            {
              const widget = this.registerDisposer(
                  new RangeWidget(options.lineWidth, {min: 1, max: 40, step: 1}));
              widget.promptElement.textContent = `Skeleton line width (${viewName})`;
              group3D.appendFixedChild(widget.element);
            }
          };
      addViewSpecificSkeletonRenderingControls(
          layer.displayState.skeletonRenderingOptions.params2d, '2d');
      addViewSpecificSkeletonRenderingControls(
          layer.displayState.skeletonRenderingOptions.params3d, '3d');
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
          'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/image_layer_rendering.md';

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

      group3D.appendFixedChild(topRow);

      const codeWidget = this.codeWidget =
          this.registerDisposer(makeSkeletonShaderCodeWidget(this.layer));
      group3D.appendFlexibleChild(codeWidget.element);
      codeWidget.textEditor.refresh();
    };
    this.registerDisposer(this.layer.objectLayerStateChanged.add(maybeAddSkeletonShaderUI));
    this.registerDisposer(this.layer.objectLayerStateChanged.add(maybeAddOmniSegmentWidget));
    maybeAddSkeletonShaderUI();
    maybeAddOmniSegmentWidget();

    element.appendChild(group2D.element);
    element.appendChild(group3D.element);
    element.appendChild(groupSegmentSelection.element);
    element.appendChild(groupOmniInfo.element);

    this.visibility.changed.add(() => {
      if (this.visible) {
        if (this.codeWidget !== undefined) {
          this.codeWidget.textEditor.refresh();
        }
      }
    });
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
