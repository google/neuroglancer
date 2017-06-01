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
import {SKELETON_LAYER_RPC_ID, VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/panel';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {DataType} from 'neuroglancer/util/data_type';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {stableStringify, verifyString} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL_FLOAT} from 'neuroglancer/webgl/constants';
import {GL} from 'neuroglancer/webgl/context';
import {WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {setVec4FromUint32} from 'neuroglancer/webgl/shader_lib';
import {RPC} from 'neuroglancer/worker_rpc';

const glsl_COLORMAPS = require<string>('neuroglancer/webgl/colormaps.glsl');

const tempMat2 = mat4.create();
const tempPickID = new Float32Array(4);

const DEFAULT_FRAGMENT_MAIN = `void main() {
  emitDefault();
}
`;

export const FRAGMENT_MAIN_START = '//NEUROGLANCER_SKELETON_LAYER_FRAGMENT_MAIN_START';

export type TrackableFragmentMain = TrackableValue<string>;

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return new TrackableValue<string>(value, verifyString);
}

interface VertexAttributeRenderInfo extends VertexAttributeInfo {
  name: string;
  webglDataType: number;
  glslDataType: string;
}

class RenderHelper extends RefCounted {
  shaders = new Map<ShaderModule, ShaderProgram|null>();
  shaderGeneration = -1;
  private vertexAttributesKey = stableStringify(this.vertexAttributes);

  constructor(public vertexAttributes: VertexAttributeRenderInfo[]) {
    super();
  }

  defineShader(builder: ShaderBuilder, fragmentMain: string) {
    builder.addUniform('highp vec4', 'uColor');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp vec4', 'uPickID');
    let vertexMain = `
gl_Position = uProjection * vec4(aVertex0, 1.0);
`;

    builder.addFragmentCode(`
vec4 segmentColor() {
  return uColor;
}
void emitRGB(vec3 color) {
  emit(vec4(color * uColor.a, uColor.a), uPickID);
}
void emitDefault() {
  emit(uColor, uPickID);
}
`);
    builder.addFragmentCode(glsl_COLORMAPS);
    const {vertexAttributes} = this;
    vertexAttributes.forEach((info, i) => {
      builder.addAttribute(`highp ${info.glslDataType}`, `aVertex${i}`);
      if (i !== 0) {
        builder.addVarying(`highp ${info.glslDataType}`, `vVertex${i}`);
        // First attribute (vertex position) is treated specially.
        vertexMain += `vVertex${i} = aVertex${i};\n`;
        builder.addFragmentCode(`#define ${info.name} vVertex${i}\n`);
      }
    });
    builder.setVertexMain(vertexMain);
    builder.setFragmentMainFunction(FRAGMENT_MAIN_START + '\n' + fragmentMain);
  }

  beginLayer(
      gl: GL, shader: ShaderProgram, renderContext: SliceViewPanelRenderContext,
      objectToDataMatrix: mat4) {
    let {dataToDevice} = renderContext;
    let mat = mat4.multiply(tempMat2, dataToDevice, objectToDataMatrix);
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, mat);
  }

  getShader(gl: GL, emitter: ShaderModule, fragmentMain: string) {
    return this.registerDisposer(gl.memoize.get(
        `skeleton/SkeletonShaderManager:${getObjectId(emitter)}:` + this.vertexAttributesKey + ':' +
            fragmentMain,
        () => {
          let builder = new ShaderBuilder(gl);
          builder.require(emitter);
          this.defineShader(builder, fragmentMain);
          return builder.build();
        }));
  }

  setColor(gl: GL, shader: ShaderProgram, color: vec3) {
    gl.uniform4fv(shader.uniform('uColor'), color);
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform4fv(shader.uniform('uPickID'), setVec4FromUint32(tempPickID, pickID));
  }

  drawSkeleton(gl: GL, shader: ShaderProgram, skeletonChunk: SkeletonChunk) {
    const {vertexAttributes} = this;
    const numAttributes = vertexAttributes.length;
    const {vertexAttributeOffsets} = skeletonChunk;
    for (let i = 0; i < numAttributes; ++i) {
      const info = vertexAttributes[i];
      skeletonChunk.vertexBuffer.bindToVertexAttrib(
          shader.attribute(`aVertex${i}`),
          /*components=*/info.numComponents, info.webglDataType, /*normalized=*/false, /*stride=*/0,
          /*offset=*/vertexAttributeOffsets[i]);
    }
    skeletonChunk.indexBuffer.bind();
    gl.drawElements(gl.LINES, skeletonChunk.numIndices, gl.UNSIGNED_INT, 0);
  }

  endLayer(gl: GL, shader: ShaderProgram) {
    const {vertexAttributes} = this;
    const numAttributes = vertexAttributes.length;
    for (let i = 0; i < numAttributes; ++i) {
      gl.disableVertexAttribArray(shader.attribute(`aVertex${i}`));
    }
  }
}

export interface SkeletonLayerDisplayState extends SegmentationDisplayState3D {
  shaderError: WatchableShaderError;
  fragmentMain: TrackableValue<string>;
}

export class SkeletonLayer extends RefCounted {
  private tempMat = mat4.create();
  redrawNeeded = new NullarySignal();
  private sharedObject: SegmentationLayerSharedObject;
  vertexAttributes: VertexAttributeRenderInfo[];
  fallbackFragmentMain = DEFAULT_FRAGMENT_MAIN;

  get visibility() {
    return this.sharedObject.visibility;
  }

  constructor(
      public chunkManager: ChunkManager, public source: SkeletonSource,
      public voxelSizeObject: VoxelSize, public displayState: SkeletonLayerDisplayState) {
    super();

    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);
    this.displayState.shaderError.value = undefined;
    this.registerDisposer(displayState.fragmentMain.changed.add(() => {
      this.displayState.shaderError.value = undefined;
      this.redrawNeeded.dispatch();
    }));
    let sharedObject = this.sharedObject =
        this.registerDisposer(new SegmentationLayerSharedObject(chunkManager, displayState));
    sharedObject.RPC_TYPE_ID = SKELETON_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      'source': source.addCounterpartRef(),
    });

    const vertexAttributes = this.vertexAttributes = [vertexPositionAttribute];

    for (let [name, info] of source.vertexAttributes) {
      vertexAttributes.push({
        name,
        dataType: info.dataType,
        numComponents: info.numComponents,
        webglDataType: getWebglDataType(info.dataType),
        glslDataType: info.numComponents > 1 ? `vec${info.numComponents}` : 'float',
      });
    }
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  private getShader(gl: GL, renderHelper: RenderHelper, emitter: ShaderModule) {
    const {fragmentMain} = this.displayState;
    const shaderGeneration = fragmentMain.changed.count;
    const {shaders} = renderHelper;
    if (renderHelper.shaderGeneration !== shaderGeneration) {
      shaders.clear();
      renderHelper.shaderGeneration = shaderGeneration;
    }
    let shader = shaders.get(emitter);
    if (shader === undefined) {
      shader = null;
      try {
        shader = renderHelper.getShader(gl, emitter, fragmentMain.value);
        this.fallbackFragmentMain = fragmentMain.value;
        this.displayState.shaderError.value = null;
      } catch (shaderError) {
        this.displayState.shaderError.value = shaderError;
        try {
          shader = renderHelper.getShader(gl, emitter, this.fallbackFragmentMain);
        } catch (otherShaderError) {
        }
      }
      shaders.set(emitter, shader);
    }
    return shader;
  }

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
    const shader = this.getShader(gl, renderHelper, renderContext.emitter);
    if (shader === null) {
      // Shader error, skip drawing.
      return;
    }
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
}

export class PerspectiveViewSkeletonLayer extends PerspectiveViewRenderLayer {
  private renderHelper = this.registerDisposer(new RenderHelper(this.base.vertexAttributes));

  constructor(public base: SkeletonLayer) {
    super();
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.setReady(true);
    this.registerDisposer(base.visibility.add(this.visibility));
  }
  get gl() {
    return this.base.gl;
  }

  get isTransparent() {
    return this.base.displayState.objectAlpha.value < 1.0;
  }

  draw(renderContext: PerspectiveViewRenderContext) {
    this.base.draw(renderContext, this, this.renderHelper);
  }
}

export class SliceViewPanelSkeletonLayer extends SliceViewPanelRenderLayer {
  private renderHelper = this.registerDisposer(new RenderHelper(this.base.vertexAttributes));

  constructor(public base: SkeletonLayer) {
    super();
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.setReady(true);
    this.registerDisposer(base.visibility.add(this.visibility));
  }
  get gl() {
    return this.base.gl;
  }

  draw(renderContext: SliceViewPanelRenderContext) {
    this.base.draw(renderContext, this, this.renderHelper, 10);
  }
}

function getWebglDataType(dataType: DataType) {
  switch (dataType) {
    case DataType.FLOAT32:
      return GL_FLOAT;
    default:
      throw new Error('Data type not supported by WebGL: ${DataType[dataType]}');
  }
}

const vertexPositionAttribute: VertexAttributeRenderInfo = {
  dataType: DataType.FLOAT32,
  numComponents: 3,
  name: '',
  webglDataType: GL_FLOAT,
  glslDataType: 'vec3',
};

export class SkeletonChunk extends Chunk {
  vertexAttributes: Uint8Array;
  indices: Uint32Array;
  vertexBuffer: Buffer;
  indexBuffer: Buffer;
  numIndices: number;
  numVertices: number;
  vertexAttributeOffsets: Uint32Array;

  constructor(source: SkeletonSource, x: any) {
    super(source);
    this.vertexAttributes = x['vertexAttributes'];
    let indices = this.indices = x['indices'];
    this.vertexAttributeOffsets = x['vertexAttributeOffsets'];
    this.numIndices = indices.length;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    this.vertexBuffer = Buffer.fromData(gl, this.vertexAttributes, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
    this.indexBuffer = Buffer.fromData(gl, this.indices, gl.ELEMENT_ARRAY_BUFFER, gl.STATIC_DRAW);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.vertexBuffer.dispose();
    this.indexBuffer.dispose();
  }
}

const emptyVertexAttributes = new Map<string, VertexAttributeInfo>();

export class SkeletonSource extends ChunkSource {
  chunks: Map<string, SkeletonChunk>;
  getChunk(x: any) {
    return new SkeletonChunk(this, x);
  }

  /**
   * Specifies whether the skeleton vertex coordinates are specified in units of voxels rather than
   * nanometers.
   */
  get skeletonVertexCoordinatesInVoxels() {
    return true;
  }

  get vertexAttributes(): Map<string, VertexAttributeInfo> {
    return emptyVertexAttributes;
  }
}

export class ParameterizedSkeletonSource<Parameters> extends SkeletonSource {
  constructor(chunkManager: ChunkManager, public parameters: Parameters) {
    super(chunkManager);
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['parameters'] = this.parameters;
    super.initializeCounterpart(rpc, options);
  }
}

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
    toString() {
      return parametersConstructor.stringify(this.parameters);
    }
  };
  newConstructor.prototype.RPC_TYPE_ID = parametersConstructor.RPC_ID;
  return newConstructor;
}
