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

import {ChunkSourceParametersConstructor, ChunkState} from 'neuroglancer/chunk_manager/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {RenderLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {forEachSegmentToDraw, getObjectColor, registerRedrawWhenSegmentationDisplayState3DChanged, SegmentationDisplayState3D, SegmentationLayerSharedObject} from 'neuroglancer/segmentation_display_state/frontend';
import {SKELETON_LAYER_RPC_ID} from 'neuroglancer/skeleton/base';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/panel';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {stableStringify} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {setVec4FromUint32} from 'neuroglancer/webgl/shader_lib';
import {RPC} from 'neuroglancer/worker_rpc';

const tempMat2 = mat4.create();
const tempPickID = new Float32Array(4);

class RenderHelper extends RefCounted {
  private shaders = new Map<ShaderModule, ShaderProgram>();

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.addUniform('highp vec4', 'uColor');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp vec4', 'uPickID');
    builder.setVertexMain(`gl_Position = uProjection * vec4(aVertexPosition, 1.0);`);
    builder.setFragmentMain(`emit(uColor, uPickID);`);
  }

  beginLayer(
      gl: GL, shader: ShaderProgram, renderContext: SliceViewPanelRenderContext,
      objectToDataMatrix: mat4) {
    let {dataToDevice} = renderContext;
    let mat = mat4.multiply(tempMat2, dataToDevice, objectToDataMatrix);
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, mat);
  }

  getShader(gl: GL, emitter: ShaderModule) {
    let {shaders} = this;
    let shader = shaders.get(emitter);
    if (shader === undefined) {
      shader = this.registerDisposer(
          gl.memoize.get(`skeleton/SkeletonShaderManager:${getObjectId(emitter)}`, () => {
            let builder = new ShaderBuilder(gl);
            builder.require(emitter);
            this.defineShader(builder);
            return builder.build();
          }));
      shaders.set(emitter, shader);
    }
    return shader;
  }

  setColor(gl: GL, shader: ShaderProgram, color: vec3) {
    gl.uniform4fv(shader.uniform('uColor'), color);
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform4fv(shader.uniform('uPickID'), setVec4FromUint32(tempPickID, pickID));
  }

  drawSkeleton(gl: GL, shader: ShaderProgram, skeletonChunk: SkeletonChunk) {
    skeletonChunk.vertexBuffer.bindToVertexAttrib(
        shader.attribute('aVertexPosition'),
        /*components=*/3);

    skeletonChunk.indexBuffer.bind();
    gl.drawElements(gl.LINES, skeletonChunk.numIndices, gl.UNSIGNED_INT, 0);
  }

  endLayer(gl: GL, shader: ShaderProgram) {
    gl.disableVertexAttribArray(shader.attribute('aVertexPosition'));
  }
}

export class PerspectiveViewSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper = this.registerDisposer(new RenderHelper());

  constructor(public base: SkeletonLayer) {
    super();
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(() => { this.redrawNeeded.dispatch(); }));
    this.setReady(true);
    this.visibilityCount.addDependency(base.visibilityCount);
  }
  get gl() { return this.base.gl; }

  get isTransparent() { return this.base.displayState.objectAlpha.value < 1.0; }

  draw(renderContext: PerspectiveViewRenderContext) {
    this.base.draw(renderContext, this, this.renderHelper);
  }
}

export class SliceViewPanelSkeletonLayer extends SliceViewPanelRenderLayer {
  private renderHelper = this.registerDisposer(new RenderHelper());

  constructor(public base: SkeletonLayer) {
    super();
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(() => { this.redrawNeeded.dispatch(); }));
    this.setReady(true);
    this.visibilityCount.addDependency(base.visibilityCount);
  }
  get gl() { return this.base.gl; }

  draw(renderContext: SliceViewPanelRenderContext) {
    this.base.draw(renderContext, this, this.renderHelper, 10);
  }
};

export class SkeletonLayer extends RefCounted {
  private tempMat = mat4.create();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;

  get visibilityCount() { return this.sharedObject.visibilityCount; }

  constructor(
      public chunkManager: ChunkManager, public source: SkeletonSource,
      public voxelSizeObject: VoxelSize, public displayState: SegmentationDisplayState3D) {
    super();

    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);
    let sharedObject = this.sharedObject =
        this.registerDisposer(new SegmentationLayerSharedObject(chunkManager, displayState));
    sharedObject.RPC_TYPE_ID = SKELETON_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      'source': source.addCounterpartRef(),
    });
  }

  get gl() { return this.chunkManager.chunkQueueManager.gl; }

  draw(
      renderContext: SliceViewPanelRenderContext, layer: RenderLayer, renderHelper: RenderHelper,
      lineWidth?: number) {
    if (lineWidth === undefined) {
      lineWidth = renderContext.emitColor ? 1 : 5;
    }
    let {gl, source, displayState} = this;
    let alpha = Math.min(1.0, displayState.objectAlpha.value);
    if (alpha <= 0.0) {
      // Skip drawing.
      return;
    }
    const shader = renderHelper.getShader(gl, renderContext.emitter);
    shader.bind();

    let objectToDataMatrix = this.tempMat;
    mat4.identity(objectToDataMatrix);
    if (source.skeletonVertexCoordinatesInVoxels) {
      mat4.scale(objectToDataMatrix, objectToDataMatrix, this.voxelSizeObject.size);
    }
    mat4.multiply(
        objectToDataMatrix, this.displayState.objectToDataTransform.transform, objectToDataMatrix);
    renderHelper.beginLayer(gl, shader, renderContext, objectToDataMatrix);

    let skeletons = source.chunks;

    let {pickIDs} = renderContext;

    gl.lineWidth(lineWidth);

    forEachSegmentToDraw(displayState, skeletons, (rootObjectId, objectId, skeleton) => {
      if (skeleton.state !== ChunkState.GPU_MEMORY) {
        return;
      }
      if (renderContext.emitColor) {
        renderHelper.setColor(
            gl, shader, <vec3><Float32Array>getObjectColor(displayState, rootObjectId, alpha));
      }
      if (renderContext.emitPickID) {
        renderHelper.setPickID(gl, shader, pickIDs.registerUint64(layer, objectId));
      }
      renderHelper.drawSkeleton(gl, shader, skeleton);
    });
    renderHelper.endLayer(gl, shader);
  }
};

export class SkeletonChunk extends Chunk {
  vertexPositions: Float32Array;
  indices: Uint32Array;
  vertexBuffer: Buffer;
  indexBuffer: Buffer;
  numIndices: number;

  constructor(source: SkeletonSource, x: any) {
    super(source);
    this.vertexPositions = x['vertexPositions'];
    let indices = this.indices = x['indices'];
    this.numIndices = indices.length;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    this.vertexBuffer = Buffer.fromData(gl, this.vertexPositions, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
    this.indexBuffer = Buffer.fromData(gl, this.indices, gl.ELEMENT_ARRAY_BUFFER, gl.STATIC_DRAW);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.vertexBuffer.dispose();
    this.indexBuffer.dispose();
  }
};

export class SkeletonSource extends ChunkSource {
  chunks: Map<string, SkeletonChunk>;
  getChunk(x: any) { return new SkeletonChunk(this, x); }

  /**
   * Specifies whether the skeleton vertex coordinates are specified in units of voxels rather than
   * nanometers.
   */
  get skeletonVertexCoordinatesInVoxels() { return true; }
};

export class ParameterizedSkeletonSource<Parameters> extends SkeletonSource {
  constructor(chunkManager: ChunkManager, public parameters: Parameters) { super(chunkManager); }

  initializeCounterpart(rpc: RPC, options: any) {
    options['parameters'] = this.parameters;
    super.initializeCounterpart(rpc, options);
  }
};

/**
 * Defines a SkeletonSource for which all state is encapsulated in an object of type Parameters.
 */
export function parameterizedSkeletonSource<Parameters>(
    parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  const newConstructor =
      class SpecializedParameterizedSkeletonSource extends ParameterizedSkeletonSource<Parameters> {
    static get(chunkManager: ChunkManager, parameters: Parameters) {
      return chunkManager.getChunkSource(
          this, stableStringify(parameters), () => new this(chunkManager, parameters));
    }
    toString() { return parametersConstructor.stringify(this.parameters); }
  };
  newConstructor.prototype.RPC_TYPE_ID = parametersConstructor.RPC_ID;
  return newConstructor;
}
