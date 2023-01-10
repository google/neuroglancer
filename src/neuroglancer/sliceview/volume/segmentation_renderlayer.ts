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
import {Uint64Map} from 'neuroglancer/uint64_map';

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
  baseSegmentHighlighting: boolean;
  hasSegmentStatedColors: boolean;
  hideSegmentZero: boolean;
  hasSegmentDefaultColor: boolean;
  hasHighlightColor: boolean;
}

const HAS_SELECTED_SEGMENT_FLAG = 1;
const SHOW_ALL_SEGMENTS_FLAG = 2;

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
                (segmentStatedColors: Uint64Map, tempSegmentStatedColors2d: Uint64Map, useTempSegmentStatedColors2d: boolean) => {
                  const releventMap = useTempSegmentStatedColors2d ? tempSegmentStatedColors2d : segmentStatedColors;
                  return releventMap.size !== 0;
                }, [displayState.segmentStatedColors, displayState.tempSegmentStatedColors2d, displayState.useTempSegmentStatedColors2d])),
            hasSegmentDefaultColor: refCounted.registerDisposer(makeCachedDerivedWatchableValue(
                (segmentDefaultColor, tempSegmentDefaultColor2d) => {
                  return segmentDefaultColor !== undefined || tempSegmentDefaultColor2d !== undefined;
                }, [displayState.segmentDefaultColor, displayState.tempSegmentDefaultColor2d])),
            hasHighlightColor: refCounted.registerDisposer(makeCachedDerivedWatchableValue(
                x => x !== undefined, [displayState.highlightColor])),
            hideSegmentZero: displayState.hideSegmentZero,
            baseSegmentColoring: displayState.baseSegmentColoring,
            baseSegmentHighlighting: displayState.baseSegmentHighlighting,
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
    builder.addUniform('highp uint', 'uFlags');
    builder.addUniform('highp float', 'uSelectedAlpha');
    builder.addUniform('highp float', 'uNotSelectedAlpha');
    builder.addUniform('highp float', 'uSaturation');
    let fragmentMain = `
  uint64_t baseValue = getUint64DataValue();
  uint64_t value = getMappedObjectId(baseValue);
  uint64_t valueForColor = ${parameters.baseSegmentColoring?'baseValue':'value'};
  uint64_t valueForHighlight = ${parameters.baseSegmentHighlighting?'baseValue':'value'};

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
  bool has = (uFlags & ${SHOW_ALL_SEGMENTS_FLAG}u) != 0u ? true : ${this.hashTableManager.hasFunctionName}(value);
  if ((uFlags & ${HAS_SELECTED_SEGMENT_FLAG}u) != 0u && uSelectedSegment == valueForHighlight.value) {
    float adjustment = has ? 0.5 : 0.75;
    if (saturation > adjustment) {
      saturation -= adjustment;
    } else {
      saturation += adjustment;
    }
`;
    if (parameters.hasHighlightColor) {
      builder.addUniform('highp vec4', 'uHighlightColor');
      fragmentMain += `
    emit(uHighlightColor);
    return;
`;
    }
    fragmentMain += `
  } else if (!has) {
    alpha = uNotSelectedAlpha;
  }
`;
    let getMappedIdColor = `vec4 getMappedIdColor(uint64_t value) {
`;
    // If the value has a mapped color, use it; otherwise, compute the color.
    if (parameters.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder);
      getMappedIdColor += `
  vec4 rgba;
  if (${this.segmentStatedColorShaderManager.getFunctionName}(value, rgba)) {
    return rgba;
  }
`;
    }
    if (parameters.hasSegmentDefaultColor) {
      builder.addUniform('highp vec4', 'uSegmentDefaultColor');
      getMappedIdColor += `  return uSegmentDefaultColor;
`;
    } else {
      this.segmentColorShaderManager.defineShader(builder);
      getMappedIdColor += `  return vec4(segmentColorHash(value), 0.0);
`;
    }
    getMappedIdColor += `
}
`;
    builder.addFragmentCode(getMappedIdColor);

    fragmentMain += `
  vec4 rgba = getMappedIdColor(valueForColor);
  if (rgba.a > 0.0) {
    alpha = rgba.a;
  }
  emit(vec4(mix(vec3(1.0,1.0,1.0), vec3(rgba), saturation), alpha));
`;
    builder.setFragmentMain(fragmentMain);
  }

  initializeShader(_sliceView: SliceView, shader: ShaderProgram, parameters: ShaderParameters) {
    const {gl} = this;
    const {displayState, segmentationGroupState} = this;
    const {segmentSelectionState} = this.displayState;
    const {segmentDefaultColor: {value: segmentDefaultColor}, segmentColorHash: {value: segmentColorHash},
      highlightColor: {value: highlightColor},
      tempSegmentDefaultColor2d: {value: tempSegmentDefaultColor2d}} = this.displayState;
    const visibleSegments = getVisibleSegments(segmentationGroupState);
    const ignoreNullSegmentSet = this.displayState.ignoreNullVisibleSet.value;
    let selectedSegmentLow = 0, selectedSegmentHigh = 0;
    let flags = 0;
    if (segmentSelectionState.hasSelectedSegment && displayState.hoverHighlight.value) {
      const seg = displayState.baseSegmentHighlighting.value ? segmentSelectionState.baseSelectedSegment :
                                                               segmentSelectionState.selectedSegment;
      selectedSegmentLow = seg.low;
      selectedSegmentHigh = seg.high;
      flags |= HAS_SELECTED_SEGMENT_FLAG;
    }
    gl.uniform1f(shader.uniform('uSelectedAlpha'), displayState.selectedAlpha.value);
    gl.uniform1f(shader.uniform('uSaturation'), displayState.saturation.value);
    gl.uniform1f(shader.uniform('uNotSelectedAlpha'), displayState.notSelectedAlpha.value);
    gl.uniform2ui(shader.uniform('uSelectedSegment'), selectedSegmentLow, selectedSegmentHigh);
    if (visibleSegments.hashTable.size === 0 && ignoreNullSegmentSet) {
      flags |= SHOW_ALL_SEGMENTS_FLAG;
    }
    gl.uniform1ui(shader.uniform('uFlags'), flags);
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
    let activeSegmentDefaultColor = tempSegmentDefaultColor2d || segmentDefaultColor;
    if (activeSegmentDefaultColor) {
      const [r, g, b, a] = activeSegmentDefaultColor;
      gl.uniform4f(shader.uniform('uSegmentDefaultColor'), r, g, b, a === undefined ? 0 : a);
    } else {
      this.segmentColorShaderManager.enable(gl, shader, segmentColorHash);
    }
    if (parameters.hasSegmentStatedColors) {
      const segmentStatedColors = displayState.useTempSegmentStatedColors2d.value ? displayState.tempSegmentStatedColors2d.value :
                                                                                    displayState.segmentStatedColors.value;
      let {gpuSegmentStatedColorHashTable} = this;
      if (gpuSegmentStatedColorHashTable === undefined ||
          gpuSegmentStatedColorHashTable.hashTable !== segmentStatedColors.hashTable) {
        gpuSegmentStatedColorHashTable?.dispose();
        this.gpuSegmentStatedColorHashTable = gpuSegmentStatedColorHashTable =
            GPUHashTable.get(gl, segmentStatedColors.hashTable);
      }
      this.segmentStatedColorShaderManager.enable(gl, shader, gpuSegmentStatedColorHashTable);
    }
    if (highlightColor !== undefined) {
      gl.uniform4fv(shader.uniform('uHighlightColor'), highlightColor);
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
