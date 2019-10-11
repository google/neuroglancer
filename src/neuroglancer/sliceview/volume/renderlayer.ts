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
import {getChunkPositionFromCombinedGlobalLocalPositions} from 'neuroglancer/render_coordinate_transform';
import {BoundingBoxCrossSectionRenderHelper} from 'neuroglancer/sliceview/bounding_box_shader_helper';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {FrontendTransformedSource, SliceView} from 'neuroglancer/sliceview/frontend';
import {SliceViewRenderLayer, SliceViewRenderLayerOptions} from 'neuroglancer/sliceview/renderlayer';
import {VolumeSourceOptions} from 'neuroglancer/sliceview/volume/base';
import {ChunkFormat, MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {constantWatchableValue, makeCachedDerivedWatchableValue, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {getObjectId} from 'neuroglancer/util/object_id';
import {GL} from 'neuroglancer/webgl/context';
import {makeWatchableShaderError, ParameterizedContextDependentShaderGetter, parameterizedContextDependentShaderGetter, ParameterizedShaderGetterResult, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';

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

export const glsl_getPositionWithinChunk = `
highp ivec3 getPositionWithinChunk () {
  return ivec3(min(vChunkPosition, uChunkDataSize - 1.0));
}
`;

const tempMat4 = mat4.create();

class VolumeSliceVertexComputationManager extends BoundingBoxCrossSectionRenderHelper {
  static get(gl: GL) {
    return gl.memoize.get(
        'volume.VolumeSliceVertexComputationManager',
        () => new VolumeSliceVertexComputationManager(gl));
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);

    // A number in [0, 6) specifying which vertex to compute.
    builder.addAttribute('highp float', 'aVertexIndexFloat');

    // Specifies translation of the current chunk.
    builder.addUniform('highp vec3', 'uTranslation');

    // Matrix by which computed vertices will be transformed.
    builder.addUniform('highp mat4', 'uProjectionMatrix');

    // Chunk size in voxels.
    builder.addUniform('highp vec3', 'uChunkDataSize');

    builder.addUniform('highp vec3', 'uLowerClipBound');
    builder.addUniform('highp vec3', 'uUpperClipBound');

    // Position within chunk of vertex, in floating point range [0, chunkDataSize].
    builder.addVarying('highp vec3', 'vChunkPosition');

    builder.setVertexMain(`
vec3 position = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, int(aVertexIndexFloat));
gl_Position = uProjectionMatrix * vec4(position, 1.0);
vChunkPosition = (position - uTranslation) +
    ${CHUNK_POSITION_EPSILON} * abs(uPlaneNormal);
`);

    builder.addFragmentCode(glsl_getPositionWithinChunk);
  }

  computeVerticesDebug(
      uChunkDataSize: vec3, uLowerClipBound: vec3, uUpperClipBound: vec3, uPlaneDistance: number,
      uPlaneNormal: vec3, uTranslation: vec3, uProjectionMatrix: mat4) {
    let gl_Position = vec3.create(), vChunkPosition = vec3.create(),
        planeNormalAbs = vec3.fromValues(
            Math.abs(uPlaneNormal[0]), Math.abs(uPlaneNormal[1]), Math.abs(uPlaneNormal[2]));
    let prevVertex = vec3.create();
    for (let vertexIndex = 0; vertexIndex < 6; ++vertexIndex) {
      const position = this.computeVertexPositionDebug(
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

  beginSlice(_gl: GL, shader: ShaderProgram) {
    let aVertexIndexFloat = shader.attribute('aVertexIndexFloat');
    this.data.outputVertexIndices.bindToVertexAttrib(aVertexIndexFloat, 1);
  }

  endSlice(gl: GL, shader: ShaderProgram) {
    let aVertexIndexFloat = shader.attribute('aVertexIndexFloat');
    gl.disableVertexAttribArray(aVertexIndexFloat);
  }

  beginSource(
      gl: GL, shader: ShaderProgram, sliceView: SliceView, dataToDeviceMatrix: mat4,
      tsource: FrontendTransformedSource, chunkLayout: ChunkLayout) {
    const {centerDataPosition} = sliceView;

    this.setViewportPlane(
        shader, sliceView.viewportNormalInGlobalCoordinates, centerDataPosition,
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

  setupChunkDataSize(gl: GL, shader: ShaderProgram, chunkDataSize: vec3) {
    gl.uniform3fv(shader.uniform('uChunkDataSize'), chunkDataSize);

    if (DEBUG_VERTICES) {
      (<any>window)['debug_sliceView_chunkDataSize'] = chunkDataSize;
    }
  }

  drawChunk(gl: GL, shader: ShaderProgram, chunkPosition: vec3) {
    gl.uniform3fv(shader.uniform('uTranslation'), chunkPosition);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);

    if (DEBUG_VERTICES) {
      let sliceView: SliceView = (<any>window)['debug_sliceView'];
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
          vec3.create(), sliceView.viewportNormalInGlobalCoordinates);
      const planeDistanceToOrigin = vec3.dot(
          vec3.transformMat4(vec3.create(), sliceView.centerDataPosition, chunkLayout.invTransform),
          localPlaneNormal);
      this.computeVerticesDebug(
          chunkDataSize, lowerClipBound, upperClipBound, planeDistanceToOrigin, localPlaneNormal,
          chunkPosition, dataToDeviceMatrix);
    }
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

export abstract class SliceViewVolumeRenderLayer<ShaderParameters = any> extends
    SliceViewRenderLayer<VolumeChunkSource, VolumeSourceOptions> {
  vertexComputationManager: VolumeSliceVertexComputationManager;
  multiscaleSource: MultiscaleVolumeChunkSource;
  protected shaderGetter:
      ParameterizedContextDependentShaderGetter<ChunkFormat, ShaderParameters, number>;
  private tempChunkPosition: Float32Array;
  shaderParameters: WatchableValueInterface<ShaderParameters>;
  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      options: RenderLayerOptions<ShaderParameters>) {
    const {shaderError = makeWatchableShaderError(), shaderParameters} = options;
    super(multiscaleSource.chunkManager, multiscaleSource, options);
    const {gl} = this;
    this.shaderParameters = shaderParameters;
    const {channelCoordinateSpace} = options;
    this.channelCoordinateSpace = channelCoordinateSpace === undefined ?
        constantWatchableValue(emptyInvalidCoordinateSpace) :
        channelCoordinateSpace;
    this.registerDisposer(shaderParameters.changed.add(this.redrawNeeded.dispatch));
    // The shader depends on the `ChunkFormat` (which is a property of the `VolumeChunkSource`), the
    // `ShaderParameters` (which are determined by the derived RenderLayer class), and the number of
    // channel dimensions.
    const numChannelDimensions = this.registerDisposer(
        makeCachedDerivedWatchableValue(space => space.rank, [this.channelCoordinateSpace]));
    this.shaderGetter = parameterizedContextDependentShaderGetter(this, gl, {
      memoizeKey: `volume/RenderLayer:${getObjectId(this.constructor)}`,
      fallbackParameters: options.fallbackShaderParameters,
      parameters: shaderParameters,
      encodeParameters: options.encodeShaderParameters,
      shaderError,
      extraParameters: numChannelDimensions,
      defineShader:
          (builder: ShaderBuilder, chunkFormat: ChunkFormat, parameters: ShaderParameters,
           numChannelDimensions: number) => {
            this.vertexComputationManager.defineShader(builder);
            builder.addOutputBuffer('vec4', 'v4f_fragData0', 0);
            builder.addFragmentCode(`
void emit(vec4 color) {
  v4f_fragData0 = color;
}
`);
            chunkFormat.defineShader(builder, numChannelDimensions);
            if (numChannelDimensions <= 1) {
              builder.addFragmentCode(`
${getShaderType(this.dataType)} getDataValue() { return getDataValue(0); }
`);
            }
            this.defineShader(builder, parameters);
          },
      getContextKey: context => context.shaderKey,
    });
    this.vertexComputationManager = VolumeSliceVertexComputationManager.get(gl);
    this.tempChunkPosition = new Float32Array(multiscaleSource.rank);
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
      const result = source.getValueAt(tempChunkPosition);
      if (result != null) {
        return result;
      }
    }
    return null;
  }

  beginChunkFormat(sliceView: SliceView, chunkFormat: ChunkFormat):
      ParameterizedShaderGetterResult<ShaderParameters, number> {
    const {gl} = this;
    const shaderResult = this.shaderGetter(chunkFormat);
    const {shader, parameters, fallback} = shaderResult;
    if (shader !== null) {
      shader.bind();
      this.vertexComputationManager.beginSlice(gl, shader);
      this.initializeShader(sliceView, shader, parameters, fallback);
      chunkFormat.beginDrawing(gl, shader);
    }
    return shaderResult;
  }

  abstract initializeShader(
      sliceView: SliceView, shader: ShaderProgram, parameters: ShaderParameters,
      fallback: boolean): void;

  abstract defineShader(builder: ShaderBuilder, parameters: ShaderParameters): void;

  endSlice(_sliceView: SliceView, shader: ShaderProgram, _parameters: ShaderParameters) {
    const {gl} = this;
    this.vertexComputationManager.endSlice(gl, shader);
  }

  draw(sliceView: SliceView) {
    const layerInfo = sliceView.visibleLayers.get(this)!;
    const {visibleSources} = layerInfo;
    if (visibleSources.length === 0) {
      return;
    }

    const {gl} = this;

    const chunkPosition = vec3.create();
    const {renderScaleHistogram, vertexComputationManager} = this;

    if (renderScaleHistogram !== undefined) {
      renderScaleHistogram.begin(
          this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber);
    }

    let shaderResult: ParameterizedShaderGetterResult<ShaderParameters, number>;
    let shader: ShaderProgram|null = null;
    let prevChunkFormat: ChunkFormat|undefined;
    // Size of chunk (in voxels) in the "display" subspace of the chunk coordinate space.
    const chunkDataDisplaySize = vec3.create();

    const endShader = () => {
      if (shader === null) return;
      prevChunkFormat!.endDrawing(gl, shader);
      this.endSlice(sliceView, shader, shaderResult.parameters);
    };
    let newSource = true;
    for (const transformedSource of visibleSources) {
      const {visibleChunks} = transformedSource;
      if (visibleChunks.length === 0) {
        continue;
      }
      const chunkLayout = sliceView.getNormalizedChunkLayout(transformedSource.chunkLayout);
      const {chunkTransform: {chunkChannelDimensionIndices}} = transformedSource;
      const source = transformedSource.source as VolumeChunkSource;
      const {fixedPositionWithinChunk, chunkDisplayDimensionIndices} = transformedSource;
      for (const chunkDim of chunkDisplayDimensionIndices) {
        fixedPositionWithinChunk[chunkDim] = 0;
      }
      const chunkFormat = source.chunkFormat;
      if (chunkFormat !== prevChunkFormat) {
        prevChunkFormat = chunkFormat;
        endShader();
        shaderResult = this.beginChunkFormat(sliceView, chunkFormat);
        shader = shaderResult.shader;
      }
      if (shader === null) continue;
      const chunks = source.chunks;

      chunkDataDisplaySize.fill(1);

      let originalChunkSize = chunkLayout.size;

      let chunkDataSize: Uint32Array|undefined;
      const chunkRank = source.spec.rank;

      vertexComputationManager.beginSource(
          gl, shader, sliceView, sliceView.viewProjectionMat, transformedSource, chunkLayout);
      chunkFormat.beginSource(gl, shader);
      newSource = true;
      let presentCount = 0, notPresentCount = 0;
      for (let key of visibleChunks) {
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
            vertexComputationManager.setupChunkDataSize(gl, shader!, chunkDataDisplaySize);
          }
          const {chunkGridPosition} = chunk;
          for (let i = 0; i < 3; ++i) {
            const chunkDim = chunkDisplayDimensionIndices[i];
            chunkPosition[i] = (chunkDim === -1 || chunkDim >= chunkRank) ?
                0 :
                originalChunkSize[i] * chunkGridPosition[chunkDim];
          }
          chunkFormat.bindChunk(
              gl, shader, chunk, fixedPositionWithinChunk, chunkDisplayDimensionIndices,
              chunkChannelDimensionIndices, newSource);
          newSource = false;
          vertexComputationManager.drawChunk(gl, shader, chunkPosition);
          ++presentCount;
        } else {
          ++notPresentCount;
        }
      }

      if ((presentCount !== 0 || notPresentCount !== 0) && renderScaleHistogram !== undefined) {
        const {effectiveVoxelSize} = transformedSource;
        // TODO(jbms): replace median hack with more accurate estimate, e.g. based on ellipsoid
        // cross section.
        const medianVoxelSize =
            medianOf3(effectiveVoxelSize[0], effectiveVoxelSize[1], effectiveVoxelSize[2]);
        renderScaleHistogram.add(
            medianVoxelSize, medianVoxelSize / sliceView.pixelSize, presentCount, notPresentCount);
      }
    }
    endShader();
  }
}
