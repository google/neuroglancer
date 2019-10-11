/**
 * @license
 * Copyright 2018 Google Inc.
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
 * @file Support for rendering ellipsoid annotations.
 */

import {AnnotationType, Ellipsoid} from 'neuroglancer/annotation';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {PerspectiveViewRenderContext} from 'neuroglancer/perspective_view/render_layer';
import {SliceViewPanelRenderContext} from 'neuroglancer/sliceview/renderlayer';
import {mat3, mat4, vec3} from 'neuroglancer/util/geom';
import {computeCenterOrientEllipseDebug, computeCrossSectionEllipseDebug, glsl_computeCenterOrientEllipse, glsl_computeCrossSectionEllipse} from 'neuroglancer/webgl/ellipse';
import {QuadRenderHelper} from 'neuroglancer/webgl/quad';
import {emitterDependentShaderGetter, ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {defineVectorArrayVertexShaderInput} from 'neuroglancer/webgl/shader_lib';
import {SphereRenderHelper} from 'neuroglancer/webgl/spheres';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';

const tempMat4 = mat4.create();

const DEBUG = false;

abstract class RenderHelper extends AnnotationRenderHelper {
  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    const {rank} = this;
    defineVectorArrayVertexShaderInput(builder, 'float', 'CenterAndRadii', rank, 2);
    builder.addVertexCode(`
struct SubspaceParams {
  highp vec3 subspaceCenter;
  highp vec3 subspaceRadii;
  highp float clipCoefficient;
  bool cull;
};
SubspaceParams getSubspaceParams() {
  SubspaceParams params;
  highp float modelCenter[${rank}] = getCenterAndRadii0();
  highp float modelRadii[${rank}] = getCenterAndRadii1();
  float radiusAdjustment = 1.0;
  float clipCoefficient = 1.0;
  for (int i = 0; i < ${rank}; ++i) {
    float r = modelRadii[i];
    float c = modelCenter[i];
    float x = uModelClipBounds[i];
    float clipRadius = uModelClipBounds[i + ${rank}];
    if (r != 0.0 && clipRadius != 0.0) {
      float d = c - x;
      d = d * d;
      radiusAdjustment -= d / (r * r);
    }
    float e = abs(x - clamp(x, c - r, c + r)) * clipRadius;
    clipCoefficient *= max(0.0, 1.0 - e);
  }
  radiusAdjustment = sqrt(max(0.0, radiusAdjustment));
  params.subspaceCenter = projectModelVectorToSubspace(modelCenter);
  params.subspaceRadii = projectModelVectorToSubspace(modelRadii) * radiusAdjustment;
  params.clipCoefficient = clipCoefficient;
  params.cull = clipCoefficient == 0.0 || radiusAdjustment == 0.0;
  return params;
}
`);
  }

  enable(shader: ShaderProgram, context: AnnotationRenderContext, callback: () => void) {
    super.enable(shader, context, () => {
      const binder = shader.vertexShaderInputBinders['CenterAndRadii'];
      binder.enable(1);
      binder.bind(
          context.buffer.buffer!, WebGL2RenderingContext.FLOAT, /*normalized=*/ false,
          /*stride=*/ 0, context.bufferOffset);
      callback();
      binder.disable();
    });
  }
}

/**
 * Render an ellipsoid as a transformed triangulated sphere.
 */
class PerspectiveRenderHelper extends RenderHelper {
  private sphereRenderHelper = this.registerDisposer(new SphereRenderHelper(this.gl, 10, 10));

  private shaderGetter = emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
    this.defineShader(builder);
    this.sphereRenderHelper.defineShader(builder);
    builder.addUniform('highp vec4', 'uLightDirection');
    builder.addUniform('highp mat4', 'uNormalTransform');
    builder.addVarying('highp float', 'vClipCoefficient');
    builder.setVertexMain(`
SubspaceParams params = getSubspaceParams();
if (params.cull) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
vClipCoefficient = params.clipCoefficient;
emitSphere(uModelViewProjection, uNormalTransform, params.subspaceCenter, params.subspaceRadii, uLightDirection);
${this.setPartIndex(builder)};
`);
    builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb * vLightingFactor, vColor.a * vClipCoefficient));
`);
  });

  private tempLightVec = new Float32Array(4);

  draw(context: AnnotationRenderContext&{renderContext: PerspectiveViewRenderContext}) {
    const shader = this.shaderGetter(context.renderContext.emitter);
    this.enable(shader, context, () => {
      const {gl} = shader;
      let lightVec = <vec3>this.tempLightVec;
      let {lightDirection, ambientLighting, directionalLighting} = context.renderContext;
      vec3.scale(lightVec, lightDirection, directionalLighting);
      lightVec[3] = ambientLighting;
      gl.uniform4fv(shader.uniform('uLightDirection'), lightVec);
      gl.uniformMatrix4fv(
          shader.uniform('uNormalTransform'), /*transpose=*/ false,
          mat4.transpose(mat4.create(), context.renderSubspaceInvModelMatrix));
      this.sphereRenderHelper.draw(shader, context.count);
    });
  }
}

/**
 * Render a cross section of an ellipsoid.
 *
 * This is done using the following steps:
 *
 * Vertex shader:
 *
 * 1. We transform the ellipsoid parameters to the cross section coordinate frame (with the z
 *    axis corresponding to the plane normal).
 *
 * 2. We then compute the quadratic form parameters of the ellipse corresponding to the intersection
 *    of the ellipsoid with the `z=0` plane.
 *
 * 3. We convert the quadratic form parameterization into the center-orient parameterization.
 *
 * 4. The vertex shader emits the 4 vertices of the bounding box of the ellipse, equal to:
 *
 *      `k +/- a*u1 +/- b*u2`,
 *
 *    where `k` is the center of the ellipse, `u1` and `u2` are the major and minor axis directions
 *    respectively, and `a` and `b` are the semi-major and semi-minor axis lengths, respectively.
 *    These four vertices are used to draw a quad (two triangles).
 *
 * Fragment shader:
 *
 * 5. The fragment shader discards fragments outside the bounds of the ellipse.
 */
class SliceViewRenderHelper extends RenderHelper {
  private quadRenderHelper = this.registerDisposer(new QuadRenderHelper(this.gl, 1));
  private squareCornersBuffer =
      getSquareCornersBuffer(this.gl, -1, -1, 1, 1, /*minorTiles=*/ 1, /*majorTiles=*/ 1);

  private shaderGetter = emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => {
    this.defineShader(builder);
    builder.addUniform('highp mat4', 'uViewportToObject');
    builder.addUniform('highp mat4', 'uObjectToViewport');
    builder.addUniform('highp mat4', 'uViewportToDevice');
    builder.addAttribute('highp vec2', 'aCornerOffset');
    builder.addVarying('highp vec2', 'vCircleCoord');
    builder.addVarying('highp float', 'vClipCoefficient');
    builder.addVertexCode(glsl_computeCrossSectionEllipse);
    builder.addVertexCode(glsl_computeCenterOrientEllipse);
    builder.setVertexMain(`
SubspaceParams params = getSubspaceParams();
if (params.cull) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
vClipCoefficient = params.clipCoefficient;
mat3 Aobject = mat3(0.0);
for (int i = 0; i < 3; ++i) {
  float r = max(params.subspaceRadii[i], 1e-3);
  Aobject[i][i] = 1.0 / (r * r);
}
mat3 RviewportToObject = mat3(uViewportToObject);
mat3 Aviewport = transpose(RviewportToObject) * Aobject * RviewportToObject;
vec3 cViewport = (uObjectToViewport * vec4(params.subspaceCenter, 1.0)).xyz;
EllipseQuadraticForm quadraticForm = computeCrossSectionEllipse(Aviewport, cViewport);
vec2 u1, u2;
float a, b;
CenterOrientEllipse centerOrient = computeCenterOrientEllipse(quadraticForm);
vec2 viewportCorner = centerOrient.k +
  centerOrient.u1 * aCornerOffset.x * centerOrient.a +
  centerOrient.u2 * aCornerOffset.y * centerOrient.b;
if (centerOrient.valid) {
  gl_Position = uViewportToDevice * vec4(viewportCorner, 0.0, 1.0);
} else {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
}
vCircleCoord = aCornerOffset;
${this.setPartIndex(builder)};
`);
    builder.setFragmentMain(`
if (dot(vCircleCoord, vCircleCoord) > 1.0) {
  discard;
}
emitAnnotation(vec4(vColor.rgb, 0.5 * vClipCoefficient));
`);
  });

  draw(context: AnnotationRenderContext&{renderContext: SliceViewPanelRenderContext}) {
    const shader = this.shaderGetter(context.renderContext.emitter);
    this.enable(shader, context, () => {
      const {gl} = shader;
      const aCornerOffset = shader.attribute('aCornerOffset');
      this.squareCornersBuffer.bindToVertexAttrib(aCornerOffset, /*components=*/ 2);
      const viewportToObject = mat4.multiply(
          tempMat4, context.renderSubspaceInvModelMatrix,
          context.renderContext.sliceView.invViewMatrix);
      gl.uniformMatrix4fv(
          shader.uniform('uViewportToObject'), /*transpose=*/ false, viewportToObject);
      gl.uniformMatrix4fv(
          shader.uniform('uViewportToDevice'), /*transpose=*/ false,
          context.renderContext.sliceView.projectionMat);
      const objectToViewport = tempMat4;
      mat4.invert(objectToViewport, viewportToObject);
      gl.uniformMatrix4fv(
          shader.uniform('uObjectToViewport'), /*transpose=*/ false, objectToViewport);
      this.quadRenderHelper.draw(gl, context.count);
      shader.gl.disableVertexAttribArray(aCornerOffset);


      if (DEBUG) {
        const center = vec3.fromValues(3406.98779296875, 3234.910400390625, 4045);
        const radii = vec3.fromValues(10, 10, 10);

        const Aobject = mat3.create();
        Aobject[0] = 1 / (radii[0] * radii[0]);
        Aobject[4] = 1 / (radii[1] * radii[1]);
        Aobject[8] = 1 / (radii[2] * radii[2]);

        const RviewportToObject = mat3.fromMat4(mat3.create(), viewportToObject);
        const Aviewport =
            mat3.multiply(mat3.create(), mat3.transpose(mat3.create(), RviewportToObject), Aobject);
        mat3.multiply(Aviewport, Aviewport, RviewportToObject);
        const cViewport = vec3.transformMat4(vec3.create(), center, objectToViewport);

        console.log('Aviewport', Aviewport);
        console.log('cViewport', cViewport);

        const p = computeCrossSectionEllipseDebug(Aviewport, cViewport);
        const centerOrient = computeCenterOrientEllipseDebug(p);
        console.log(p);
        console.log(centerOrient);
      }
    });
  }
}

registerAnnotationTypeRenderHandler<Ellipsoid>(AnnotationType.ELLIPSOID, {
  sliceViewRenderHelper: SliceViewRenderHelper,
  perspectiveViewRenderHelper: PerspectiveRenderHelper,
  pickIdsPerInstance: 1,
  snapPosition: (/*position, annotation, partIndex*/) => {
    // FIXME: snap to nearest point on ellipsoid surface
  },
  getRepresentativePoint(position, ann) {
    position.set(ann.center);
  },
  updateViaRepresentativePoint(oldAnnotation: Ellipsoid, position: Float32Array) {
    return {...oldAnnotation, center: new Float32Array(position)};
  }
});
