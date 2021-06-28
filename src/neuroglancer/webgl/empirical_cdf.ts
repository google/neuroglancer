/**
 * @license
 * Copyright 2020 Google Inc.
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

/**
 * @file Defines facilities for GPU computation of empirical cumulative distribution functions.
 *
 * This is based on the technique described in
 * https://developer.amd.com/wordpress/media/2012/10/GPUHistogramGeneration_preprint.pdf
 *
 * In particular, the "scatter" operation required to compute a histogram is performed by
 * rendering point primitives.
 */

import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {DataTypeInterval} from 'neuroglancer/util/lerp';
import {VisibilityPriorityAggregator} from 'neuroglancer/visibility_priority/frontend';
import {getMemoizedBuffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, makeTextureBuffers, TextureBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {glsl_simpleFloatHash} from 'neuroglancer/webgl/shader_lib';
import {setRawTextureParameters} from 'neuroglancer/webgl/texture';

const DEBUG_HISTOGRAMS = false;

export interface HistogramChannelSpecification {
  // Channel coordinates.
  channel: Uint32Array;
}

export class HistogramSpecifications extends RefCounted {
  framebuffers: FramebufferConfiguration<TextureBuffer>[] = [];
  producerVisibility = new VisibilityPriorityAggregator();
  frameNumber = -1;
  constructor(
      public channels: WatchableValueInterface<HistogramChannelSpecification[]>,
      public bounds: WatchableValueInterface<DataTypeInterval[]>,
      public visibility = new VisibilityPriorityAggregator()) {
    super();
  }

  getFramebuffers(gl: GL) {
    const {framebuffers} = this;
    while (framebuffers.length < this.channels.value.length) {
      const framebuffer = new FramebufferConfiguration(gl, {
        colorBuffers: makeTextureBuffers(
            gl, 1, WebGL2RenderingContext.R32F, WebGL2RenderingContext.RED,
            WebGL2RenderingContext.FLOAT),
      });
      framebuffers.push(framebuffer);
    }
    return framebuffers;
  }

  disposed() {
    for (const framebuffer of this.framebuffers) {
      framebuffer.dispose();
    }
    this.framebuffers.length = 0;
  }
}

const histogramDataSamplerTextureUnit = Symbol('histogramDataSamplerTextureUnit');
const histogramDepthTextureUnit = Symbol('histogramDepthTextureUnit');

const histogramSamplesPerInstance = 4096;

// Number of points to sample in computing the histogram.  Increasing this increases the precision
// of the histogram but also slows down rendering.
const histogramSamples = 2 ** 14;

// Generates a histogram from a single-channel uint8 texture.
export class TextureHistogramGenerator extends RefCounted {
  private shader = this.registerDisposer((() => {
    const builder = new ShaderBuilder(this.gl);
    builder.addOutputBuffer('vec4', 'outputValue', 0);
    builder.addAttribute('float', 'aInput1');
    builder.addTextureSampler('sampler2D', 'uDataSampler', histogramDataSamplerTextureUnit);
    builder.addTextureSampler('sampler2D', 'uDepthSampler', histogramDepthTextureUnit);
    // builder.addUniform('float', 'uRandomSeed');
    builder.addVertexCode(glsl_simpleFloatHash);
    builder.setVertexMain(`
float uRandomSeed = 0.0;
vec2 p = vec2(simpleFloatHash(vec2(aInput1 + float(gl_VertexID), uRandomSeed + float(gl_InstanceID))),
              simpleFloatHash(vec2(aInput1 + float(gl_VertexID) + 10.0, 5.0 + uRandomSeed + float(gl_InstanceID))));
float dataValue = texture(uDataSampler, p).x;
float stencilValue = texture(uDepthSampler, p).x;
if (stencilValue == 1.0) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
} else {
  gl_Position = vec4(2.0 * (dataValue * 255.0 + 0.5) / 256.0 - 1.0, 0.0, 0.0, 1.0);
}
gl_PointSize = 1.0;
`);
    builder.setFragmentMain(`
outputValue = vec4(1.0, 1.0, 1.0, 1.0);
`);
    return builder.build();
  })());

  private inputIndexBuffer = this.registerDisposer(getMemoizedBuffer(
      this.gl, WebGL2RenderingContext.ARRAY_BUFFER,
      () => new Uint8Array(histogramSamplesPerInstance)));

  constructor(public gl: GL) {
    super();
  }

  static get(gl: GL) {
    return gl.memoize.get('textureHistogramGeneration', () => new TextureHistogramGenerator(gl));
  }

  compute(
      count: number, depthTexture: WebGLTexture|null, inputTextures: TextureBuffer[],
      histogramSpecifications: HistogramSpecifications, frameNumber: number) {
    const {gl} = this;
    const {shader} = this;
    const outputFramebuffers = histogramSpecifications.getFramebuffers(gl);
    shader.bind();
    gl.enable(WebGL2RenderingContext.BLEND);
    gl.disable(WebGL2RenderingContext.SCISSOR_TEST);
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
    gl.blendFunc(WebGL2RenderingContext.ONE, WebGL2RenderingContext.ONE);
    this.inputIndexBuffer.value.bindToVertexAttrib(
        shader.attribute('aInput1'), 1, WebGL2RenderingContext.UNSIGNED_BYTE,
        /*normalized=*/ true);
    const dataUnit = shader.textureUnit(histogramDataSamplerTextureUnit);
    const depthUnit = shader.textureUnit(histogramDepthTextureUnit);
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + depthUnit);
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, depthTexture);
    setRawTextureParameters(gl);
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + dataUnit);
    const oldFrameNumber = histogramSpecifications.frameNumber;
    histogramSpecifications.frameNumber = frameNumber;
    for (let i = 0; i < count; ++i) {
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, inputTextures[i].texture);
      setRawTextureParameters(gl);
      outputFramebuffers[i].bind(256, 1);
      if (frameNumber !== oldFrameNumber) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
      }
      gl.drawArraysInstanced(
          WebGL2RenderingContext.POINTS, 0, histogramSamplesPerInstance,
          histogramSamples / histogramSamplesPerInstance);

      if (DEBUG_HISTOGRAMS) {
        const tempBuffer = new Float32Array(256 * 4);
        gl.readPixels(
            0, 0, 256, 1, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.FLOAT, tempBuffer);
        const tempBuffer2 = new Float32Array(256);
        for (let j = 0; j < 256; ++j) {
          tempBuffer2[j] = tempBuffer[j * 4];
        }
        console.log('histogram', tempBuffer2.join(' '));
      }
    }
    gl.disable(WebGL2RenderingContext.BLEND);
  }
}
