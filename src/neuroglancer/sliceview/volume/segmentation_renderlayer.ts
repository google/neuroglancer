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
  hasSegmentStatedColors: boolean;
  hideSegmentZero: boolean;
}

export class SegmentationRenderLayer extends SliceViewVolumeRenderLayer<ShaderParameters> {
  public readonly segmentationGroupState = this.displayState.segmentationGroupState.value;
  protected segmentColorShaderManager = new SegmentColorShaderManager('segmentColorHash');
  protected segmentStatedColorShaderManager =
      new SegmentStatedColorShaderManager('segmentStatedColor');
  private gpuSegmentStatedColorHashTable =
      GPUHashTable.get(this.gl, this.segmentationGroupState.segmentStatedColors.hashTable);

  private hashTableManager = new HashSetShaderManager('visibleSegments');
  private gpuHashTable = GPUHashTable.get(this.gl, this.segmentationGroupState.visibleSegments.hashTable);
  private equivalencesShaderManager = new HashMapShaderManager('equivalences');
  private equivalencesHashMap =
      new EquivalencesHashMap(this.segmentationGroupState.segmentEquivalences.disjointSets);
  private gpuEquivalencesHashTable = GPUHashTable.get(this.gl, this.equivalencesHashMap.hashMap);

  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      public displayState: SliceViewSegmentationDisplayState) {
    super(multiscaleSource, {
      shaderParameters: new AggregateWatchableValue(
          refCounted => ({
            hasEquivalences: refCounted.registerDisposer(makeCachedDerivedWatchableValue(
                x => x.size !== 0, [displayState.segmentationGroupState.value.segmentEquivalences])),
            hasSegmentStatedColors: refCounted.registerDisposer(makeCachedDerivedWatchableValue(
                x => x.size !== 0, [displayState.segmentationGroupState.value.segmentStatedColors])),
            hideSegmentZero: displayState.hideSegmentZero,
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

  getSources(options: SliceViewSourceOptions):
      SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    return this.multiscaleSource.getSources({...options, discreteValues: true});
  }

  defineShader(builder: ShaderBuilder, parameters: ShaderParameters) {
    this.hashTableManager.defineShader(builder);
    builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  return toUint64(getDataValue());
}
`);
    if (parameters.hasEquivalences) {
      this.equivalencesShaderManager.defineShader(builder);
      builder.addFragmentCode(`
uint64_t getMappedObjectId() {
  uint64_t value = getUint64DataValue();
  uint64_t mappedValue;
  if (${this.equivalencesShaderManager.getFunctionName}(value, mappedValue)) {
    return mappedValue;
  }
  return value;
}
`);
    } else {
      builder.addFragmentCode(`
uint64_t getMappedObjectId() {
  return getUint64DataValue();
}
`);
    }
    this.segmentColorShaderManager.defineShader(builder);
    builder.addUniform('highp uvec2', 'uSelectedSegment');
    builder.addUniform('highp uint', 'uShowAllSegments');
    builder.addUniform('highp float', 'uSelectedAlpha');
    builder.addUniform('highp float', 'uNotSelectedAlpha');
    builder.addUniform('highp float', 'uSaturation');
    let fragmentMain = `
  uint64_t value = getMappedObjectId();

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
    // If the value has a mapped color, use it; otherwise, compute the color.
    if (parameters.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder);
      fragmentMain += `
  vec3 rgb;
  if (!${this.segmentStatedColorShaderManager.getFunctionName}(value, rgb)) {
    rgb = segmentColorHash(value);
  }
`;
    } else {
      fragmentMain += `
  vec3 rgb = segmentColorHash(value);
`;
    }

    fragmentMain += `
  emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
`;
    builder.setFragmentMain(fragmentMain);
  }

  initializeShader(_sliceView: SliceView, shader: ShaderProgram, parameters: ShaderParameters) {
    const {gl} = this;
    const {segmentSelectionState} = this.displayState;
    const {visibleSegments, segmentColorHash} = this.segmentationGroupState;
    const ignoreNullSegmentSet = this.displayState.ignoreNullVisibleSet.value;
    let selectedSegmentLow = 0, selectedSegmentHigh = 0;
    if (segmentSelectionState.hasSelectedSegment) {
      let seg = segmentSelectionState.selectedSegment;
      selectedSegmentLow = seg.low;
      selectedSegmentHigh = seg.high;
    }
    gl.uniform1f(shader.uniform('uSelectedAlpha'), this.displayState.selectedAlpha.value);
    gl.uniform1f(shader.uniform('uSaturation'), this.displayState.saturation.value);
    gl.uniform1f(shader.uniform('uNotSelectedAlpha'), this.displayState.notSelectedAlpha.value);
    gl.uniform2ui(shader.uniform('uSelectedSegment'), selectedSegmentLow, selectedSegmentHigh);
    gl.uniform1ui(
        shader.uniform('uShowAllSegments'),
        visibleSegments.hashTable.size || !ignoreNullSegmentSet ? 0 : 1);
    this.hashTableManager.enable(gl, shader, this.gpuHashTable);
    if (parameters.hasEquivalences) {
      this.equivalencesHashMap.update();
      this.equivalencesShaderManager.enable(gl, shader, this.gpuEquivalencesHashTable);
    }

    this.segmentColorShaderManager.enable(gl, shader, segmentColorHash);
    if (parameters.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.enable(gl, shader, this.gpuSegmentStatedColorHashTable);
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
