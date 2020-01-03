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
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {CircleShader} from 'neuroglancer/webgl/circles';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';
import {defineVectorArrayVertexShaderInput} from 'neuroglancer/webgl/shader_lib';

class RenderHelper extends AnnotationRenderHelper {
  private circleShader = this.registerDisposer(new CircleShader(this.gl));
  private shaderGetter = this.getDependentShader('annotation/point', (builder: ShaderBuilder) => {
    const {rank} = this;
    this.circleShader.defineShader(builder, /*crossSectionFade=*/ this.targetIsSliceView);
    // Position of point in model coordinates.
    defineVectorArrayVertexShaderInput(
        builder, 'float', WebGL2RenderingContext.FLOAT, /*normalized=*/ false, 'VertexPosition',
        rank);
    builder.addVarying('highp float', 'vClipCoefficient');
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
    builder.setVertexMain(`
float modelPosition[${rank}] = getVertexPosition0();
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
if (vClipCoefficient == 0.0) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
ng_markerDiameter = 5.0;
ng_markerBorderWidth = 1.0;
vBorderColor = vec4(0.0, 0.0, 0.0, 1.0);
${this.invokeUserMain}
emitCircle(uModelViewProjection *
           vec4(projectModelVectorToSubspace(modelPosition), 1.0), ng_markerDiameter, ng_markerBorderWidth);
${this.setPartIndex(builder)};
`);
    builder.setFragmentMain(`
vec4 color = getCircleColor(vColor, vBorderColor);
color.a *= vClipCoefficient;
emitAnnotation(color);
`);
  });

  draw(context: AnnotationRenderContext) {
    this.enable(this.shaderGetter, context, shader => {
      const binder = shader.vertexShaderInputBinders['VertexPosition'];
      binder.enable(1);
      this.gl.bindBuffer(WebGL2RenderingContext.ARRAY_BUFFER, context.buffer.buffer);
      binder.bind(this.serializedBytesPerAnnotation, context.bufferOffset);
      this.circleShader.draw(
          shader, context.renderContext.projectionParameters, {featherWidthInPixels: 1},
          context.count);
      binder.disable();
    });
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
