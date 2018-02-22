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

import {AnnotationPointColorList, DEFAULT_COLOR} from 'neuroglancer/annotation/point_color_list';
import {AnnotationPointList} from 'neuroglancer/annotation/point_list';
import {AnnotationPointSizeList, DEFAULT_SIZE} from 'neuroglancer/annotation/point_size_list';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {MouseSelectionState, RenderLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/panel';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableValue, WatchableValue} from 'neuroglancer/trackable_value';
import {TrackableVec3} from 'neuroglancer/trackable_vec3';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {verifyFinitePositiveFloat} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {countingBufferShaderModule, disableCountingBuffer, getCountingBuffer} from 'neuroglancer/webgl/index_emulation';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_addUint32, setVec4FromUint32} from 'neuroglancer/webgl/shader_lib';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';

const tempMat = mat4.create();
const tempPickID = new Float32Array(4);

export class AnnotationPointListLayer extends RefCounted {
  posBuffer: Buffer;
  colBuffer: Buffer;
  sizeBuffer: Buffer;
  posGeneration = -1;
  colGeneration = -1;
  sizeGeneration = -1;
  usePerspective2D = new TrackableBoolean(false);
  usePerspective3D = new TrackableBoolean(false);
  defaultSize = new TrackableValue<number>(DEFAULT_SIZE, verifyFinitePositiveFloat);
  defaultColor = new TrackableVec3(vec3.clone(DEFAULT_COLOR), DEFAULT_COLOR);
  redrawNeeded = new NullarySignal();

  constructor(
      public chunkManager: ChunkManager, public pointList: AnnotationPointList,
      public colorList: AnnotationPointColorList, public sizeList: AnnotationPointSizeList,
      public voxelSizeObject: VoxelSize, public selectedIndex: WatchableValue<number|null>) {
    super();
    this.posBuffer = new Buffer(chunkManager.gl);
    this.colBuffer = new Buffer(chunkManager.gl);
    this.sizeBuffer = new Buffer(chunkManager.gl);
    this.registerDisposer(pointList.changed.add(() => {
      // Clear selectedIndex, since the indices have changed.
      this.selectedIndex.value = null;
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(colorList.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(sizeList.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(selectedIndex.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(this.usePerspective2D.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(this.usePerspective3D.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(this.defaultSize.changed.add(() => {
      ++this.sizeList.generation;
      this.redrawNeeded.dispatch();
    }));
    this.registerDisposer(this.defaultColor.changed.add(() => {
      ++this.colorList.generation;
      this.redrawNeeded.dispatch();
    }));
  }

  get gl() {
    return this.chunkManager.gl;
  }

  updateBuffer() {
    let {pointList, colorList, sizeList} = this;
    let newGeneration = pointList.generation;
    let pointsChanged = false;
    if (this.posGeneration !== newGeneration) {
      pointsChanged = true;
      this.posGeneration = newGeneration;
      this.posBuffer.setData(pointList.points.view);
    }

    newGeneration = colorList.generation;
    if (this.colGeneration !== newGeneration || pointsChanged) {
      this.colGeneration = newGeneration;
      if (colorList.colors.length < pointList.points.length) {
        let tmp = new Float32Array(pointList.points.length);
        tmp.set(colorList.colors.view);
        for (let i = colorList.colors.length; i < pointList.points.length; i += 3) {
          tmp.set(this.defaultColor.value, i);
        }
        this.colBuffer.setData(tmp);
      } else {
        this.colBuffer.setData(colorList.colors.view);
      }
    }

    newGeneration = sizeList.generation;
    if (this.sizeGeneration !== newGeneration || pointsChanged) {
      this.sizeGeneration = newGeneration;
      if (sizeList.sizes.length < pointList.points.length) {
        let tmp = new Float32Array(pointList.points.length);
        tmp.set(sizeList.sizes.view);
        tmp.fill(this.defaultSize.value, sizeList.sizes.length, pointList.points.length);
        this.sizeBuffer.setData(tmp);
      } else {
        this.sizeBuffer.setData(sizeList.sizes.view);
      }
    }
  }

  updateMouseState(mouseState: MouseSelectionState, pickedOffset: number) {
    vec3.multiply(mouseState.position, this.pointList.get(pickedOffset), this.voxelSizeObject.size);
  }
}

export class RenderHelper extends RefCounted {
  private shaders = new Map<ShaderModule, ShaderProgram>();
  private squareCornersBuffer = getSquareCornersBuffer(this.gl);
  private countingBuffer = this.registerDisposer(getCountingBuffer(this.gl));

  constructor(public gl: GL) {
    super();
  }

  defineShader(builder: ShaderBuilder) {
    // Position of point in camera coordinates.
    builder.addAttribute('highp vec3', 'aVertexPosition');

    // Color of point in RGB float [0..1]
    builder.addAttribute('mediump vec3', 'aVertexColor');

    // The radius of the point in world units (when using perspective scaling)
    // For fixed size points, radius is simply 0.25 * world unit radius.
    builder.addAttribute('mediump float', 'aVertexSize');

    // XY corners of square ranging from [-1, -1] to [1, 1].
    builder.addAttribute('highp vec2', 'aCornerOffset');

    // Whether points should be fixed size or obey perspective.
    builder.addUniform('bool', 'uPerspective');

    builder.addUniform('highp vec4', 'uSelectedIndex');
    builder.addVarying('highp vec4', 'vColor');
    builder.addVarying('highp float', 'vDepth');

    builder.addUniform('highp vec2', 'uViewport');
    builder.addUniform('highp mat4', 'uModelView');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp mat4', 'uInvProjection');
    builder.addUniform('highp vec4', 'uPickID');
    builder.addVarying('highp vec4', 'vPickID');
    builder.addVarying('highp vec2', 'vPointCoord');
    builder.require(countingBufferShaderModule);
    builder.addVertexCode(glsl_addUint32);
    builder.setVertexMain(`
#define SQRT2 1.41421356237

vec4 worldPos = uModelView * vec4(aVertexPosition, 1.0);

gl_Position = uProjection * worldPos;
gl_Position /= gl_Position.w;
vDepth = gl_Position.z;

if (uPerspective) {
  vec4 tmpProjCornerPos = gl_Position;
  tmpProjCornerPos.xy += aCornerOffset / uViewport * uViewport.y;

  vec4 worldCornerPos = uInvProjection * tmpProjCornerPos;
  worldCornerPos /= worldCornerPos.w;
  vec3 worldCornerOffset = SQRT2 * aVertexSize * normalize(worldCornerPos.xyz - worldPos.xyz);

  worldCornerPos.xyz = worldPos.xyz + worldCornerOffset;
  gl_Position = uProjection * worldCornerPos;
  gl_Position /= gl_Position.w;
} else {
  gl_Position.xy += 0.25 * aVertexSize * aCornerOffset / uViewport;
}

vPointCoord = aCornerOffset;

uint32_t primitiveIndex = getPrimitiveIndex();

uint32_t pickID; pickID.value = uPickID;
vPickID = add(pickID, primitiveIndex).value;
vec4 vUserColor = vec4(aVertexColor, 1.0);

if (uSelectedIndex == primitiveIndex.value) {
  vColor = vec4(1.0) - vec4(vUserColor.gbr, 0.0);
} else {
  vColor = vUserColor;
}
`);
    builder.setFragmentMain(`
if (dot(vPointCoord, vPointCoord) > 1.0) {
  discard;
}
emit(getColor(), vPickID);
`);
  }

  getShader(emitter: ShaderModule) {
    let {shaders} = this;
    let shader = shaders.get(emitter);
    if (shader === undefined) {
      const builder = new ShaderBuilder(this.gl);
      builder.require(emitter);
      this.defineShader(builder);
      shader = this.registerDisposer(builder.build());
      shaders.set(emitter, shader);
    }
    return shader;
  }

  draw(
      renderLayer: RenderLayer, base: AnnotationPointListLayer,
      renderContext: SliceViewPanelRenderContext|PerspectiveViewRenderContext) {
    let shader = this.getShader(renderContext.emitter);
    let {gl} = this;
    shader.bind();
    base.updateBuffer();
    const numPoints = base.pointList.length;
    const aVertexPosition = shader.attribute('aVertexPosition');
    const aVertexSize = shader.attribute('aVertexSize');
    const aCornerOffset = shader.attribute('aCornerOffset');
    base.posBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/3);
    gl.ANGLE_instanced_arrays.vertexAttribDivisorANGLE(aVertexPosition, 1);
    base.sizeBuffer.bindToVertexAttrib(aVertexSize, /*components=*/1);
    gl.ANGLE_instanced_arrays.vertexAttribDivisorANGLE(aVertexSize, 1);
    this.squareCornersBuffer.bindToVertexAttrib(aCornerOffset, /*components=*/2);
    this.countingBuffer.ensure(numPoints).bind(shader, 1);

    let aVertexColor = -1;
    if (renderContext.emitColor) {
      aVertexColor = shader.attribute('aVertexColor');
      base.colBuffer.bindToVertexAttrib(aVertexColor, /*components=*/3);
      gl.ANGLE_instanced_arrays.vertexAttribDivisorANGLE(aVertexColor, 1);
    }

    let objectToDataMatrix = tempMat;
    let invProjection = mat4.create();
    mat4.invert(invProjection, renderContext.dataToDevice);
    mat4.identity(objectToDataMatrix);
    mat4.scale(objectToDataMatrix, objectToDataMatrix, base.voxelSizeObject.size);
    gl.uniformMatrix4fv(shader.uniform('uModelView'), false, objectToDataMatrix);
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, renderContext.dataToDevice);
    gl.uniformMatrix4fv(shader.uniform('uInvProjection'), false, invProjection);
    gl.uniform2f(
        shader.uniform('uViewport'), renderContext.viewportWidth, renderContext.viewportHeight);
    if (renderLayer instanceof SliceViewPanelRenderLayer) {
      gl.uniform1i(shader.uniform('uPerspective'), base.usePerspective2D.value ? 1 : 0);
    } else {  // instanceof PerspectiveViewPanelRenderLayer
      gl.uniform1i(shader.uniform('uPerspective'), base.usePerspective3D.value ? 1 : 0);
    }
    if (renderContext.emitPickID) {
      const pickID = renderContext.pickIDs.register(renderLayer, numPoints);
      gl.uniform4fv(shader.uniform('uPickID'), setVec4FromUint32(tempPickID, pickID));
    }
    if (renderContext.emitColor) {
      let selectedIndex = base.selectedIndex.value;
      if (selectedIndex === null) {
        selectedIndex = 0xFFFFFFFF;
      }
      gl.uniform4fv(shader.uniform('uSelectedIndex'), setVec4FromUint32(tempPickID, selectedIndex));
    }

    gl.ANGLE_instanced_arrays.drawArraysInstancedANGLE(gl.TRIANGLE_FAN, 0, 4, numPoints);
    gl.ANGLE_instanced_arrays.vertexAttribDivisorANGLE(aVertexPosition, 0);
    gl.ANGLE_instanced_arrays.vertexAttribDivisorANGLE(aVertexSize, 0);
    disableCountingBuffer(gl, shader, /*instanced=*/true);
    gl.disableVertexAttribArray(aVertexPosition);
    gl.disableVertexAttribArray(aVertexSize);

    if (renderContext.emitColor) {
      gl.ANGLE_instanced_arrays.vertexAttribDivisorANGLE(aVertexColor, 0);
      gl.disableVertexAttribArray(aVertexColor);
    }
  }
}

class PerspectiveViewRenderHelper extends RenderHelper {
  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    builder.addFragmentCode(`
vec4 getColor () { return vColor; }
`);
  }
}

export class PerspectiveViewAnnotationPointListLayer extends PerspectiveViewRenderLayer {
  private renderHelper = this.registerDisposer(new PerspectiveViewRenderHelper(this.gl));

  constructor(public base: AnnotationPointListLayer) {
    super();
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.setReady(true);
  }

  get gl() {
    return this.base.chunkManager.gl;
  }

  draw(renderContext: PerspectiveViewRenderContext) {
    this.renderHelper.draw(this, this.base, renderContext);
  }

  updateMouseState(mouseState: MouseSelectionState, _pickedValue: Uint64, pickedOffset: number) {
    this.base.updateMouseState(mouseState, pickedOffset);
  }

  transformPickedValue(_pickedValue: Uint64, pickedOffset: number) {
    return pickedOffset;
  }
}

class SliceViewRenderHelper extends RenderHelper {
  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    builder.addFragmentCode(`
vec4 getColor() {
  float scalar = 1.0 - abs(vDepth);
  return vec4(vColor.xyz, scalar * vColor.a);
}
`);
  }
}

export class SliceViewAnnotationPointListLayer extends SliceViewPanelRenderLayer {
  private renderHelper = this.registerDisposer(new SliceViewRenderHelper(this.gl));

  constructor(public base: AnnotationPointListLayer) {
    super();
    this.registerDisposer(base);
    this.registerDisposer(base.redrawNeeded.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.setReady(true);
  }

  get gl() {
    return this.base.chunkManager.gl;
  }

  draw(renderContext: SliceViewPanelRenderContext) {
    this.renderHelper.draw(this, this.base, renderContext);
  }

  updateMouseState(mouseState: MouseSelectionState, _pickedValue: Uint64, pickedOffset: number) {
    this.base.updateMouseState(mouseState, pickedOffset);
  }

  transformPickedValue(_pickedValue: Uint64, pickedOffset: number) {
    return pickedOffset;
  }
}
