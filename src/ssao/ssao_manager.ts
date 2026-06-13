/**
 * @license
 * Copyright 2026 Google Inc.
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

import {
  defineGTAOShader,
  defineBlurShader,
  defineSSAOCompositeShader,
} from "#src/ssao/shaders.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import {
  FramebufferConfiguration,
  OffscreenCopyHelper,
  TextureBuffer,
} from "#src/webgl/offscreen.js";

export class SSAOManager extends RefCounted {
  private ssaoFboA: FramebufferConfiguration<TextureBuffer> | undefined;
  private ssaoFboB: FramebufferConfiguration<TextureBuffer> | undefined;
  private gtaoCopyHelper: OffscreenCopyHelper | undefined;
  private blurCopyHelper: OffscreenCopyHelper | undefined;
  private ssaoCompositeHelper: OffscreenCopyHelper | undefined;
  private invProjectionMat = mat4.create();

  constructor(private gl: GL) {
    super();
  }

  private ensureResources() {
    if (this.ssaoFboA !== undefined) return;
    const { gl } = this;
    this.ssaoFboA = this.registerDisposer(
      new FramebufferConfiguration(gl, {
        colorBuffers: [
          new TextureBuffer(
            gl,
            WebGL2RenderingContext.R8,
            WebGL2RenderingContext.RED,
            WebGL2RenderingContext.UNSIGNED_BYTE,
          ),
        ],
      }),
    );
    this.ssaoFboB = this.registerDisposer(
      new FramebufferConfiguration(gl, {
        colorBuffers: [
          new TextureBuffer(
            gl,
            WebGL2RenderingContext.R8,
            WebGL2RenderingContext.RED,
            WebGL2RenderingContext.UNSIGNED_BYTE,
          ),
        ],
      }),
    );
    this.gtaoCopyHelper = this.registerDisposer(
      OffscreenCopyHelper.get(gl, defineGTAOShader, 2),
    );
    this.blurCopyHelper = this.registerDisposer(
      OffscreenCopyHelper.get(gl, defineBlurShader, 2),
    );
    this.ssaoCompositeHelper = this.registerDisposer(
      OffscreenCopyHelper.get(gl, defineSSAOCompositeShader, 3),
    );
  }

  render(
    width: number,
    height: number,
    depthTexture: WebGLTexture | null,
    normalTexture: WebGLTexture | null,
    projectionMat: mat4,
    radius: number,
  ) {
    this.ensureResources();
    const { gl, invProjectionMat } = this;
    // projectionMat is invertible for any non-degenerate viewport; the only
    // singular case (near == far) would already have broken opaque rendering.
    mat4.invert(invProjectionMat, projectionMat);

    // GTAO pass
    this.ssaoFboA!.bind(width, height);
    const gtaoShader = this.gtaoCopyHelper!.shader;
    gtaoShader.bind();
    gl.uniformMatrix4fv(
      gtaoShader.uniform("uProjection"),
      false,
      projectionMat,
    );
    gl.uniformMatrix4fv(
      gtaoShader.uniform("uInvProjection"),
      false,
      invProjectionMat,
    );
    gl.uniform1f(gtaoShader.uniform("uRadius"), radius);
    gl.uniform2f(gtaoShader.uniform("uResolution"), width, height);
    this.gtaoCopyHelper!.draw(depthTexture, normalTexture);

    // Blur horizontal
    this.ssaoFboB!.bind(width, height);
    const blurShader = this.blurCopyHelper!.shader;
    blurShader.bind();
    gl.uniform2f(blurShader.uniform("uDirection"), 1.0, 0.0);
    this.blurCopyHelper!.draw(
      this.ssaoFboA!.colorBuffers[0].texture,
      depthTexture,
    );

    // Blur vertical
    this.ssaoFboA!.bind(width, height);
    blurShader.bind();
    gl.uniform2f(blurShader.uniform("uDirection"), 0.0, 1.0);
    this.blurCopyHelper!.draw(
      this.ssaoFboB!.colorBuffers[0].texture,
      depthTexture,
    );
  }

  drawComposite(
    colorTexture: WebGLTexture | null,
    normalTexture: WebGLTexture | null,
    intensity: number,
  ) {
    this.ensureResources();
    const { gl } = this;
    const shader = this.ssaoCompositeHelper!.shader;
    shader.bind();
    gl.uniform1f(shader.uniform("uIntensity"), intensity);
    this.ssaoCompositeHelper!.draw(
      colorTexture,
      this.ssaoFboA!.colorBuffers[0].texture,
      normalTexture,
    );
  }
}
