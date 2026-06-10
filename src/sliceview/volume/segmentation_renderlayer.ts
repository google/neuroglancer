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

import type { BrushHashTable } from "#src/brush_stroke/index.js";
import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import {
  GPUHashTable,
  HashMapShaderManager,
  HashSetShaderManager,
} from "#src/gpu_hash/shader.js";
import { getChunkPositionFromCombinedGlobalLocalPositions } from "#src/render_coordinate_transform.js";
import {
  SegmentColorShaderManager,
  SegmentStatedColorShaderManager,
} from "#src/segment_color.js";
import { getVisibleSegments } from "#src/segmentation_display_state/base.js";
import type {
  SegmentationDisplayState,
  SegmentationGroupState,
} from "#src/segmentation_display_state/frontend.js";
import { registerRedrawWhenSegmentationDisplayStateChanged } from "#src/segmentation_display_state/frontend.js";
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import type {
  FrontendTransformedSource,
  SliceView,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import type { RenderLayerBaseOptions } from "#src/sliceview/volume/renderlayer.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  AggregateWatchableValue,
  makeCachedDerivedWatchableValue,
} from "#src/trackable_value.js";
import type { Uint64Map } from "#src/uint64_map.js";
import type { DisjointUint64Sets } from "#src/util/disjoint_sets.js";
import * as matrix from "#src/util/matrix.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

export class EquivalencesHashMap {
  generation = Number.NaN;
  hashMap = new HashMapUint64();
  constructor(public disjointSets: DisjointUint64Sets) { }
  update() {
    const { disjointSets } = this;
    const { generation } = disjointSets;
    if (this.generation !== generation) {
      this.generation = generation;
      const { hashMap } = this;
      hashMap.clear();
      for (const [objectId, minObjectId] of disjointSets.mappings()) {
        hashMap.set(objectId, minObjectId);
      }
    }
  }
}

export interface SliceViewSegmentationDisplayState
  extends SegmentationDisplayState,
  RenderLayerBaseOptions {
  selectedAlpha: WatchableValueInterface<number>;
  notSelectedAlpha: WatchableValueInterface<number>;
  hideSegmentZero: WatchableValueInterface<boolean>;
  ignoreNullVisibleSet: WatchableValueInterface<boolean>;
  brushHashTable?: BrushHashTable;
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
const HAS_FOCUSED_SEGMENT_FLAG = 4;

export class SegmentationRenderLayer extends SliceViewVolumeRenderLayer<ShaderParameters> {
  public readonly segmentationGroupState: SegmentationGroupState;
  protected segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );
  protected segmentStatedColorShaderManager =
    new SegmentStatedColorShaderManager("segmentStatedColor");
  private gpuSegmentStatedColorHashTable:
    | GPUHashTable<HashMapUint64>
    | undefined;
  private hashTableManager = new HashSetShaderManager("visibleSegments");
  private gpuHashTable;
  private gpuTemporaryHashTable;
  private equivalencesShaderManager = new HashMapShaderManager("equivalences");
  private equivalencesHashMap;
  private temporaryEquivalencesHashMap;
  private gpuEquivalencesHashTable;
  private gpuTemporaryEquivalencesHashTable;
  // Brush-overlay machinery. Same prefix ("brushStroke") as the 2D
  // `BrushStrokeLayer`'s manager, so the GLSL helper functions are
  // named identically and `GPUHashTable.get(gl, table)` memoization
  // shares the underlying GPU resource across consumers.
  private brushHashTableManager = new HashMapShaderManager("brushStroke");
  private gpuBrushHashTable: GPUHashTable<HashMapUint64> | undefined;
  // Running min of per-source physical voxel size (meters) → the finest
  // (level-0) base, used to derive the brush-overlay downsample factor.
  private brushFinestVoxelSize: Float32Array | undefined;

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    public displayState: SliceViewSegmentationDisplayState,
  ) {
    super(multiscaleSource, {
      shaderParameters: new AggregateWatchableValue((refCounted) => ({
        hasEquivalences: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (x) => x.size !== 0,
            [displayState.segmentationGroupState.value.segmentEquivalences],
          ),
        ),
        hasSegmentStatedColors: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (
              segmentStatedColors: Uint64Map,
              tempSegmentStatedColors2d: Uint64Map,
              useTempSegmentStatedColors2d: boolean,
            ) => {
              const releventMap = useTempSegmentStatedColors2d
                ? tempSegmentStatedColors2d
                : segmentStatedColors;
              return releventMap.size !== 0;
            },
            [
              displayState.segmentStatedColors,
              displayState.tempSegmentStatedColors2d,
              displayState.useTempSegmentStatedColors2d,
            ],
          ),
        ),
        hasSegmentDefaultColor: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (segmentDefaultColor, tempSegmentDefaultColor2d) => {
              return (
                segmentDefaultColor !== undefined ||
                tempSegmentDefaultColor2d !== undefined
              );
            },
            [
              displayState.segmentDefaultColor,
              displayState.tempSegmentDefaultColor2d,
            ],
          ),
        ),
        hasHighlightColor: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (x) => x !== undefined,
            [displayState.highlightColor],
          ),
        ),
        hideSegmentZero: displayState.hideSegmentZero,
        baseSegmentColoring: displayState.baseSegmentColoring,
        baseSegmentHighlighting: displayState.baseSegmentHighlighting,
      })),
      transform: displayState.transform,
      renderScaleHistogram: displayState.renderScaleHistogram,
      renderScaleTarget: displayState.renderScaleTarget,
      localPosition: displayState.localPosition,
    });
    this.segmentationGroupState = displayState.segmentationGroupState.value;
    this.gpuHashTable = this.registerDisposer(
      GPUHashTable.get(
        this.gl,
        this.segmentationGroupState.visibleSegments.hashTable,
      ),
    );
    this.gpuTemporaryHashTable = GPUHashTable.get(
      this.gl,
      this.segmentationGroupState.temporaryVisibleSegments.hashTable,
    );
    this.equivalencesHashMap = new EquivalencesHashMap(
      this.segmentationGroupState.segmentEquivalences.disjointSets,
    );
    this.temporaryEquivalencesHashMap = new EquivalencesHashMap(
      this.segmentationGroupState.temporarySegmentEquivalences.disjointSets,
    );
    this.gpuEquivalencesHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.equivalencesHashMap.hashMap),
    );
    this.gpuTemporaryEquivalencesHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.temporaryEquivalencesHashMap.hashMap),
    );

    const { brushHashTable } = displayState;
    if (brushHashTable !== undefined) {
      this.gpuBrushHashTable = this.registerDisposer(
        GPUHashTable.get(this.gl, brushHashTable),
      );
      this.registerDisposer(
        brushHashTable.changed.add(() => {
          this.redrawNeeded.dispatch();
        }),
      );
    }

    this.registerDisposer(
      this.shaderParameters as AggregateWatchableValue<ShaderParameters>,
    );
    registerRedrawWhenSegmentationDisplayStateChanged(displayState, this);
    this.registerDisposer(
      displayState.selectedAlpha.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      displayState.notSelectedAlpha.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      displayState.ignoreNullVisibleSet.changed.add(this.redrawNeeded.dispatch),
    );
    if (displayState.focusedSegment) {
      this.registerDisposer(
        displayState.focusedSegment.changed.add(this.redrawNeeded.dispatch),
      );
    }
    if (displayState.focusDim) {
      this.registerDisposer(
        displayState.focusDim.changed.add(this.redrawNeeded.dispatch),
      );
    }
    const sources = this.multiscaleSource.getSources({
      multiscaleToViewTransform: matrix.createIdentity(
        Float32Array,
        multiscaleSource.rank,
      ),
      displayRank: this.multiscaleSource.rank,
      modelChannelDimensionIndices: [],
    });
    for (const resolutionLevel of sources) {
      for (const source of resolutionLevel) {
        source.chunkSource.setDisplayState(displayState);
      }
    }
  }

  disposed() {
    this.gpuSegmentStatedColorHashTable?.dispose();
  }

  getSources(
    options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    const sources = this.multiscaleSource.getSources({
      ...options,
      discreteValues: true,
    });
    for (const resolutionLevel of sources) {
      for (const source of resolutionLevel) {
        source.chunkSource.setDisplayState(this.displayState);
      }
    }
    return sources;
  }

  defineShader(builder: ShaderBuilder, parameters: ShaderParameters) {
    this.hashTableManager.defineShader(builder);
    const hasBrushOverlay = this.gpuBrushHashTable !== undefined;
    if (hasBrushOverlay) {
      this.brushHashTableManager.defineShader(builder);
      // Stash the vertex's un-nudged world position into a varying.
      // The parent's vertex main computes `vec3 position = ...`
      // (the actual world coord at the vertex), then adds
      // CHUNK_POSITION_EPSILON along the plane normal to
      // `vChunkPosition`. We want the un-nudged coord here so the
      // hash key we query exactly matches what the CPU brush
      // emit's Math.round saw at click time — no FP-precision
      // surprises at half-integer slice positions.
      builder.addVarying("highp vec3", "vBrushWorldPos");
      builder.addVertexMain("vBrushWorldPos = position;");
      // `vBrushWorldPos` is the vertex position in THIS source's voxel grid,
      // which equals full-res only at level 0. The brush hash is keyed in
      // full-res (model) voxels, so convert per source before hashing:
      //   fullResVoxel = position * scale
      // scale = the source's downsample factor relative to level 0 (1, 2, … 16),
      // set per-source in `setupSourceUniforms`. Without this, the eraser's
      // segment-suppression (which runs in THIS shader, unlike paint which
      // rides the separate overlay quad) misses at every coarse zoom.
      builder.addUniform("highp vec3", "uBrushSourceScale");
    }
    const brushLookup = hasBrushOverlay
      ? `
      {
        // Integer full-res voxel index under this fragment, matching the CPU
        // brush hash (getBrushKey does coord >>> 0). See uBrushSourceScale.
        uvec3 brushVoxel = uvec3(floor(vBrushWorldPos * uBrushSourceScale));
        uint x1 = brushVoxel.x;
        uint y1 = brushVoxel.y;
        uint z1 = brushVoxel.z;
        uint h1 = ((x1 * 73u) * 1271u) ^ ((y1 * 513u) * 1345u) ^ ((z1 * 421u) * 675u);
        uint h2 = ((x1 * 127u) * 337u) ^ ((y1 * 111u) * 887u) ^ ((z1 * 269u) * 325u);
        uint64_t brushKey;
        brushKey.value[0] = h1;
        brushKey.value[1] = h2;
        uint64_t brushValue;
        if (${this.brushHashTableManager.getFunctionName}(brushKey, brushValue)) {
          // value=0 marks "erased". Report the canonical "no segment" id (0)
          // rather than discarding: a raw \`discard\` does NOT reveal the
          // layer underneath in the slice-view compositor, but the value==0
          // transparent-emit path in fragmentMain (forced on whenever a
          // brush overlay is present) does. value>0 paints optimistically.
          if (brushValue.value[0] == 0u && brushValue.value[1] == 0u) {
            uint64_t erased;
            erased.value[0] = 0u;
            erased.value[1] = 0u;
            return erased;
          }
          return brushValue;
        }
      }
      `
      : "";
    const getUint64Code = `
    uint64_t getUint64DataValue() {
      ${brushLookup}
      uint64_t x = toUint64(getDataValue());
      return x;
    }`;
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
    builder.addUniform("highp uvec2", "uSelectedSegment");
    builder.addUniform("highp uvec2", "uFocusedSegment");
    builder.addUniform("highp float", "uFocusDim");
    builder.addUniform("highp uint", "uFlags");
    builder.addUniform("highp float", "uSelectedAlpha");
    builder.addUniform("highp float", "uNotSelectedAlpha");
    builder.addUniform("highp float", "uSaturation");
    let fragmentMain = `
  uint64_t baseValue = getUint64DataValue();
  uint64_t value = getMappedObjectId(baseValue);
  uint64_t valueForColor = ${parameters.baseSegmentColoring ? "baseValue" : "value"
      };
  uint64_t valueForHighlight = ${parameters.baseSegmentHighlighting ? "baseValue" : "value"
      };

  float alpha = uSelectedAlpha;
  float saturation = uSaturation;
`;
    // Emit transparent for segment 0 when hideSegmentZero is set, OR whenever
    // a brush overlay is present — the eraser reports erased voxels as 0
    // (see brushLookup) and relies on this transparent emit to reveal the
    // layer underneath. A `discard` in the hijack does not composite away in
    // the slice view, so this is the path that makes live canonical-erase work.
    if (parameters.hideSegmentZero || hasBrushOverlay) {
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
      builder.addUniform("highp vec4", "uHighlightColor");
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
      builder.addUniform("highp vec4", "uSegmentDefaultColor");
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
  if ((uFlags & ${HAS_FOCUSED_SEGMENT_FLAG}u) != 0u && uFocusedSegment != valueForHighlight.value) {
    alpha *= uFocusDim;
  }
  emit(vec4(mix(vec3(1.0,1.0,1.0), vec3(rgba), saturation), alpha));
`;
    builder.setFragmentMain(fragmentMain);
  }

  initializeShader(
    _sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderParameters,
  ) {
    const { gl } = this;
    const { displayState, segmentationGroupState } = this;
    const { segmentSelectionState } = this.displayState;
    const {
      segmentDefaultColor: { value: segmentDefaultColor },
      segmentColorHash: { value: segmentColorHash },
      highlightColor: { value: highlightColor },
      tempSegmentDefaultColor2d: { value: tempSegmentDefaultColor2d },
    } = this.displayState;
    const visibleSegments = getVisibleSegments(segmentationGroupState);
    const ignoreNullSegmentSet = this.displayState.ignoreNullVisibleSet.value;
    let selectedSegmentLow = 0;
    let selectedSegmentHigh = 0;
    let flags = 0;
    if (
      segmentSelectionState.hasSelectedSegment &&
      displayState.hoverHighlight.value
    ) {
      const seg = displayState.baseSegmentHighlighting.value
        ? segmentSelectionState.baseSelectedSegment
        : segmentSelectionState.selectedSegment;

      const isVisible = visibleSegments.size === 0 || visibleSegments.has(seg);

      if (isVisible) {
        selectedSegmentLow = Number(seg & 0xffffffffn);
        selectedSegmentHigh = Number(seg >> 32n);
        flags |= HAS_SELECTED_SEGMENT_FLAG;
      }
    }
    gl.uniform1f(
      shader.uniform("uSelectedAlpha"),
      displayState.selectedAlpha.value,
    );
    gl.uniform1f(shader.uniform("uSaturation"), displayState.saturation.value);
    gl.uniform1f(
      shader.uniform("uNotSelectedAlpha"),
      displayState.notSelectedAlpha.value,
    );
    gl.uniform2ui(
      shader.uniform("uSelectedSegment"),
      selectedSegmentLow,
      selectedSegmentHigh,
    );
    const focusedSegment = displayState.focusedSegment?.value ?? null;
    let focusedSegmentLow = 0;
    let focusedSegmentHigh = 0;
    if (focusedSegment != null) {
      focusedSegmentLow = Number(focusedSegment & 0xffffffffn);
      focusedSegmentHigh = Number(focusedSegment >> 32n);
      flags |= HAS_FOCUSED_SEGMENT_FLAG;
    }
    gl.uniform2ui(
      shader.uniform("uFocusedSegment"),
      focusedSegmentLow,
      focusedSegmentHigh,
    );
    gl.uniform1f(
      shader.uniform("uFocusDim"),
      displayState.focusDim?.value ?? 0.15,
    );
    if (visibleSegments.hashTable.size === 0 && ignoreNullSegmentSet) {
      flags |= SHOW_ALL_SEGMENTS_FLAG;
    }
    gl.uniform1ui(shader.uniform("uFlags"), flags);
    this.hashTableManager.enable(
      gl,
      shader,
      segmentationGroupState.useTemporaryVisibleSegments.value
        ? this.gpuTemporaryHashTable
        : this.gpuHashTable,
    );
    if (this.gpuBrushHashTable !== undefined) {
      this.brushHashTableManager.enable(gl, shader, this.gpuBrushHashTable);
    }
    if (parameters.hasEquivalences) {
      const useTemp =
        segmentationGroupState.useTemporarySegmentEquivalences.value;
      (useTemp
        ? this.temporaryEquivalencesHashMap
        : this.equivalencesHashMap
      ).update();
      this.equivalencesShaderManager.enable(
        gl,
        shader,
        useTemp
          ? this.gpuTemporaryEquivalencesHashTable
          : this.gpuEquivalencesHashTable,
      );
    }
    const activeSegmentDefaultColor =
      tempSegmentDefaultColor2d || segmentDefaultColor;
    if (activeSegmentDefaultColor) {
      const [r, g, b, a] = activeSegmentDefaultColor;
      gl.uniform4f(
        shader.uniform("uSegmentDefaultColor"),
        r,
        g,
        b,
        a === undefined ? 0 : a,
      );
    } else {
      this.segmentColorShaderManager.enable(gl, shader, segmentColorHash);
    }
    if (parameters.hasSegmentStatedColors) {
      const segmentStatedColors = displayState.useTempSegmentStatedColors2d
        .value
        ? displayState.tempSegmentStatedColors2d.value
        : displayState.segmentStatedColors.value;
      let { gpuSegmentStatedColorHashTable } = this;
      if (
        gpuSegmentStatedColorHashTable === undefined ||
        gpuSegmentStatedColorHashTable.hashTable !==
        segmentStatedColors.hashTable
      ) {
        gpuSegmentStatedColorHashTable?.dispose();
        this.gpuSegmentStatedColorHashTable = gpuSegmentStatedColorHashTable =
          GPUHashTable.get(gl, segmentStatedColors.hashTable);
      }
      this.segmentStatedColorShaderManager.enable(
        gl,
        shader,
        gpuSegmentStatedColorHashTable,
      );
    }
    if (highlightColor !== undefined) {
      gl.uniform4fv(shader.uniform("uHighlightColor"), highlightColor);
    }
  }

  endSlice(
    sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderParameters,
  ) {
    const { gl } = this;
    this.hashTableManager.disable(gl, shader);
    if (parameters.hasEquivalences) {
      this.equivalencesShaderManager.disable(gl, shader);
    }
    if (parameters.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.disable(gl, shader);
    }
    super.endSlice(sliceView, shader, parameters);
  }

  override setupSourceUniforms(
    gl: WebGL2RenderingContext,
    shader: ShaderProgram,
    transformedSource: FrontendTransformedSource,
  ) {
    if (this.gpuBrushHashTable === undefined) return;
    // `effectiveVoxelSize` is the source's PHYSICAL voxel size (meters), not a
    // dimensionless factor. The brush hash is keyed in level-0 voxel indices,
    // so the conversion factor is the RATIO to the finest level:
    //   factor = effectiveVoxelSize_L / effectiveVoxelSize_0  (1, 2, 4, … 16)
    // Sources are visited finest-first, so a running min captures the level-0
    // base on the first source. (Assumes isotropic display axes.)
    //
    // No offset is needed: `vBrushWorldPos` is the raw source-voxel position,
    // and the level's OME translation (the pyramid's (f-1)/2) plus
    // neuroglancer's -scale/2 corner correction are already baked into the
    // projection, so `position * factor` points at the same full-res voxel
    // level 0 sees.
    const v = transformedSource.effectiveVoxelSize;
    let base = this.brushFinestVoxelSize;
    if (base === undefined) {
      base = this.brushFinestVoxelSize = Float32Array.from(v.subarray(0, 3));
    } else {
      for (let i = 0; i < 3; i++) {
        if (v[i] > 0 && v[i] < base[i]) base[i] = v[i];
      }
    }
    gl.uniform3f(
      shader.uniform("uBrushSourceScale"),
      base[0] > 0 ? v[0] / base[0] : 1,
      base[1] > 0 ? v[1] / base[1] : 1,
      base[2] > 0 ? v[2] / base[2] : 1,
    );
  }

  override getValueAt(globalPosition: Float32Array) {
    const { tempChunkPosition } = this;
    for (const { source, chunkTransform } of this.visibleSourcesList) {
      if (
        !getChunkPositionFromCombinedGlobalLocalPositions(
          tempChunkPosition,
          globalPosition,
          this.localPosition.value,
          chunkTransform.layerRank,
          chunkTransform.combinedGlobalLocalToChunkTransform,
        )
      ) {
        continue;
      }

      const result = source.getValueAt(tempChunkPosition, chunkTransform);
      if (result != null) {
        return result;
      }
    }
    return null;
  }
}
