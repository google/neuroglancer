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
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {RenderLayerOptions} from 'neuroglancer/sliceview/renderlayer';
import {VolumeSourceOptions} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/volume/renderlayer';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {Uint64Set} from 'neuroglancer/uint64_set';
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
                                                           RenderLayerOptions {
  selectedAlpha: TrackableAlphaValue;
  notSelectedAlpha: TrackableAlphaValue;
  volumeSourceOptions?: VolumeSourceOptions;
  hideSegmentZero: TrackableBoolean;
  ignoreSegmentInteractions: TrackableBoolean;
  multicutSegments?: Uint64Set;
  performingMulticut?: TrackableBoolean;
}

export class SegmentationRenderLayer extends RenderLayer {
  protected segmentColorShaderManager = new SegmentColorShaderManager('segmentColorHash');
  protected segmentStatedColorShaderManager = new SegmentStatedColorShaderManager('segmentStatedColor');
  private gpuSegmentStatedColorHashTable = GPUHashTable.get(this.gl, this.displayState.segmentStatedColors.hashTable);
  private hasSegmentStatedColors: boolean;

  private hashTableManager = new HashSetShaderManager('visibleSegments2D');
  private gpuHashTable = GPUHashTable.get(this.gl, this.displayState.visibleSegments2D!.hashTable);
  private hashTableManagerHighlighted = new HashSetShaderManager('highlightedSegments');
  private gpuHashTableHighlighted =
      GPUHashTable.get(this.gl, this.displayState.highlightedSegments.hashTable);
  private hashTableManagerMulticut = new HashSetShaderManager('multicutSegments');
  private gpuHashTableMulticut = (this.displayState.multicutSegments) ?
      GPUHashTable.get(this.gl, this.displayState.multicutSegments.hashTable) :
      undefined;

  private equivalencesShaderManager = new HashMapShaderManager('equivalences');
  private equivalencesHashMap =
      new EquivalencesHashMap(this.displayState.segmentEquivalences.disjointSets);
  private gpuEquivalencesHashTable = GPUHashTable.get(this.gl, this.equivalencesHashMap.hashMap);
  private hasEquivalences: boolean;

  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      public displayState: SliceViewSegmentationDisplayState) {
    super(multiscaleSource, {
      sourceOptions: displayState.volumeSourceOptions,
      transform: displayState.transform,
      renderScaleHistogram: displayState.renderScaleHistogram,
      renderScaleTarget: displayState.renderScaleTarget,
    });
    registerRedrawWhenSegmentationDisplayStateChanged(displayState, this);
    this.registerDisposer(displayState.selectedAlpha.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(displayState.hideSegmentZero.changed.add(() => {
      this.redrawNeeded.dispatch();
      this.shaderGetter.invalidateShader();
    }));
    this.registerDisposer(displayState.ignoreSegmentInteractions.changed.add(() => {
      this.redrawNeeded.dispatch();
      this.shaderGetter.invalidateShader();
    }));
    if (displayState.shatterSegmentEquivalences) {
      this.registerDisposer(displayState.shatterSegmentEquivalences.changed.add(() => {
        this.redrawNeeded.dispatch();
      }));
    }
    if (displayState.multicutSegments) {
      this.registerDisposer(displayState.multicutSegments.changed.add(() => {
        this.redrawNeeded.dispatch();
      }));
    }
    this.hasEquivalences = this.displayState.segmentEquivalences.size !== 0;
    displayState.segmentEquivalences.changed.add(() => {
      let {segmentEquivalences} = this.displayState;
      let hasEquivalences = segmentEquivalences.size !== 0;
      if (hasEquivalences !== this.hasEquivalences) {
        this.hasEquivalences = hasEquivalences;
        this.shaderGetter.invalidateShader();
        // No need to trigger redraw, since that will happen anyway.
      }
    });
    this.registerDisposer(displayState.notSelectedAlpha.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.hasSegmentStatedColors = this.displayState.segmentStatedColors.size !== 0;
    displayState.segmentStatedColors.changed.add(() => {
      let {segmentStatedColors} = this.displayState;
      let hasSegmentStatedColors = segmentStatedColors.size !== 0;
      if (hasSegmentStatedColors !== this.hasSegmentStatedColors) {
        this.hasSegmentStatedColors = hasSegmentStatedColors;
        this.shaderGetter.invalidateShader();
        // No need to trigger redraw, since that will happen anyway.
      }
    });
  }

  getShaderKey() {
    // The shader to use depends on whether there are any equivalences, and any color mappings,
    // and on whether we are hiding segment ID 0.
    return `sliceview.SegmentationRenderLayer/${this.hasEquivalences}/` +
        `${this.hasSegmentStatedColors}/` +
        this.displayState.hideSegmentZero.value;
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.hashTableManager.defineShader(builder);
    this.hashTableManagerHighlighted.defineShader(builder);
    this.hashTableManagerMulticut.defineShader(builder);
    builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  return toUint64(getDataValue());
}
`);
    if (this.hasEquivalences) {
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
    if (this.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder);
    }
    builder.addUniform('highp uvec2', 'uSelectedSegment');
    builder.addUniform('highp uvec2', 'uRawSelectedSegment');
    builder.addUniform('highp uint', 'uShowAllSegments');
    builder.addUniform('highp float', 'uSelectedAlpha');
    builder.addUniform('highp float', 'uNotSelectedAlpha');
    builder.addUniform('highp float', 'uSaturation');
    builder.addUniform('highp uint', 'uShatterSegmentEquivalences');
    builder.addUniform('highp uint', 'uPerformingMulticut');
    let fragmentMain = `
  uint64_t value = getMappedObjectId();
  uint64_t rawValue = getUint64DataValue();

  float alpha = uSelectedAlpha;
  float saturation = uSaturation;
`;
    if (this.displayState.hideSegmentZero.value) {
      fragmentMain += `
  if (value.value[0] == 0u && value.value[1] == 0u) {
    emit(vec4(vec4(0, 0, 0, 0)));
    return;
  }
`;
    }
    fragmentMain += `
  if (uPerformingMulticut == 1u) {
    bool has = uShowAllSegments != 0u ? true : ${
        this.hashTableManagerMulticut.hasFunctionName}(value);
    if (!has) {
      emit(vec4(0.0, 0.0, 0.0, 0.5));
    } else {
      emit(vec4(0.0, 0.0, 0.0, 0.0));
    }
    return;
  } else {
`;
    fragmentMain += `
    bool has = uShowAllSegments != 0u ? true : ${this.hashTableManager.hasFunctionName}(value);
    if (uSelectedSegment == value.value) {
      saturation = has ? 0.5 : 0.75;
      if (uRawSelectedSegment == rawValue.value) {
        saturation *= 1.0/4.0;
      }
    } else if (!has) {
      alpha = uNotSelectedAlpha;
    }
    vec3 rgb;
  `;

    // If the value has a mapped color, use it; otherwise, compute the color.
    if (this.hasSegmentStatedColors) {
      fragmentMain += `
    if (!${this.segmentStatedColorShaderManager.getFunctionName}(value, rgb)) {
      if (uShatterSegmentEquivalences == 1u) {
        rgb = segmentColorHash(rawValue);
      } else {
        rgb = segmentColorHash(value);
      }
    }
  `;
    } else {
      fragmentMain += `
    if (uShatterSegmentEquivalences == 1u) {
      rgb = segmentColorHash(rawValue);
    } else {
      rgb = segmentColorHash(value);
    }
  `;
    }

    // Override color for all highlighted segments.
    fragmentMain += `
    if (${this.hashTableManagerHighlighted.hasFunctionName}(value)) {
      rgb = vec3(0.2,0.2,2.0);
      saturation = 1.0;
    };
  `;

    fragmentMain += `
    emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
  `;

    fragmentMain += `
  }
`;
    builder.setFragmentMain(fragmentMain);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    if (shader === undefined) {
      return undefined;
    }
    let gl = this.gl;

    let {displayState} = this;
    let {segmentSelectionState, rootSegments} = this.displayState;
    let selectedSegmentLow = 0, selectedSegmentHigh = 0;
    let rawSelectedSegmentLow = 0, rawSelectedSegmentHigh = 0;
    if (segmentSelectionState.hasSelectedSegment) {
      let seg = segmentSelectionState.selectedSegment;
      selectedSegmentLow = seg.low;
      selectedSegmentHigh = seg.high;
      let rawSeg = segmentSelectionState.rawSelectedSegment;
      rawSelectedSegmentLow = rawSeg.low;
      rawSelectedSegmentHigh = rawSeg.high;
    }
    gl.uniform1f(shader.uniform('uSelectedAlpha'), this.displayState.selectedAlpha.value);
    gl.uniform1f(shader.uniform('uSaturation'), this.displayState.saturation.value);
    gl.uniform1f(shader.uniform('uNotSelectedAlpha'), this.displayState.notSelectedAlpha.value);
    gl.uniform2ui(shader.uniform('uSelectedSegment'), selectedSegmentLow, selectedSegmentHigh);
    gl.uniform2ui(
        shader.uniform('uRawSelectedSegment'), rawSelectedSegmentLow, rawSelectedSegmentHigh);
    gl.uniform1ui(shader.uniform('uShowAllSegments'), rootSegments.hashTable.size ? 0 : 1);
    gl.uniform1ui(
        shader.uniform('uShatterSegmentEquivalences'),
        this.displayState.shatterSegmentEquivalences.value ? 1 : 0);
    // Boolean that represents whether the user is performing a multicut
    // for a segmentation layer with graph
    gl.uniform1ui(
        shader.uniform('uPerformingMulticut'),
        this.displayState.performingMulticut && this.displayState.performingMulticut.value &&
                this.displayState.multicutSegments && this.displayState.multicutSegments.size > 0 ?
            1 :
            0);
    this.hashTableManager.enable(gl, shader, this.gpuHashTable);
    this.hashTableManagerHighlighted.enable(gl, shader, this.gpuHashTableHighlighted);
    if (this.gpuHashTableMulticut) {
      this.hashTableManagerMulticut.enable(gl, shader, this.gpuHashTableMulticut);
    }
    if (this.hasEquivalences) {
      this.equivalencesHashMap.update();
      this.equivalencesShaderManager.enable(gl, shader, this.gpuEquivalencesHashTable);
    }

    this.segmentColorShaderManager.enable(gl, shader, displayState.segmentColorHash);
    if (this.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.enable(gl, shader, this.gpuSegmentStatedColorHashTable);
    }
    return shader;
  }
  endSlice(shader: ShaderProgram) {
    let {gl} = this;
    this.hashTableManager.disable(gl, shader);
    this.hashTableManagerHighlighted.disable(gl, shader);
    if (this.gpuHashTableMulticut) {
      this.hashTableManagerMulticut.disable(gl, shader);
    }
    super.endSlice(shader);
  }
}
