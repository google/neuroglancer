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

import {Annotation, AnnotationReference, AnnotationType, Point} from 'neuroglancer/annotation';
import {getSelectedAssocatedSegment, PlaceAnnotationTool} from 'neuroglancer/annotation/annotation';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {MouseSelectionState} from 'neuroglancer/layer';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {registerTool} from 'neuroglancer/ui/tool';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {CircleShader} from 'neuroglancer/webgl/circles';
import {emitterDependentShaderGetter, ShaderBuilder} from 'neuroglancer/webgl/shader';

const ANNOTATE_POINT_TOOL_ID = 'annotatePoint';

class RenderHelper extends AnnotationRenderHelper {
  private circleShader = this.registerDisposer(new CircleShader(this.gl));
  private shaderGetter = emitterDependentShaderGetter(
      this, this.gl, (builder: ShaderBuilder) => this.defineShader(builder));

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.circleShader.defineShader(builder, /*crossSectionFade=*/this.targetIsSliceView);
    // Position of point in camera coordinates.
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.setVertexMain(`
emitCircle(uProjection * vec4(aVertexPosition, 1.0));
${this.setPartIndex(builder)};
`);
    builder.setFragmentMain(`
vec4 borderColor = vec4(0.0, 0.0, 0.0, 1.0);
emitAnnotation(getCircleColor(vColor, borderColor));
`);
  }

  draw(context: AnnotationRenderContext) {
    const shader = this.shaderGetter(context.renderContext.emitter);
    this.enable(shader, context, () => {
      const {gl} = this;
      const aVertexPosition = shader.attribute('aVertexPosition');
      context.buffer.bindToVertexAttrib(
          aVertexPosition, /*components=*/3, /*attributeType=*/WebGL2RenderingContext.FLOAT,
          /*normalized=*/false,
          /*stride=*/0, /*offset=*/context.bufferOffset);
      gl.vertexAttribDivisor(aVertexPosition, 1);
      this.circleShader.draw(
          shader, context.renderContext,
          {interiorRadiusInPixels: 6, borderWidthInPixels: 2, featherWidthInPixels: 1},
          context.count);
      gl.vertexAttribDivisor(aVertexPosition, 0);
      gl.disableVertexAttribArray(aVertexPosition);
    });
  }
}

registerAnnotationTypeRenderHandler(AnnotationType.POINT, {
  bytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: Point, index: number) => {
      const {point} = annotation;
      const coordinateOffset = index * 3;
      coordinates[coordinateOffset] = point[0];
      coordinates[coordinateOffset + 1] = point[1];
      coordinates[coordinateOffset + 2] = point[2];
    };
  },
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  pickIdsPerInstance: 1,
  snapPosition: (position: vec3, objectToData, data, offset) => {
    vec3.transformMat4(position, <vec3>new Float32Array(data, offset, 3), objectToData);
  },
  getRepresentativePoint: (objectToData, ann) => {
    let repPoint = vec3.create();
    vec3.transformMat4(repPoint, ann.point, objectToData);
    return repPoint;
  },
  updateViaRepresentativePoint: (oldAnnotation: Point, position: vec3, dataToObject: mat4) => {
    let annotation = {...oldAnnotation};
    annotation.point = vec3.transformMat4(vec3.create(), position, dataToObject);
    // annotation.id = '';
    return annotation;
  }
});
export class PlacePointTool extends PlaceAnnotationTool {
  annotationType: AnnotationType.POINT;
  constructor(layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
  }

  trigger(mouseState: MouseSelectionState, parentReference?: AnnotationReference) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const annotation: Annotation = {
        id: '',
        description: '',
        segments: getSelectedAssocatedSegment(annotationLayer),
        point:
            vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject),
        type: AnnotationType.POINT,
      };
      const reference = annotationLayer.source.add(annotation, /*commit=*/true, parentReference);
      this.layer.selectedAnnotation.value = {id: reference.id};
      this.assignToParent(reference, parentReference);
      reference.dispose();
    }
  }

  get description() {
    return `annotate point`;
  }

  toJSON() {
    return ANNOTATE_POINT_TOOL_ID;
  }
}
PlacePointTool.prototype.annotationType = AnnotationType.POINT;

registerTool(
    ANNOTATE_POINT_TOOL_ID,
    (layer, options) => new PlacePointTool(<UserLayerWithAnnotations>layer, options));
