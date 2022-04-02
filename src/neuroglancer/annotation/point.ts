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
 * @file Support for rendering point annotations.
 */

import {AnnotationType, Point} from 'neuroglancer/annotation';
import {AnnotationRenderContext, AnnotationRenderHelper, AnnotationShaderGetter, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {defineCircleShader, drawCircles, initializeCircleShader} from 'neuroglancer/webgl/circles';
import {defineLineShader, drawLines, initializeLineShader} from 'neuroglancer/webgl/lines';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {defineVectorArrayVertexShaderInput} from 'neuroglancer/webgl/shader_lib';
import {defineVertexId, VertexIdHelper} from 'neuroglancer/webgl/vertex_id';

class RenderHelper extends AnnotationRenderHelper {
  private defineShaderCommon(builder: ShaderBuilder) {
    const {rank} = this;
    // Position of point in model coordinates.
    defineVectorArrayVertexShaderInput(
        builder, 'float', WebGL2RenderingContext.FLOAT, /*normalized=*/ false, 'VertexPosition',
        rank);
    builder.addVarying('highp vec4', 'vBorderColor');
    builder.addVertexCode(`
float ng_markerDiameter;
float ng_markerBorderWidth;
void setPointMarkerSize(float size) {
  ng_markerDiameter = size;
}
void setPointMarkerBorderWidth(float size) {
  ng_markerBorderWidth = size;
}
void setPointMarkerColor(vec4 color) {
  vColor = color;
}
void setPointMarkerBorderColor(vec4 color) {
  vBorderColor = color;
}
`);
    builder.addVertexMain(`
ng_markerDiameter = 5.0;
ng_markerBorderWidth = 1.0;
vBorderColor = vec4(0.0, 0.0, 0.0, 1.0);
float modelPosition[${rank}] = getVertexPosition0();
float clipCoefficient = getSubspaceClipCoefficient(modelPosition);
if (clipCoefficient == 0.0) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
${this.invokeUserMain}
vColor.a *= clipCoefficient;
vBorderColor.a *= clipCoefficient;
${this.setPartIndex(builder)};
`);
  }

  private shaderGetter3d =
      this.getDependentShader('annotation/point:3d', (builder: ShaderBuilder) => {
        defineVertexId(builder);
        defineCircleShader(builder, /*crossSectionFade=*/ this.targetIsSliceView);
        this.defineShaderCommon(builder);
        builder.addVertexMain(`
emitCircle(uModelViewProjection *
           vec4(projectModelVectorToSubspace(modelPosition), 1.0), ng_markerDiameter, ng_markerBorderWidth);
`);
        builder.setFragmentMain(`
vec4 color = getCircleColor(vColor, vBorderColor);
emitAnnotation(color);
`);
      });

  private makeShaderGetter2d = (extraDim: number) =>
      this.getDependentShader(`annotation/point:2d:${extraDim}`, (builder: ShaderBuilder) => {
        defineVertexId(builder);
        defineLineShader(builder, /*rounded=*/ true);
        this.defineShaderCommon(builder);
        builder.addVertexMain(`
vec3 subspacePositionA = projectModelVectorToSubspace(modelPosition);
vec3 subspacePositionB = subspacePositionA;
vec4 baseProjection = uModelViewProjection * vec4(subspacePositionA, 1.0);
vec4 zCoeffs = uModelViewProjection[${extraDim}];
float minZ = 1e30;
float maxZ = -1e30;
for (int i = 0; i < 3; ++i) {
  // Want: baseProjection[i] + z * zCoeffs[i] = -2.0 * (baseProjection.w - z * zCoeffs.w)
  //  i.e. baseProjection[i] + 2.0 * baseProjection.w < -z * (2.0 * zCoeffs.w + zCoeffs[i])
  //  i.e. baseProjection[i] + 2.0 * baseProjection.w < -z * k1
  float k1 = 2.0 * zCoeffs.w + zCoeffs[i];
  float q1 = -(baseProjection[i] + 2.0 * baseProjection.w) / k1;
  if (k1 != 0.0) {
    minZ = min(minZ, q1);
    maxZ = max(maxZ, q1);
  }
  // Want: baseProjection[i] + z * zCoeffs[i] = 2.0 * (baseProjection.w + z * zCoeffs.w)
  //  i.e. baseProjection[i] - 2.0 * baseProjection.w > z * (2.0 * zCoeffs.w - zCoeffs[i])
  //  i.e. baseProjection[i] - 2.0 * baseProjection.w > z * k2
  float k2 = 2.0 * zCoeffs.w - zCoeffs[i];
  float q2 = (baseProjection[i] - 2.0 * baseProjection.w) / k2;
  if (k2 != 0.0) {
    minZ = min(minZ, q2);
    maxZ = max(maxZ, q2);
  }
}
if (minZ > maxZ) minZ = maxZ = 0.0;
subspacePositionA[${extraDim}] = minZ;
subspacePositionB[${extraDim}] = maxZ;
emitLine(uModelViewProjection, subspacePositionA, subspacePositionB, ng_markerDiameter, ng_markerBorderWidth);
`);
        builder.setFragmentMain(`
vec4 color = getRoundedLineColor(vColor, vBorderColor);
emitAnnotation(vec4(color.rgb, color.a * ${this.getCrossSectionFadeFactor()}));
`);
      });

  private shaderGetter2d = this.makeShaderGetter2d(2);

  // TODO(jbms): This rendering for the 1d case is not correct except for cross-section/orthographic
  // projection views where the "z" dimension is orthogonal to the single annotation chunk
  // dimension.
  private shaderGetter1d = this.makeShaderGetter2d(1);

  private vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

  enable(
      shaderGetter: AnnotationShaderGetter, context: AnnotationRenderContext,
      callback: (shader: ShaderProgram) => void) {
    super.enable(shaderGetter, context, shader => {
      const binder = shader.vertexShaderInputBinders['VertexPosition'];
      binder.enable(1);
      this.gl.bindBuffer(WebGL2RenderingContext.ARRAY_BUFFER, context.buffer.buffer);
      binder.bind(this.geometryDataStride, context.bufferOffset);
      const {vertexIdHelper} = this;
      vertexIdHelper.enable();
      callback(shader);
      vertexIdHelper.disable();
      binder.disable();
    });
  }

  draw(context: AnnotationRenderContext) {
    const {numChunkDisplayDims} = context.chunkDisplayTransform;
    switch (numChunkDisplayDims) {
      case 3:
        this.enable(this.shaderGetter3d, context, shader => {
          initializeCircleShader(
              shader, context.renderContext.projectionParameters, {featherWidthInPixels: 1});
          drawCircles(shader.gl, 1, context.count);
        });
        break;
      case 2:
      case 1:
        this.enable(
            numChunkDisplayDims === 2 ? this.shaderGetter2d : this.shaderGetter1d, context,
            shader => {
              initializeLineShader(
                  shader, context.renderContext.projectionParameters, /*featherWidthInPixels=*/ 1);
              drawLines(shader.gl, 1, context.count);
            });
        break;
    }
  }
}

registerAnnotationTypeRenderHandler<Point>(AnnotationType.POINT, {
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  defineShaderNoOpSetters(builder) {
    builder.addVertexCode(`
void setPointMarkerSize(float size) {}
void setPointMarkerBorderWidth(float size) {}
void setPointMarkerColor(vec4 color) {}
void setPointMarkerBorderColor(vec4 color) {}
`);
  },
  pickIdsPerInstance: 1,
  snapPosition(position, data, offset) {
    position.set(new Float32Array(data, offset, position.length));
  },
  getRepresentativePoint(out, ann) {
    out.set(ann.point);
  },
  updateViaRepresentativePoint(oldAnnotation, position) {
    return {...oldAnnotation, point: new Float32Array(position)};
  }
});
