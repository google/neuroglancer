/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
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

import {AnnotationRenderContext, AnnotationRenderHelper, getAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {AnnotationType, getAnnotationTypeHandler} from 'neuroglancer/annotation';
import {CircleShader} from 'neuroglancer/webgl/circles';
import {emitterDependentShaderGetter, ShaderBuilder} from 'neuroglancer/webgl/shader';
import {Point} from 'neuroglancer/annotation/index';
import {StringMemoize} from 'neuroglancer/util/memoize';

let EnvMemoize = new StringMemoize();

export let Env = {
    getUser: function () {
        return EnvMemoize.getUncounted(
            'user', () => prompt('User:') || '');
    }
};

export interface DVIDPointAnnotation extends Point {
  properties?: {[key:string]: any};
}

function getRenderingAttribute(annotation: Point): number {
  let {properties} = <DVIDPointAnnotation>annotation;
  if (properties) {
    if (properties.checked) {
      if (properties.checked === '1') {
        return 1;
      }
    }
    if (properties.type) {
      if (properties.type === 'Merge') {
        return 2;
      } else if (properties.type === 'Split') {
        return 3;
      }
    }
  }

  return 0;
}

const numDVIDPointAnnotationElements = 4;

function DVIDPointAnnotationSerializer(buffer: ArrayBuffer, offset: number, numAnnotations: number) {
  const coordinates = new Float32Array(buffer, offset, numAnnotations * numDVIDPointAnnotationElements);
  return (annotation: Point, index: number) => {
    const {point} = annotation;
    const coordinateOffset = index * numDVIDPointAnnotationElements;
    coordinates[coordinateOffset] = point[0];
    coordinates[coordinateOffset + 1] = point[1];
    coordinates[coordinateOffset + 2] = point[2];
    coordinates[coordinateOffset + 3] = getRenderingAttribute(annotation);
  };
}

export function updateAnnotationTypeHandler() {
  let typeHandler = getAnnotationTypeHandler(AnnotationType.POINT);
  typeHandler.serializer = DVIDPointAnnotationSerializer;
  typeHandler.serializedBytes = numDVIDPointAnnotationElements * 4;
}

function setFillColor(builder: ShaderBuilder) {
  let s = `
vec3 rgb2hsv(vec3 c)
{
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c)
{
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void setFillColor() {
  if (vRenderingAttribute >= 1 && vRenderingAttribute <= 3) {
    vec3 hsv = rgb2hsv(vColor.rgb);
    if (vRenderingAttribute == 1) {
      vColor.rgb = vec3(0.0, 1.0, 0.0);
    } else if (vRenderingAttribute == 2) {
      vColor.rgb = hsv2rgb(vec3(mod(hsv.x - 0.1, 1.0), 1.0, hsv.z));
    } else if (vRenderingAttribute == 3) {
      vColor.rgb = hsv2rgb(vec3(mod(hsv.x - 0.3, 1.0), 1.0, hsv.z));
    }
  }
}
`;
  builder.addVertexCode(s);
  return `setFillColor()`;
}

function getBorderColor(builder: ShaderBuilder) {
  let s = `
vec4 getBorderColor() {
  vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
  if (vRenderingAttribute == 2) {
    borderColor = vec4(1.0, 0.0, 0.0, 1.0);
  } else if (vRenderingAttribute == 3) {
    borderColor = vec4(0.0, 0.0, 1.0, 1.0);
  } else if (vRenderingAttribute == 1) {
    borderColor = vec4(0.0, 1.0, 0.0, 1.0);
  }
  return borderColor;
}
  `;

  builder.addFragmentCode(s);
  return `getBorderColor()`;
}

class DVIDRenderHelper extends AnnotationRenderHelper {
  private circleShader = this.registerDisposer(new CircleShader(this.gl));
  private shaderGetter =
      emitterDependentShaderGetter(this, this.gl, (builder: ShaderBuilder) => this.defineShader(builder));

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.circleShader.defineShader(builder, /*crossSectionFade=*/this.targetIsSliceView);
    // Position of point in camera coordinates.
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.addAttribute('highp float', 'aRenderingAttribute');
    builder.addVarying('int', 'vRenderingAttribute', 'flat');
    builder.setVertexMain(`
emitCircle(uProjection * vec4(aVertexPosition, 1.0));
${this.setPartIndex(builder)};
vRenderingAttribute = int(aRenderingAttribute);
${setFillColor(builder)};
`);
    builder.setFragmentMain(`
vec4 borderColor = ${getBorderColor(builder)};
emitAnnotation(getCircleColor(vColor, borderColor));
`);
  }

  draw(context: AnnotationRenderContext) {
    const shader = this.shaderGetter(context.renderContext.emitter);
    this.enable(shader, context, () => {
      const {gl} = this;
      const aVertexPosition = shader.attribute('aVertexPosition');
      const aRenderingAttribute = shader.attribute('aRenderingAttribute');
      context.buffer.bindToVertexAttrib(
          aVertexPosition, /*components=*/3, /*attributeType=*/WebGL2RenderingContext.FLOAT,
          /*normalized=*/false,
          /*stride=*/numDVIDPointAnnotationElements * 4, /*offset=*/context.bufferOffset);
      context.buffer.bindToVertexAttrib(
        aRenderingAttribute, /*components=*/1, /*attributeType=*/WebGL2RenderingContext.FLOAT,
        /*normalized=*/false,
        /*stride=*/numDVIDPointAnnotationElements * 4, /*offset=*/context.bufferOffset + 3 * 4);
      gl.vertexAttribDivisor(aVertexPosition, 1);
      gl.vertexAttribDivisor(aRenderingAttribute, 1);
      this.circleShader.draw(
          shader, context.renderContext,
          {interiorRadiusInPixels: 6, borderWidthInPixels: 2, featherWidthInPixels: 1},
          context.count);
      gl.vertexAttribDivisor(aRenderingAttribute, 0);
      gl.vertexAttribDivisor(aVertexPosition, 0);
      gl.disableVertexAttribArray(aVertexPosition);
      gl.disableVertexAttribArray(aRenderingAttribute);
    });
  }
}

export function updateRenderHelper() {
  let renderHandler = getAnnotationTypeRenderHandler(AnnotationType.POINT);
  renderHandler.bytes = numDVIDPointAnnotationElements * 4;
  renderHandler.serializer = DVIDPointAnnotationSerializer;
  renderHandler.sliceViewRenderHelper = DVIDRenderHelper;
  renderHandler.perspectiveViewRenderHelper = DVIDRenderHelper;
}
