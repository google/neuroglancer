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

import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {CoordinateSpace, emptyInvalidCoordinateSpace} from 'neuroglancer/coordinate_transform';
import {ProjectionParameters} from 'neuroglancer/projection_parameters';
import {getChunkPositionFromCombinedGlobalLocalPositions} from 'neuroglancer/render_coordinate_transform';
import {getNormalizedChunkLayout} from 'neuroglancer/sliceview/base';
import {computeVertexPositionDebug, defineBoundingBoxCrossSectionShader, setBoundingBoxCrossSectionShaderViewportPlane} from 'neuroglancer/sliceview/bounding_box_shader_helper';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {FrontendTransformedSource, SliceView} from 'neuroglancer/sliceview/frontend';
import {SliceViewRenderContext, SliceViewRenderLayer, SliceViewRenderLayerOptions} from 'neuroglancer/sliceview/renderlayer';
import {VolumeSourceOptions} from 'neuroglancer/sliceview/volume/base';
import {ChunkFormat, defineChunkDataShaderAccess, MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {constantWatchableValue, makeCachedDerivedWatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {getObjectId} from 'neuroglancer/util/object_id';
import {GL} from 'neuroglancer/webgl/context';
import {makeWatchableShaderError, ParameterizedContextDependentShaderGetter, parameterizedContextDependentShaderGetter, ParameterizedShaderGetterResult, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {HistogramChannelSpecification} from 'neuroglancer/webgl/empirical_cdf';
import {defineInvlerpShaderFunction, enableLerpShaderFunction} from 'neuroglancer/webgl/lerp';
import {defineLineShader, drawLines, initializeLineShader, VERTICES_PER_LINE} from 'neuroglancer/webgl/lines';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {defineVertexId, VertexIdHelper} from 'neuroglancer/webgl/vertex_id';

const DEBUG_VERTICES = false;

/**
 * Extra amount by which the chunk position computed in the vertex shader is shifted in the
 * direction of the component-wise absolute value of the plane normal.  In Neuroglancer, a
 * cross-section plane exactly on the boundary between two voxels is a common occurrence and is
 * intended to result in the display of the "next" (i.e. higher coordinate) plane rather than the
 * "previous" (lower coordinate) plane.  However, due to various sources of floating point
 * inaccuracy (in particular, shader code which has relaxed rules), values exactly on the boundary
 * between voxels may be slightly shifted in either direction.  To ensure that this doesn't result
 * in the display of the wrong data (i.e. the previous rather than next plane), we always shift
 * toward the "next" plane by this small amount.
 */
const CHUNK_POSITION_EPSILON = 1e-3;

const tempMat4 = mat4.create();

function defineVolumeShader(builder: ShaderBuilder, wireFrame: boolean) {
  defineVertexId(builder);
  defineBoundingBoxCrossSectionShader(builder);

  // Specifies translation of the current chunk.
  builder.addUniform('highp vec3', 'uTranslation');

  // Matrix by which computed vertices will be transformed.
  builder.addUniform('highp mat4', 'uProjectionMatrix');

  // Chunk size in voxels.
  builder.addUniform('highp vec3', 'uChunkDataSize');

  builder.addUniform('highp vec3', 'uLowerClipBound');
  builder.addUniform('highp vec3', 'uUpperClipBound');

  if (wireFrame) {
    defineLineShader(builder);
    builder.setVertexMain(`
int vertexIndex1 = gl_VertexID / ${VERTICES_PER_LINE};
int vertexIndex2 = vertexIndex1 == 5 ? 0 : vertexIndex1 + 1;
vec3 vertexPosition1 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex1);
vec3 vertexPosition2 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex2);
emitLine(uProjectionMatrix * vec4(vertexPosition1, 1.0),
         uProjectionMatrix * vec4(vertexPosition2, 1.0),
         2.0);
`);
    builder.setFragmentMain(`
emit(vec4(1.0, 1.0, 1.0, getLineAlpha()));
`);
    return;
  }

  // Position within chunk of vertex, in floating point range [0, chunkDataSize].
  builder.addVarying('highp vec3', 'vChunkPosition');

  // Set gl_Position.z = 0 since we use the depth buffer as a stencil buffer to avoid overwriting
  // higher-resolution data with lower-resolution data.  The depth buffer is used rather than the
  // stencil buffer because for computing data distributions we need to read from it, and WebGL2
  // does not support reading from the stencil component of a depth-stencil texture.
  builder.setVertexMain(`
vec3 position = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, gl_VertexID);
gl_Position = uProjectionMatrix * vec4(position, 1.0);
gl_Position.z = 0.0;
vChunkPosition = (position - uTranslation) +
    ${CHUNK_POSITION_EPSILON} * abs(uPlaneNormal);
`);
}

function computeVerticesDebug(
    uChunkDataSize: vec3, uLowerClipBound: vec3, uUpperClipBound: vec3, uPlaneDistance: number,
    uPlaneNormal: vec3, uTranslation: vec3, uProjectionMatrix: mat4) {
  let gl_Position = vec3.create(), vChunkPosition = vec3.create(),
      planeNormalAbs = vec3.fromValues(
          Math.abs(uPlaneNormal[0]), Math.abs(uPlaneNormal[1]), Math.abs(uPlaneNormal[2]));
  let prevVertex = vec3.create();
  for (let vertexIndex = 0; vertexIndex < 6; ++vertexIndex) {
    const position = computeVertexPositionDebug(
        uChunkDataSize, uLowerClipBound, uUpperClipBound, uPlaneDistance, uPlaneNormal,
        uTranslation, vertexIndex);
    if (position === undefined) {
      console.log('no intersection found');
      return;
    }
    vec3.transformMat4(gl_Position, position, uProjectionMatrix);
    const skipped = vertexIndex !== 0 && vec3.equals(gl_Position, prevVertex);
    vec3.copy(prevVertex, gl_Position);
    vec3.sub(vChunkPosition, position, uTranslation);
    vec3.scaleAndAdd(vChunkPosition, vChunkPosition, planeNormalAbs, CHUNK_POSITION_EPSILON);
    console.log(
        `${skipped ? 'SKIPPED' : 'OUTPUT'} vertex ${vertexIndex}, ` +
        `at ${gl_Position}, vChunkPosition = ${vChunkPosition}, ` +
        `uTranslation=${uTranslation.join()}, position=${position.join()}`);
  }
}

function initializeShader(
    shader: ShaderProgram, projectionParameters: ProjectionParameters, wireFrame: boolean) {
  if (wireFrame) {
    initializeLineShader(shader, projectionParameters, /*featherWidthInPixels=*/ 1);
  }
}

function beginSource(
    gl: GL, shader: ShaderProgram, sliceView: SliceView, dataToDeviceMatrix: mat4,
    tsource: FrontendTransformedSource, chunkLayout: ChunkLayout) {
  const projectionParameters = sliceView.projectionParameters.value;
  const {centerDataPosition} = projectionParameters;

  setBoundingBoxCrossSectionShaderViewportPlane(
      shader, projectionParameters.viewportNormalInGlobalCoordinates, centerDataPosition,
      chunkLayout.transform, chunkLayout.invTransform);

  // Compute projection matrix that transforms chunk layout coordinates to device coordinates.
  gl.uniformMatrix4fv(
      shader.uniform('uProjectionMatrix'), false,
      mat4.multiply(tempMat4, dataToDeviceMatrix, chunkLayout.transform));

  gl.uniform3fv(shader.uniform('uLowerClipBound'), tsource.lowerClipDisplayBound);
  gl.uniform3fv(shader.uniform('uUpperClipBound'), tsource.upperClipDisplayBound);
  if (DEBUG_VERTICES) {
    (<any>window)['debug_sliceView_uLowerClipBound'] = tsource.lowerClipDisplayBound;
    (<any>window)['debug_sliceView_uUpperClipBound'] = tsource.upperClipDisplayBound;
    (<any>window)['debug_sliceView'] = sliceView;
    (<any>window)['debug_sliceView_dataToDevice'] = mat4.clone(tempMat4);
    (<any>window)['debug_sliceView_chunkLayout'] = chunkLayout;
  }
}

function setupChunkDataSize(gl: GL, shader: ShaderProgram, chunkDataSize: vec3) {
  gl.uniform3fv(shader.uniform('uChunkDataSize'), chunkDataSize);

  if (DEBUG_VERTICES) {
    (<any>window)['debug_sliceView_chunkDataSize'] = chunkDataSize;
  }
}

function drawChunk(gl: GL, shader: ShaderProgram, chunkPosition: vec3, wireFrame: boolean) {
  gl.uniform3fv(shader.uniform('uTranslation'), chunkPosition);
  if (wireFrame) {
    drawLines(shader.gl, 6, 1);
  } else {
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);
  }

  if (DEBUG_VERTICES) {
    let sliceView: SliceView = (<any>window)['debug_sliceView'];
    const projectionParameters = sliceView.projectionParameters.value;
    let chunkDataSize: vec3 = (<any>window)['debug_sliceView_chunkDataSize'];
    let lowerClipBound: vec3 = (<any>window)['debug_sliceView_uLowerClipBound'];
    let upperClipBound: vec3 = (<any>window)['debug_sliceView_uUpperClipBound'];
    let dataToDeviceMatrix: mat4 = (<any>window)['debug_sliceView_dataToDevice'];
    const chunkLayout: ChunkLayout = (<any>window)['debug_sliceView_chunkLayout'];
    console.log(
        `Drawing chunk: ${chunkPosition.join()} of data size ` +
            `${chunkDataSize.join()}, projection`,
        dataToDeviceMatrix);
    const localPlaneNormal = chunkLayout.globalToLocalNormal(
        vec3.create(), projectionParameters.viewportNormalInGlobalCoordinates);
    const planeDistanceToOrigin = vec3.dot(
        vec3.transformMat4(
            vec3.create(), projectionParameters.centerDataPosition, chunkLayout.invTransform),
        localPlaneNormal);
    computeVerticesDebug(
        chunkDataSize, lowerClipBound, upperClipBound, planeDistanceToOrigin, localPlaneNormal,
        chunkPosition, dataToDeviceMatrix);
  }
}

export interface RenderLayerBaseOptions extends SliceViewRenderLayerOptions {
  shaderError?: WatchableShaderError;
  channelCoordinateSpace?: WatchableValueInterface<CoordinateSpace>;
}

export interface RenderLayerOptions<ShaderParameters> extends RenderLayerBaseOptions {
  fallbackShaderParameters?: WatchableValueInterface<ShaderParameters>;
  shaderParameters: WatchableValueInterface<ShaderParameters>;
  encodeShaderParameters?: (parameters: ShaderParameters) => any;
}

function medianOf3(a: number, b: number, c: number) {
  return a > b ? (c > a ? a : (b > c ? b : c)) : (c > b ? b : (a > c ? a : c));
}

interface ShaderContext {
  numChannelDimensions: number;
  dataHistogramChannelSpecifications: HistogramChannelSpecification[];
}

export abstract class SliceViewVolumeRenderLayer<ShaderParameters = any> extends
    SliceViewRenderLayer<VolumeChunkSource, VolumeSourceOptions> {
  multiscaleSource: MultiscaleVolumeChunkSource;
  protected shaderGetter: ParameterizedContextDependentShaderGetter<
      {chunkFormat: ChunkFormat | null, dataHistogramsEnabled: boolean}, ShaderParameters,
      ShaderContext>;
  private tempChunkPosition: Float32Array;
  shaderParameters: WatchableValueInterface<ShaderParameters>;
  private vertexIdHelper: VertexIdHelper;

  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      options: RenderLayerOptions<ShaderParameters>) {
    const {shaderError = makeWatchableShaderError(), shaderParameters} = options;
    super(multiscaleSource.chunkManager, multiscaleSource, options);
    const {gl} = this;
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(gl));
    this.shaderParameters = shaderParameters;
    const {channelCoordinateSpace} = options;
    this.channelCoordinateSpace = channelCoordinateSpace === undefined ?
        constantWatchableValue(emptyInvalidCoordinateSpace) :
        channelCoordinateSpace;
    this.registerDisposer(shaderParameters.changed.add(this.redrawNeeded.dispatch));
    // The shader depends on the `ChunkFormat` (which is a property of the `VolumeChunkSource`), the
    // `ShaderParameters` (which are determined by the derived RenderLayer class), the number of
    // channel dimensions, and the data histogram channel specifications.
    const extraParameters = this.registerDisposer(makeCachedDerivedWatchableValue(
        (space: CoordinateSpace,
         dataHistogramChannelSpecifications: HistogramChannelSpecification[]) =>
            ({numChannelDimensions: space.rank, dataHistogramChannelSpecifications}),
        [this.channelCoordinateSpace, this.dataHistogramSpecifications.channels]));
    this.shaderGetter = parameterizedContextDependentShaderGetter(this, gl, {
      memoizeKey: `volume/RenderLayer:${getObjectId(this.constructor)}`,
      fallbackParameters: options.fallbackShaderParameters,
      parameters: shaderParameters,
      encodeParameters: options.encodeShaderParameters,
      shaderError,
      extraParameters,
      defineShader: (
          builder: ShaderBuilder,
          context: {chunkFormat: ChunkFormat|null, dataHistogramsEnabled: boolean},
          parameters: ShaderParameters, extraParameters: ShaderContext) => {
        const {chunkFormat, dataHistogramsEnabled} = context;
        const {dataHistogramChannelSpecifications, numChannelDimensions} = extraParameters;
        defineVolumeShader(builder, chunkFormat === null);
        builder.addOutputBuffer('vec4', 'v4f_fragData0', 0);
        builder.addFragmentCode(`
void emit(vec4 color) {
  v4f_fragData0 = color;
}
`);
        if (chunkFormat === null) {
          return;
        }
        defineChunkDataShaderAccess(builder, chunkFormat, numChannelDimensions, `vChunkPosition`);
        const numHistograms = dataHistogramChannelSpecifications.length;
        if (dataHistogramsEnabled && numHistograms > 0) {
          let histogramCollectionCode = '';
          const {dataType} = chunkFormat;
          for (let i = 0; i < numHistograms; ++i) {
            const {channel} = dataHistogramChannelSpecifications[i];
            const outputName = `out_histogram${i}`;
            builder.addOutputBuffer('vec4', outputName, 1 + i);
            const getDataValueExpr = `getDataValue(${channel.join(',')})`;
            const invlerpName = `invlerpForHistogram${i}`;
            builder.addFragmentCode(
                defineInvlerpShaderFunction(builder, invlerpName, dataType, /*clamp=*/ false));
            builder.addFragmentCode(`
float getHistogramValue${i}() {
  return invlerpForHistogram${i}(${getDataValueExpr});
}
`);
            histogramCollectionCode += `{
float x = getHistogramValue${i}();
if (x < 0.0) x = 0.0;
else if (x > 1.0) x = 1.0;
else x = (1.0 + x * 253.0) / 255.0;
${outputName} = vec4(x, x, x, 1.0);
}`;
          }
          builder.addFragmentCode(`void userMain();
void main() {
  ${histogramCollectionCode}
  userMain();
}
#define main userMain\n`);
        }
        this.defineShader(builder, parameters);
      },
      getContextKey: context =>
          `${context.chunkFormat?.shaderKey}/${context.dataHistogramsEnabled}`,
    });
    this.tempChunkPosition = new Float32Array(multiscaleSource.rank);
    this.initializeCounterpart();
  }

  get dataType() {
    return this.multiscaleSource.dataType;
  }

  getValueAt(globalPosition: Float32Array) {
    let {tempChunkPosition} = this;
    for (const {source, chunkTransform} of this.visibleSourcesList) {
      if (!getChunkPositionFromCombinedGlobalLocalPositions(
              tempChunkPosition, globalPosition, this.localPosition.value, chunkTransform.layerRank,
              chunkTransform.combinedGlobalLocalToChunkTransform)) {
        continue;
      }
      const result = source.getValueAt(tempChunkPosition, chunkTransform);
      if (result != null) {
        return result;
      }
    }
    return null;
  }

  beginChunkFormat(
      sliceView: SliceView, chunkFormat: ChunkFormat|null,
      projectionParameters: ProjectionParameters):
      ParameterizedShaderGetterResult<ShaderParameters, ShaderContext> {
    const {gl} = this;
    const dataHistogramsEnabled = this.dataHistogramSpecifications.visibility.visible;
    const shaderResult = this.shaderGetter({chunkFormat, dataHistogramsEnabled});
    const {shader, parameters, fallback} = shaderResult;
    if (shader !== null) {
      shader.bind();
      initializeShader(shader, projectionParameters, chunkFormat === null);
      if (chunkFormat !== null) {
        if (dataHistogramsEnabled) {
          const {dataHistogramChannelSpecifications} = shaderResult.extraParameters;
          const numHistograms = dataHistogramChannelSpecifications.length;
          const bounds = this.dataHistogramSpecifications.bounds.value;
          for (let i = 0; i < numHistograms; ++i) {
            enableLerpShaderFunction(shader, `invlerpForHistogram${i}`, chunkFormat.dataType, bounds[i]);
          }
        }
        this.initializeShader(sliceView, shader, parameters, fallback);
        // FIXME: may need to fix wire frame rendering
        chunkFormat.beginDrawing(gl, shader);
      }
    }
    return shaderResult;
  }

  abstract initializeShader(
      sliceView: SliceView, shader: ShaderProgram, parameters: ShaderParameters,
      fallback: boolean): void;

  abstract defineShader(builder: ShaderBuilder, parameters: ShaderParameters): void;

  endSlice(sliceView: SliceView, shader: ShaderProgram, parameters: ShaderParameters) {
    sliceView;
    shader;
    parameters;
  }

  draw(renderContext: SliceViewRenderContext) {
    const {sliceView} = renderContext;
    const layerInfo = sliceView.visibleLayers.get(this)!;
    const {visibleSources} = layerInfo;
    if (visibleSources.length === 0) {
      return;
    }

    const {projectionParameters, wireFrame} = renderContext;

    const {gl} = this;

    this.vertexIdHelper.enable();

    const chunkPosition = vec3.create();
    const {renderScaleHistogram} = this;

    if (renderScaleHistogram !== undefined) {
      renderScaleHistogram.begin(
          this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber);
    }

    let shaderResult: ParameterizedShaderGetterResult<ShaderParameters, ShaderContext>;
    let shader: ShaderProgram|null = null;
    let prevChunkFormat: ChunkFormat|undefined|null;
    // Size of chunk (in voxels) in the "display" subspace of the chunk coordinate space.
    const chunkDataDisplaySize = vec3.create();

    const endShader = () => {
      if (shader === null) return;
      if (prevChunkFormat !== null) {
        prevChunkFormat!.endDrawing(gl, shader);
      }
      this.endSlice(sliceView, shader, shaderResult.parameters);
    };
    let newSource = true;
    for (const transformedSource of visibleSources) {
      const chunkLayout =
          getNormalizedChunkLayout(projectionParameters, transformedSource.chunkLayout);
      const {chunkTransform: {channelToChunkDimensionIndices}} = transformedSource;
      const source = transformedSource.source as VolumeChunkSource;
      const {fixedPositionWithinChunk, chunkDisplayDimensionIndices} = transformedSource;
      for (const chunkDim of chunkDisplayDimensionIndices) {
        fixedPositionWithinChunk[chunkDim] = 0;
      }
      const chunkFormat = wireFrame ? null : source.chunkFormat;
      if (chunkFormat !== prevChunkFormat) {
        prevChunkFormat = chunkFormat;
        endShader();
        shaderResult = this.beginChunkFormat(sliceView, chunkFormat, projectionParameters);
        shader = shaderResult.shader;
      }
      if (shader === null) continue;
      const chunks = source.chunks;

      chunkDataDisplaySize.fill(1);

      let originalChunkSize = chunkLayout.size;

      let chunkDataSize: Uint32Array|undefined;
      const chunkRank = source.spec.rank;

      beginSource(
          gl, shader, sliceView, projectionParameters.viewProjectionMat, transformedSource,
          chunkLayout);
      if (chunkFormat !== null) {
        chunkFormat.beginSource(gl, shader);
      }
      newSource = true;
      let presentCount = 0, notPresentCount = 0;
      sliceView.forEachVisibleChunk(transformedSource, chunkLayout, key => {
        let chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          let newChunkDataSize = chunk.chunkDataSize;
          if (newChunkDataSize !== chunkDataSize) {
            chunkDataSize = newChunkDataSize;
            for (let i = 0; i < 3; ++i) {
              const chunkDim = chunkDisplayDimensionIndices[i];
              chunkDataDisplaySize[i] =
                  (chunkDim === -1 || chunkDim >= chunkRank) ? 1 : chunkDataSize[chunkDim];
            }
            setupChunkDataSize(gl, shader!, chunkDataDisplaySize);
          }
          const {chunkGridPosition} = chunk;
          for (let i = 0; i < 3; ++i) {
            const chunkDim = chunkDisplayDimensionIndices[i];
            chunkPosition[i] = (chunkDim === -1 || chunkDim >= chunkRank) ?
                0 :
                originalChunkSize[i] * chunkGridPosition[chunkDim];
          }
          if (chunkFormat !== null) {
            chunkFormat.bindChunk(
                gl, shader!, chunk, fixedPositionWithinChunk, chunkDisplayDimensionIndices,
                channelToChunkDimensionIndices, newSource);
          }
          newSource = false;
          drawChunk(gl, shader!, chunkPosition, wireFrame);
          ++presentCount;
        } else {
          ++notPresentCount;
        }
      });

      if ((presentCount !== 0 || notPresentCount !== 0) && renderScaleHistogram !== undefined) {
        const {effectiveVoxelSize} = transformedSource;
        // TODO(jbms): replace median hack with more accurate estimate, e.g. based on ellipsoid
        // cross section.
        const medianVoxelSize =
            medianOf3(effectiveVoxelSize[0], effectiveVoxelSize[1], effectiveVoxelSize[2]);
        renderScaleHistogram.add(
            medianVoxelSize, medianVoxelSize / projectionParameters.pixelSize, presentCount,
            notPresentCount);
      }
    }
    endShader();
    this.vertexIdHelper.disable();
    if (!renderContext.wireFrame) {
      const dataHistogramCount = this.getDataHistogramCount();
      if (dataHistogramCount > 0) {
        sliceView.computeHistograms(dataHistogramCount, this.dataHistogramSpecifications);
      }
    }
  }
}
