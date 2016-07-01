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
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer, perspectivePanelEmit} from 'neuroglancer/perspective_panel';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state';
import {SKELETON_LAYER_RPC_ID} from 'neuroglancer/skeleton/base';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer, sliceViewPanelEmit} from 'neuroglancer/sliceview/panel';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Mat4, Vec3, mat4, vec3} from 'neuroglancer/util/geom';
import {stableStringify} from 'neuroglancer/util/json';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {setVec4FromUint32} from 'neuroglancer/webgl/shader_lib';
import {RPC, SharedObject} from 'neuroglancer/worker_rpc';
import {Signal} from 'signals';

class SkeletonShaderManager {
  private tempMat = mat4.create();
  private tempPickID = new Float32Array(4);
  constructor() {}

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.addUniform('highp vec3', 'uColor');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp vec4', 'uPickID');
    builder.setVertexMain(`gl_Position = uProjection * vec4(aVertexPosition, 1.0);`);
    builder.setFragmentMain(`emit(vec4(uColor, 1.0), uPickID);`);
  }

  beginLayer(
      gl: GL, shader: ShaderProgram, renderContext: SliceViewPanelRenderContext,
      objectToDataMatrix: Mat4) {
    let {dataToDevice} = renderContext;
    let mat = mat4.multiply(this.tempMat, dataToDevice, objectToDataMatrix);
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, mat);
  }

  getShader(gl: GL, key: string, emitter: ShaderModule) {
    return gl.memoize.get(key, () => {
      let builder = new ShaderBuilder(gl);
      builder.require(emitter);
      this.defineShader(builder);
      return builder.build();
    });
  }

  drawSkeleton(
      gl: GL, shader: ShaderProgram, skeletonChunk: SkeletonChunk, color: Vec3, pickID: number,
      pickingOnly: boolean) {
    if (!pickingOnly) {
      gl.uniform3fv(shader.uniform('uColor'), color);
    }

    gl.uniform4fv(shader.uniform('uPickID'), setVec4FromUint32(this.tempPickID, pickID));

    skeletonChunk.vertexBuffer.bindToVertexAttrib(
        shader.attribute('aVertexPosition'),
        /*components=*/3);

    skeletonChunk.indexBuffer.bind();
    gl.drawElements(gl.LINES, skeletonChunk.numIndices, gl.UNSIGNED_INT, 0);
  }

  endLayer(gl: GL, shader: ShaderProgram) {
    gl.disableVertexAttribArray(shader.attribute('aVertexPosition'));
  }
};

export class PerspectiveViewSkeletonLayer extends PerspectiveViewRenderLayer {
  private shader = this.base.skeletonShaderManager.getShader(
      this.gl, 'skeleton/SkeletonShaderManager:PerspectivePanel', perspectivePanelEmit);

  constructor(public base: SkeletonLayer) {
    super();
    this.registerDisposer(base);
    this.registerSignalBinding(base.redrawNeeded.add(() => { this.redrawNeeded.dispatch(); }));
    this.setReady(true);
  }
  get gl() { return this.base.gl; }

  draw(renderContext: PerspectiveViewRenderContext, pickingOnly = false) {
    this.base.draw(renderContext, this, this.shader, pickingOnly);
  }
  drawPicking(renderContext: PerspectiveViewRenderContext) {
    this.base.draw(renderContext, this, this.shader, true);
  }
};

export class SliceViewPanelSkeletonLayer extends SliceViewPanelRenderLayer {
  private shader = this.base.skeletonShaderManager.getShader(
      this.gl, 'skeleton/SkeletonShaderManager:SliceViewPanel', sliceViewPanelEmit);

  constructor(public base: SkeletonLayer) {
    super();
    this.registerDisposer(base);
    this.registerSignalBinding(base.redrawNeeded.add(() => { this.redrawNeeded.dispatch(); }));
    this.setReady(true);
  }
  get gl() { return this.base.gl; }

  draw(renderContext: SliceViewPanelRenderContext) {
    this.base.draw(renderContext, this, this.shader, false, 10);
  }
};

export class SkeletonLayer extends RefCounted {
  private tempMat = mat4.create();
  skeletonShaderManager = new SkeletonShaderManager();
  redrawNeeded = new Signal();

  constructor(
      public chunkManager: ChunkManager, public source: SkeletonSource,
      public voxelSizeObject: VoxelSize, public displayState: SegmentationDisplayState) {
    super();

    let dispatchRedrawNeeded = () => { this.redrawNeeded.dispatch(); };
    this.registerSignalBinding(displayState.segmentColorHash.changed.add(dispatchRedrawNeeded));
    this.registerSignalBinding(displayState.visibleSegments.changed.add(dispatchRedrawNeeded));
    this.registerSignalBinding(
        displayState.segmentSelectionState.changed.add(dispatchRedrawNeeded));

    let sharedObject = this.registerDisposer(new SharedObject());
    sharedObject.RPC_TYPE_ID = SKELETON_LAYER_RPC_ID;
    sharedObject.initializeCounterpart(chunkManager.rpc!, {
      'chunkManager': chunkManager.rpcId,
      'source': source.addCounterpartRef(),
      'visibleSegmentSet': displayState.visibleSegments.rpcId
    });
  }

  get gl() { return this.chunkManager.chunkQueueManager.gl; }

  draw(
      renderContext: SliceViewPanelRenderContext, layer: RenderLayer, shader: ShaderProgram,
      pickingOnly = false, lineWidth?: number) {
    if (lineWidth === undefined) {
      lineWidth = pickingOnly ? 5 : 1;
    }
    let {gl, skeletonShaderManager} = this;
    shader.bind();

    let objectToDataMatrix = this.tempMat;
    mat4.identity(objectToDataMatrix);
    mat4.scale(objectToDataMatrix, objectToDataMatrix, this.voxelSizeObject.size);
    skeletonShaderManager.beginLayer(gl, shader, renderContext, objectToDataMatrix);

    let skeletons = this.source.chunks;

    let {pickIDs} = renderContext;

    let color = vec3.create();
    let {displayState} = this;
    let {segmentColorHash, segmentSelectionState} = displayState;

    gl.lineWidth(lineWidth);

    for (let objectId of displayState.visibleSegments) {
      let objectKey = `${objectId.low}:${objectId.high}`;
      let skeleton = skeletons.get(objectKey);
      if (skeleton === undefined || skeleton.state !== ChunkState.GPU_MEMORY) {
        continue;
      }
      if (!pickingOnly) {
        segmentColorHash.compute(color, objectId);
        if (segmentSelectionState.isSelected(objectId)) {
          for (let i = 0; i < 3; ++i) {
            color[i] = color[i] * 0.5 + 0.5;
          }
        }
      }
      skeletonShaderManager.drawSkeleton(
          gl, shader, skeleton, color, pickIDs.register(layer, objectId), pickingOnly);
    }
    skeletonShaderManager.endLayer(gl, shader);
  }
};

export class SkeletonChunk extends Chunk {
  data: Uint8Array;
  vertexBuffer: Buffer;
  indexBuffer: Buffer;
  numIndices: number;

  constructor(source: SkeletonSource, x: any) {
    super(source);
    this.data = x['data'];
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    let {data} = this;
    let dv = new DataView(data.buffer);
    let numVertices = dv.getInt32(0, true);
    let positions = new Float32Array(data.buffer, 4, numVertices * 3);
    let indices = new Uint32Array(data.buffer, 4 * (numVertices * 3) + 4);

    this.vertexBuffer = Buffer.fromData(gl, positions, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
    this.indexBuffer = Buffer.fromData(gl, indices, gl.ELEMENT_ARRAY_BUFFER, gl.STATIC_DRAW);
    this.numIndices = indices.length;
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
