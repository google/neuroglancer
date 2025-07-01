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

import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import {
  GPUHashTable,
  HashMapShaderManager,
  HashSetShaderManager,
} from "#src/gpu_hash/shader.js";
import {
  getChunkPositionFromCombinedGlobalLocalPositions,
  getChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
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
import { Uint64 } from "#src/util/uint64.js";
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
  allowBrush: WatchableValueInterface<boolean>;
  ignoreNullVisibleSet: WatchableValueInterface<boolean>;
}

interface ShaderParameters {
  hasEquivalences: boolean;
  baseSegmentColoring: boolean;
  baseSegmentHighlighting: boolean;
  hasSegmentStatedColors: boolean;
  hideSegmentZero: boolean;
  allowBrush: boolean;
  hasSegmentDefaultColor: boolean;
  hasHighlightColor: boolean;
}

const HAS_SELECTED_SEGMENT_FLAG = 1;
const SHOW_ALL_SEGMENTS_FLAG = 2;

export class BrushHashTable extends HashMapUint64 {
  public modified_points: Record<string, number> = {} // key is z,y,x

  private getBrushKey(z: number, y: number, x: number): Uint64 {
    const x1 = x >>> 0;
    const y1 = y >>> 0;
    const z1 = z >>> 0;

    const h1 = (((x1 * 73) * 1271) ^ ((y1 * 513) * 1345) ^ ((z1 * 421) * 675)) >>> 0;
    const h2 = (((x1 * 127) * 337) ^ ((y1 * 111) * 887) ^ ((z1 * 269) * 325)) >>> 0;

    const key = new Uint64();
    key.low = h1;
    key.high = h2;
    return key;
  }

  addBrushPoint(z: number, y: number, x: number, value: number) {
    const key = this.getBrushKey(z, y, x);
    this.delete(key);
    const brushValue = new Uint64();
    brushValue.low = value;
    brushValue.high = 0;
    this.modified_points[`${z},${y},${x}`] = value
    this.set(key, brushValue);
  }

  deleteBrushPoint(z: number, y: number, x: number) {
    const key = this.getBrushKey(z, y, x);
    this.delete(key);
  }

  getBrushValue(z: number, y: number, x: number): number | undefined {
    const key = this.getBrushKey(z, y, x);
    const value = new Uint64();
    if (this.get(key, value)) {
      return value.low;
    }
    return undefined;
  }
}

export class SegmentationRenderLayer extends SliceViewVolumeRenderLayer<ShaderParameters> {
  public readonly segmentationGroupState: SegmentationGroupState;
  brushHashTable = new BrushHashTable();
  private gpuBrushHashTable: GPUHashTable<BrushHashTable>;
  private brushHashTableManager = new HashMapShaderManager("brush");
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
        allowBrush: displayState.allowBrush,
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
    )
    this.gpuBrushHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.brushHashTable),
    );

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
    this.gpuBrushHashTable?.dispose();
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
    let getUint64Code = `
    uint64_t getUint64DataValue() {
      uint64_t x = toUint64(getDataValue());
    `;
    if (parameters.allowBrush) {
      builder.addUniform("bool", "uBrushEnabled");
      builder.addUniform("mat4", "uChunkToLayerTransform");
      builder.addUniform("mat4", "uBaseLayerToChunkTransform");
      this.brushHashTableManager.defineShader(builder);

      getUint64Code += `
      if (uBrushEnabled) {
        vec3 chunkPos = vChunkPosition;
        // Transform from chunk space to layer space
        vec4 layerPos = uChunkToLayerTransform * vec4(chunkPos + uTranslation, 1.0);
        // Transform from layer space to base resolution chunk space
        vec4 basePos = uBaseLayerToChunkTransform * layerPos;
        
        // Convert to integer coordinates in base resolution space. 0.5 offset accounts for voxel center
        ivec3 ipos = ivec3(floor(basePos.xyz - 0.5));

        uint x1 = uint(ipos.x);
        uint y1 = uint(ipos.y);
        uint z1 = uint(ipos.z);
        
        // First hash component - avoid large multipliers
        uint h1 = ((x1 * 73u) * 1271u) ^ ((y1 * 513u) * 1345u) ^ ((z1 * 421u) * 675u);
        
        // Second hash component - use different multipliers
        uint h2 = ((x1 * 127u) * 337u) ^ ((y1 * 111u) * 887u) ^ ((z1 * 269u) * 325u);
        
        uint64_t key;
        key.value[0] = h1;
        key.value[1] = h2;
        
        uint64_t brushValue;
        if (brush_get(key, brushValue)) {
          return brushValue;
        }
      }`;
    }
    getUint64Code += `
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

    if (parameters.allowBrush) {
      const transform = this.displayState.transform.value;

      if (transform.error !== undefined) {
        console.error("Transform error:", transform.error);
        this.gl.uniform1i(shader.uniform("uBrushEnabled"), 0);
        return;
      }

      const baseSources = this.multiscaleSource.getSources({
        multiscaleToViewTransform: matrix.createIdentity(
          Float32Array,
          this.multiscaleSource.rank,
        ),
        displayRank: this.multiscaleSource.rank,
        modelChannelDimensionIndices: [],
      });

      const baseSource = baseSources[0][0];

      const baseTransform = getChunkTransformParameters(
        transform,
        baseSource.chunkToMultiscaleTransform,
      );

      const layerInfo = _sliceView.visibleLayers.get(this)!;
      const currentSource = layerInfo.visibleSources[0];

      const shaderChunkToLayer = new Float32Array(16);
      const shaderLayerToChunk = new Float32Array(16);

      // Copy the relevant 4x4 portion from the 5x5 matrices
      const stride = 5;
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          shaderChunkToLayer[col * 4 + row] =
            currentSource.chunkTransform.chunkToLayerTransform[
            col * stride + row
            ];
          shaderLayerToChunk[col * 4 + row] =
            baseTransform.layerToChunkTransform[col * stride + row];
        }
      }

      gl.uniformMatrix4fv(
        shader.uniform("uChunkToLayerTransform"),
        false,
        shaderChunkToLayer,
      );
      gl.uniformMatrix4fv(
        shader.uniform("uBaseLayerToChunkTransform"),
        false,
        shaderLayerToChunk,
      );

      let { gpuBrushHashTable } = this;
      if (
        gpuBrushHashTable === undefined ||
        gpuBrushHashTable.hashTable !== this.brushHashTable
      ) {
        gpuBrushHashTable?.dispose();
        this.gpuBrushHashTable = gpuBrushHashTable = GPUHashTable.get(
          this.gl,
          this.brushHashTable,
        );
      }
      this.brushHashTableManager.enable(
        this.gl,
        shader,
        this.gpuBrushHashTable,
      );
      this.gl.uniform1i(shader.uniform("uBrushEnabled"), 1);
    } else {
      this.gl.uniform1i(shader.uniform("uBrushEnabled"), 0);
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
    if (parameters.allowBrush) {
      this.brushHashTableManager.disable(this.gl, shader);
    }
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

      if (source.groupState?.allowBrush.value) {
        const intGlobalPosition = globalPosition.map((value) =>
          Math.round(value),
        );
        const z = intGlobalPosition[0];
        const y = intGlobalPosition[1];
        const x = intGlobalPosition[2];
        const brushValue = this.brushHashTable.getBrushValue(z, y, x);

        if (brushValue !== undefined) {
          if (chunkTransform.channelSpaceShape.length === 0) {
            return brushValue;
          }
          return new Array(chunkTransform.numChannels).fill(brushValue);
        }
      }

      const result = source.getValueAt(tempChunkPosition, chunkTransform);
      if (result != null) {
        return result;
      }
    }
    return null;
  }
}
