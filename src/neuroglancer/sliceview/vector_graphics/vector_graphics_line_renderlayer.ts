/**
 * @license
 * Copyright 2017 Google Inc.
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
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {VectorGraphicsSourceOptions} from 'neuroglancer/sliceview/vector_graphics/base';
import {MultiscaleVectorGraphicsChunkSource, RenderLayer as GenericVectorGraphicsRenderLayer, VectorGraphicsChunkSource} from 'neuroglancer/sliceview/vector_graphics/frontend';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableFiniteFloat, trackableFiniteFloat} from 'neuroglancer/trackable_finite_float';
import {trackableVec3, TrackableVec3} from 'neuroglancer/trackable_vec3';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';

const tempMat4 = mat4.create();

export class VectorGraphicsLineRenderLayer extends GenericVectorGraphicsRenderLayer {
  opacity: TrackableAlphaValue;
  lineWidth: TrackableFiniteFloat;
  color: TrackableVec3;
  private vertexIndexBuffer: Buffer;
  private normalDirectionBuffer: Buffer;


  constructor(multiscaleSource: MultiscaleVectorGraphicsChunkSource, {
    opacity = trackableAlphaValue(0.5),
    lineWidth = trackableFiniteFloat(10.0),
    color = trackableVec3(vec3.fromValues(255.0, 255.0, 255.0)),
    sourceOptions = <VectorGraphicsSourceOptions>{},
  } = {}) {
    super(multiscaleSource, {sourceOptions});

    this.opacity = opacity;
    this.registerDisposer(opacity.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));

    this.lineWidth = lineWidth;
    this.registerDisposer(lineWidth.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));

    this.color = color;
    this.registerDisposer(color.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));

    let gl = this.gl;

    let vertexIndex = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1]);

    this.vertexIndexBuffer =
        this.registerDisposer(Buffer.fromData(gl, vertexIndex, gl.ARRAY_BUFFER, gl.STATIC_DRAW));

    let normalDirection = new Float32Array([1, 1, -1, -1]);

    this.normalDirectionBuffer = this.registerDisposer(
        Buffer.fromData(gl, normalDirection, gl.ARRAY_BUFFER, gl.STATIC_DRAW));
  }

  getShaderKey() {
    return `vectorgraphics.VectorGraphicsLineRenderLayer`;
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);

    builder.addUniform('highp float', 'uOpacity');
    builder.addUniform('highp float', 'ulineWidth');
    builder.addUniform('highp vec3', 'uColor');
    builder.addVarying('vec3', 'vNormal');

    builder.addAttribute('highp float', 'aNormalDirection');
    builder.addAttribute('highp vec2', 'aVertexIndex');

    builder.addAttribute('highp vec3', 'aVertexFirst');
    builder.addAttribute('highp vec3', 'aVertexSecond');
    builder.addUniform('highp mat4', 'uProjection');

    builder.setFragmentMain(`
float distance = length(vNormal);

float antialiasing = 0.5;

if (distance >= 1.0 - antialiasing) {
  emitRGBA(vec4(uColor, (distance - 1.0) / -antialiasing ));
}
else if (distance < 1.0 - antialiasing) {
  emitRGB(uColor);
}
`);
    builder.setVertexMain(`
vec3 direction = vec3(0., 0., 0.);
direction.z = aNormalDirection;

vec3 difference = aVertexSecond - aVertexFirst;
difference.z = 0.;

vec3 normal = cross(difference, direction);
normal = normalize(normal);
vNormal = normal;

vec4 delta = vec4(normal * ulineWidth, 0.0);
vec4 pos = vec4(aVertexFirst * aVertexIndex.x + aVertexSecond * aVertexIndex.y, 1.0);

gl_Position = uProjection * (pos + delta);
`);
  }

  beginSlice(_sliceView: SliceView) {
    super.beginSlice(_sliceView);

    let gl = this.gl;
    let shader = this.shader!;
    gl.uniform1f(shader.uniform('uOpacity'), this.opacity.value);
    gl.uniform1f(shader.uniform('ulineWidth'), this.lineWidth.value);
    gl.uniform3fv(shader.uniform('uColor'), this.color.value);

    this.vertexIndexBuffer.bindToVertexAttrib(
        shader.attribute('aVertexIndex'),
        /*components=*/2);

    this.normalDirectionBuffer.bindToVertexAttrib(
        shader.attribute('aNormalDirection'),
        /*components=*/1);

    return shader;
  }

  endSlice(shader: ShaderProgram) {
    let gl = this.gl;

    gl.disableVertexAttribArray(shader.attribute('aVertexIndex'));
    gl.disableVertexAttribArray(shader.attribute('aNormalDirection'));

    gl.disableVertexAttribArray(shader.attribute('aVertexFirst'));
    gl.disableVertexAttribArray(shader.attribute('aVertexSecond'));
  }

  draw(sliceView: SliceView) {
    let visibleSources = sliceView.visibleLayers.get(this)!;
    if (visibleSources.length === 0) {
      return;
    }

    let gl = this.gl;

    let shader = this.beginSlice(sliceView);
    if (shader === undefined) {
      console.log('error: shader undefined');
      return;
    }


    for (let transformedSource of visibleSources) {
      const chunkLayout = transformedSource.chunkLayout;
      const source = transformedSource.source as VectorGraphicsChunkSource;
      let voxelSize = source.spec.voxelSize;
      let chunks = source.chunks;

      let objectToDataMatrix = tempMat4;
      mat4.identity(objectToDataMatrix);
      if (source.vectorGraphicsCoordinatesInVoxels) {
        mat4.scale(objectToDataMatrix, objectToDataMatrix, voxelSize);
      }
      mat4.multiply(objectToDataMatrix, chunkLayout.transform, objectToDataMatrix);

      // Compute projection matrix that transforms vertex coordinates to device coordinates
      gl.uniformMatrix4fv(
          shader.uniform('uProjection'), false,
          mat4.multiply(tempMat4, sliceView.dataToDevice, objectToDataMatrix));

      let visibleChunks = sliceView.visibleChunks.get(chunkLayout);
      if (!visibleChunks) {
        continue;
      }

      for (let key of visibleChunks) {
        let chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          let numInstances = chunk.numPoints / 2;  // Two points == One vector

          const aVertexFirst = shader.attribute('aVertexFirst');
          chunk.vertexBuffer.bindToVertexAttrib(
              aVertexFirst,
              /*components=*/3,
              /*attributeType=*/WebGL2RenderingContext.FLOAT,
              /*normalized=*/false,
              /*stride=*/6 * 4,
              /*offset=*/0);
          gl.vertexAttribDivisor(aVertexFirst, 1);

          const aVertexSecond = shader.attribute('aVertexSecond');
          chunk.vertexBuffer.bindToVertexAttrib(
              aVertexSecond,
              /*components=*/3,
              /*attributeType=*/WebGL2RenderingContext.FLOAT,
              /*normalized=*/false,
              /*stride=*/6 * 4,
              /*offset=*/3 * 4);
          gl.vertexAttribDivisor(aVertexSecond, 1);

          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, numInstances);

          gl.vertexAttribDivisor(aVertexFirst, 0);
          gl.vertexAttribDivisor(aVertexSecond, 0);
        }
      }
    }
    this.endSlice(shader);
  }
}
