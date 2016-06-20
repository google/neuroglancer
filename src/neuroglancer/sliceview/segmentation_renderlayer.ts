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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {GPUHashTable, HashTableShaderManager} from 'neuroglancer/gpu_hash/shader';
import {SegmentColorShaderManager} from 'neuroglancer/segment_color';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state';
import {MultiscaleVolumeChunkSource, SliceView} from 'neuroglancer/sliceview/frontend';
import {RenderLayer, trackableAlphaValue} from 'neuroglancer/sliceview/renderlayer';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

export class SegmentationRenderLayer extends RenderLayer {
  private selectedSegmentForShader = new Float32Array(8);
  private segmentColorShaderManager = new SegmentColorShaderManager('segmentColorHash');
  private hashTableManager = new HashTableShaderManager('visibleSegments');
  private gpuHashTable = GPUHashTable.get(this.gl, this.displayState.visibleSegments.hashTable);
  constructor(
      chunkManager: ChunkManager, multiscaleSourcePromise: Promise<MultiscaleVolumeChunkSource>,
      public displayState: SegmentationDisplayState,
      public selectedAlpha = trackableAlphaValue(0.5),
      public notSelectedAlpha = trackableAlphaValue(0)) {
    super(chunkManager, multiscaleSourcePromise);
    this.registerSignalBinding(
        displayState.segmentSelectionState.changed.add(this.redrawNeeded.dispatch, this));
    this.registerSignalBinding(
        displayState.segmentColorHash.changed.add(this.redrawNeeded.dispatch, this));
    this.registerSignalBinding(
        displayState.visibleSegments.changed.add(this.redrawNeeded.dispatch, this));
    this.registerSignalBinding(selectedAlpha.changed.add(() => { this.redrawNeeded.dispatch(); }));
    this.registerSignalBinding(
        notSelectedAlpha.changed.add(() => { this.redrawNeeded.dispatch(); }));
  }

  getShaderKey() { return 'sliceview.SegmentationRenderLayer'; }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.hashTableManager.defineShader(builder);
    this.segmentColorShaderManager.defineShader(builder);
    builder.addUniform('highp vec4', 'uSelectedSegment', 2);
    builder.addUniform('highp float', 'uShowAllSegments');
    builder.addUniform('highp float', 'uSelectedAlpha');
    builder.addUniform('highp float', 'uNotSelectedAlpha');
    builder.setFragmentMain(`
  uint64_t value = toUint64(getDataValue());
  float alpha = uSelectedAlpha;
  float saturation = 1.0;
  if (value.low == vec4(0,0,0,0) && value.high == vec4(0,0,0,0)) {
    emit(vec4(vec4(0, 0, 0, 0)));
    return;
  }
  bool has = uShowAllSegments > 0.0 ? true : ${this.hashTableManager.hasFunctionName}(value);
  if (uSelectedSegment[0] == value.low && uSelectedSegment[1] == value.high) {
    saturation = has ? 0.5 : 0.75;
  } else if (!has) {
    alpha = uNotSelectedAlpha;
  }
  vec3 rgb = segmentColorHash(value);
  emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
`);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    let gl = this.gl;
    let selectedSegmentForShader = this.selectedSegmentForShader;

    let {displayState} = this;
    let {segmentSelectionState, visibleSegments} = this.displayState;
    if (!segmentSelectionState.hasSelectedSegment) {
      selectedSegmentForShader.fill(0);
    } else {
      let seg = segmentSelectionState.selectedSegment;
      let low = seg.low, high = seg.high;
      for (let i = 0; i < 4; ++i) {
        selectedSegmentForShader[i] = ((low >> (8 * i)) & 0xFF) / 255.0;
        selectedSegmentForShader[4 + i] = ((high >> (8 * i)) & 0xFF) / 255.0;
      }
    }
    gl.uniform1f(shader.uniform('uSelectedAlpha'), this.selectedAlpha.value);
    gl.uniform1f(shader.uniform('uNotSelectedAlpha'), this.notSelectedAlpha.value);
    gl.uniform4fv(shader.uniform('uSelectedSegment'), selectedSegmentForShader);
    gl.uniform1f(shader.uniform('uShowAllSegments'), visibleSegments.hashTable.size ? 0.0 : 1.0);
    this.hashTableManager.enable(gl, shader, this.gpuHashTable);

    this.segmentColorShaderManager.enable(gl, shader, displayState.segmentColorHash);
    return shader;
  }
  endSlice(shader: ShaderProgram) {
    let {gl} = this;
    this.hashTableManager.disable(gl, shader);
    super.endSlice(shader);
  }
};
