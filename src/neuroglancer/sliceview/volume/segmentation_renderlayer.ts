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

import {HashMapUint64} from 'neuroglancer/gpu_hash/hash_table';
import {GPUHashTable, HashMapShaderManager, HashSetShaderManager} from 'neuroglancer/gpu_hash/shader';
import {SegmentColorShaderManager, SegmentStatedColorShaderManager} from 'neuroglancer/segment_color';
import {getVisibleSegments} from 'neuroglancer/segmentation_display_state/base';
import {registerRedrawWhenSegmentationDisplayStateChanged, SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {SliceView, SliceViewSingleResolutionSource} from 'neuroglancer/sliceview/frontend';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {RenderLayerBaseOptions, SliceViewVolumeRenderLayer} from 'neuroglancer/sliceview/volume/renderlayer';
import {AggregateWatchableValue, makeCachedDerivedWatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {DisjointUint64Sets} from 'neuroglancer/util/disjoint_sets';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export class EquivalencesHashMap {
  generation = Number.NaN;
  hashMap = new HashMapUint64();
  constructor(public disjointSets: DisjointUint64Sets) {}
  update() {
    let {disjointSets} = this;
    const {generation} = disjointSets;
    if (this.generation !== generation) {
      this.generation = generation;
      let {hashMap} = this;
      hashMap.clear();
      for (let [objectId, minObjectId] of disjointSets.mappings()) {
        hashMap.set(objectId, minObjectId);
      }
    }
  }
}

export interface SliceViewSegmentationDisplayState extends SegmentationDisplayState,
                                                           RenderLayerBaseOptions {
  selectedAlpha: WatchableValueInterface<number>;
  notSelectedAlpha: WatchableValueInterface<number>;
  hideSegmentZero: WatchableValueInterface<boolean>;
  ignoreNullVisibleSet: WatchableValueInterface<boolean>;
}

interface ShaderParameters {
  hasEquivalences: boolean;
  baseSegmentColoring: boolean;
  hasSegmentStatedColors: boolean;
  hideSegmentZero: boolean;
  hasSegmentDefaultColor: boolean;
}

export class SegmentationRenderLayer extends SliceViewVolumeRenderLayer<ShaderParameters> {
  public readonly segmentationGroupState = this.displayState.segmentationGroupState.value;
  protected segmentColorShaderManager = new SegmentColorShaderManager('segmentColorHash');
  protected segmentStatedColorShaderManager =
      new SegmentStatedColorShaderManager('segmentStatedColor');
  private gpuSegmentStatedColorHashTable: GPUHashTable<HashMapUint64>|undefined;
  private hashTableManager = new HashSetShaderManager('visibleSegments');
  private gpuHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.segmentationGroupState.visibleSegments.hashTable));
  private gpuTemporaryHashTable =
      GPUHashTable.get(this.gl, this.segmentationGroupState.temporaryVisibleSegments.hashTable);
  private equivalencesShaderManager = new HashMapShaderManager('equivalences');
  private equivalencesHashMap =
      new EquivalencesHashMap(this.segmentationGroupState.segmentEquivalences.disjointSets);
  private temporaryEquivalencesHashMap =
      new EquivalencesHashMap(this.segmentationGroupState.temporarySegmentEquivalences.disjointSets);
  private gpuEquivalencesHashTable =
      this.registerDisposer(GPUHashTable.get(this.gl, this.equivalencesHashMap.hashMap));
  private gpuTemporaryEquivalencesHashTable =
      this.registerDisposer(GPUHashTable.get(this.gl, this.temporaryEquivalencesHashMap.hashMap));

  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      public displayState: SliceViewSegmentationDisplayState) {
    super(multiscaleSource, {
      shaderParameters: new AggregateWatchableValue(
          refCounted => ({
            hasEquivalences: refCounted.registerDisposer(makeCachedDerivedWatchableValue(
                x => x.size !== 0,
                [displayState.segmentationGroupState.value.segmentEquivalences])),
            hasSegmentStatedColors: refCounted.registerDisposer(makeCachedDerivedWatchableValue(
                x => x.size !== 0, [displayState.segmentStatedColors])),
            hasSegmentDefaultColor: refCounted.registerDisposer(makeCachedDerivedWatchableValue(
                x => x !== undefined, [displayState.segmentDefaultColor])),
            hideSegmentZero: displayState.hideSegmentZero,
            baseSegmentColoring: displayState.baseSegmentColoring,
          })),
      transform: displayState.transform,
      renderScaleHistogram: displayState.renderScaleHistogram,
      renderScaleTarget: displayState.renderScaleTarget,
      localPosition: displayState.localPosition,
    });
    this.registerDisposer(this.shaderParameters as AggregateWatchableValue<ShaderParameters>);
    registerRedrawWhenSegmentationDisplayStateChanged(displayState, this);
    this.registerDisposer(displayState.selectedAlpha.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(displayState.notSelectedAlpha.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(
        displayState.ignoreNullVisibleSet.changed.add(this.redrawNeeded.dispatch));
  }

  disposed() {
    this.gpuSegmentStatedColorHashTable?.dispose();
  }

  getSources(options: SliceViewSourceOptions):
      SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    return this.multiscaleSource.getSources({...options, discreteValues: true});
  }

  defineShader(builder: ShaderBuilder, parameters: ShaderParameters) {
    this.hashTableManager.defineShader(builder);
    let getUint64Code = `
uint64_t getUint64DataValue() {
  uint64_t x = toUint64(getDataValue());
`;
    getUint64Code += `return x;
}
`;
    builder.addFragmentCode(getUint64Code);
    if (parameters.hasEquivalences) {
      this.equivalencesShaderManager.defineShader(builder);
      builder.addFragmentCode(`
uint64_t getMappedObjectId(uint64_t value) {
  uint64_t mappedValue;
  if (${this.equivalencesShaderManager.getFunctionName}(value, mappedValue)) {
    return mappedValue;
  }
  return value;
}
`);
    } else {
      builder.addFragmentCode(`
uint64_t getMappedObjectId(uint64_t value) {
  return value;
}
`);
    }
    builder.addUniform('highp uvec2', 'uSelectedSegment');
    builder.addUniform('highp uint', 'uShowAllSegments');
    builder.addUniform('highp float', 'uSelectedAlpha');
    builder.addUniform('highp float', 'uNotSelectedAlpha');
    builder.addUniform('highp float', 'uSaturation');
    let fragmentMain = `
  uint64_t baseValue = getUint64DataValue();
  uint64_t value = getMappedObjectId(baseValue);
  uint64_t valueForColor = ${parameters.baseSegmentColoring?'baseValue':'value'};

  float alpha = uSelectedAlpha;
  float saturation = uSaturation;
`;
    if (parameters.hideSegmentZero) {
      fragmentMain += `
  if (value.value[0] == 0u && value.value[1] == 0u) {
    emit(vec4(vec4(0, 0, 0, 0)));
    return;
  }
`;
    }
    fragmentMain += `
  bool has = uShowAllSegments != 0u ? true : ${this.hashTableManager.hasFunctionName}(value);
  if (uSelectedSegment == value.value) {
    float adjustment = has ? 0.5 : 0.75;
    if (saturation > adjustment) {
      saturation -= adjustment;
    } else {
      saturation += adjustment;
    }
  } else if (!has) {
    alpha = uNotSelectedAlpha;
  }
`;

    let getMappedIdColor = `vec3 getMappedIdColor(uint64_t value) {
`;
    // If the value has a mapped color, use it; otherwise, compute the color.
    if (parameters.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder);
      getMappedIdColor += `
  vec3 rgb;
  if (${this.segmentStatedColorShaderManager.getFunctionName}(value, rgb)) {
    return rgb;
  }
`;
    }
    if (parameters.hasSegmentDefaultColor) {
      builder.addUniform('highp vec3', 'uSegmentDefaultColor');
      getMappedIdColor += `  return uSegmentDefaultColor;
`;
    } else {
      this.segmentColorShaderManager.defineShader(builder);
      getMappedIdColor += `  return segmentColorHash(value);
`;
    }
    getMappedIdColor += `
}
`;
    builder.addFragmentCode(getMappedIdColor);

    fragmentMain += `
  vec3 rgb = getMappedIdColor(valueForColor);
  emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
`;
    builder.setFragmentMain(fragmentMain);
  }

  initializeShader(_sliceView: SliceView, shader: ShaderProgram, parameters: ShaderParameters) {
    const {gl} = this;
    const {displayState, segmentationGroupState} = this;
    const {segmentSelectionState} = this.displayState;
    const {segmentDefaultColor: {value: segmentDefaultColor}, segmentColorHash: {value: segmentColorHash}} = this.displayState;
    const visibleSegments = getVisibleSegments(segmentationGroupState);
    const ignoreNullSegmentSet = this.displayState.ignoreNullVisibleSet.value;
    let selectedSegmentLow = 0, selectedSegmentHigh = 0;
    if (segmentSelectionState.hasSelectedSegment) {
      let seg = segmentSelectionState.selectedSegment;
      selectedSegmentLow = seg.low;
      selectedSegmentHigh = seg.high;
    }
    gl.uniform1f(shader.uniform('uSelectedAlpha'), displayState.selectedAlpha.value);
    gl.uniform1f(shader.uniform('uSaturation'), displayState.saturation.value);
    gl.uniform1f(shader.uniform('uNotSelectedAlpha'), displayState.notSelectedAlpha.value);
    gl.uniform2ui(shader.uniform('uSelectedSegment'), selectedSegmentLow, selectedSegmentHigh);
    gl.uniform1ui(
        shader.uniform('uShowAllSegments'),
        visibleSegments.hashTable.size || !ignoreNullSegmentSet ? 0 : 1);
    this.hashTableManager.enable(
        gl, shader,
        segmentationGroupState.useTemporaryVisibleSegments.value ? this.gpuTemporaryHashTable :
                                                                   this.gpuHashTable);
    if (parameters.hasEquivalences) {
      const useTemp = segmentationGroupState.useTemporarySegmentEquivalences.value;
      (useTemp ? this.temporaryEquivalencesHashMap : this.equivalencesHashMap).update();
      this.equivalencesShaderManager.enable(
          gl, shader,
          useTemp ? this.gpuTemporaryEquivalencesHashTable : this.gpuEquivalencesHashTable);
    }
    if (segmentDefaultColor === undefined) {
      this.segmentColorShaderManager.enable(gl, shader, segmentColorHash);
    } else {
      gl.uniform3fv(shader.uniform('uSegmentDefaultColor'), segmentDefaultColor);
    }
    if (parameters.hasSegmentStatedColors) {
      const segmentStatedColors = this.displayState.segmentStatedColors.value;
      let {gpuSegmentStatedColorHashTable} = this;
      if (gpuSegmentStatedColorHashTable === undefined ||
          gpuSegmentStatedColorHashTable.hashTable !== segmentStatedColors.hashTable) {
        gpuSegmentStatedColorHashTable?.dispose();
        this.gpuSegmentStatedColorHashTable = gpuSegmentStatedColorHashTable =
            GPUHashTable.get(gl, segmentStatedColors.hashTable);
      }
      this.segmentStatedColorShaderManager.enable(gl, shader, gpuSegmentStatedColorHashTable);
    }
  }
  endSlice(sliceView: SliceView, shader: ShaderProgram, parameters: ShaderParameters) {
    const {gl} = this;
    this.hashTableManager.disable(gl, shader);
    if (parameters.hasEquivalences) {
      this.equivalencesShaderManager.disable(gl, shader);
    }
    if (parameters.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.disable(gl, shader);
    }
    super.endSlice(sliceView, shader, parameters);
  }
}
