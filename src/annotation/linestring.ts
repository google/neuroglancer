/**
 * @file Support for rendering line string annotations.
 */

import type { LineString } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type {
  AnnotationRenderContext,
  AnnotationShaderGetter,
} from "#src/annotation/type_handler.js";
import {
  AnnotationRenderHelper,
  registerAnnotationTypeRenderHandler,
} from "#src/annotation/type_handler.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import { projectPointToLineSegment, vec3 } from "#src/util/geom.js";
import {
  defineCircleShader,
  drawCircles,
  initializeCircleShader,
  VERTICES_PER_CIRCLE,
} from "#src/webgl/circles.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
} from "#src/webgl/lines.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { defineVectorArrayVertexShaderInput } from "#src/webgl/shader_lib.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

const FULL_OBJECT_PICK_OFFSET = 0;
const ENDPOINTS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;

function defineNoOpControlPointMarkerSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setControlPointMarkerSize(float startSize, float endSize) {}
void setControlPointMarkerBorderWidth(float startSize, float endSize) {}
void setControlPointMarkerColor(vec4 startColor, vec4 endColor) {}
void setControlPointMarkerBorderColor(vec4 startColor, vec4 endColor) {}
`);
}

function defineNoOpLineSegmentSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setLineSegmentWidth(float width) {}
void setLineSegmentColor(vec4 startColor, vec4 endColor) {}
`);
}

class RenderHelper extends AnnotationRenderHelper {
  defineShader(builder: ShaderBuilder) {
    defineVertexId(builder);
    // Position of endpoints in model coordinates.
    const {rank} = this;
    defineVectorArrayVertexShaderInput(
        builder, 'float', WebGL2RenderingContext.FLOAT, /*normalized=*/ false, 'VertexPosition',
        rank, 2);
  }

  private vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));

  private edgeShaderGetter =
      this.getDependentShader('annotation/linestring/edge', (builder: ShaderBuilder) => {
        const {rank} = this;
        this.defineShader(builder);
        defineLineShader(builder);
        builder.addVarying(`highp float[${rank}]`, 'vModelPosition');
        builder.addVertexCode(`
float ng_LineWidth;
`);
        defineNoOpControlPointMarkerSetters(builder);
        builder.addVertexCode(`
void setLineSegmentWidth(float width) {
  ng_LineWidth = width;
}
void setLineSegmentColor(vec4 startColor, vec4 endColor) {
  vColor = mix(startColor, endColor, getLineEndpointCoefficient());
}
`);
        builder.setVertexMain(`
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
for (int i = 0; i < ${rank}; ++i) {
  vModelPosition[i] = mix(modelPositionA[i], modelPositionB[i], getLineEndpointCoefficient());
}
ng_LineWidth = 1.0;
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
emitLine(uModelViewProjection * vec4(projectModelVectorToSubspace(modelPositionA), 1.0),
         uModelViewProjection * vec4(projectModelVectorToSubspace(modelPositionB), 1.0),
         ng_LineWidth);
${this.setPartIndex(builder)};
`);
        builder.setFragmentMain(`
float clipCoefficient = getSubspaceClipCoefficient(vModelPosition);
emitAnnotation(vec4(vColor.rgb, vColor.a * getLineAlpha() *
                                ${this.getCrossSectionFadeFactor()} *
                                clipCoefficient));
`);
      });

  private endpointShaderGetter =
      this.getDependentShader('annotation/linestring/endpoint', (builder: ShaderBuilder) => {
        const {rank} = this;
        this.defineShader(builder);
        defineCircleShader(builder, this.targetIsSliceView);
        builder.addVarying('highp float', 'vClipCoefficient');
        builder.addVarying('highp vec4', 'vBorderColor');
        defineNoOpLineSegmentSetters(builder);
        builder.addVertexCode(`
float ng_markerDiameter;
float ng_markerBorderWidth;
int getEndpointIndex() {
  return gl_VertexID / ${VERTICES_PER_CIRCLE};
}
void setControlPointMarkerSize(float startSize, float endSize) {
  ng_markerDiameter = mix(startSize, endSize, float(getEndpointIndex()));
}
void setControlPointMarkerBorderWidth(float startSize, float endSize) {
  ng_markerBorderWidth = mix(startSize, endSize, float(getEndpointIndex()));
}
void setControlPointMarkerColor(vec4 startColor, vec4 endColor) {
  vColor = mix(startColor, endColor, float(getEndpointIndex()));
}
void setControlPointMarkerBorderColor(vec4 startColor, vec4 endColor) {
  vBorderColor = mix(startColor, endColor, float(getEndpointIndex()));
}
`);

        builder.setVertexMain(`
float modelPosition[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
for (int i = 0; i < ${rank}; ++i) {
  modelPosition[i] = mix(modelPosition[i], modelPositionB[i], float(getEndpointIndex()));
}
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
vBorderColor = vec4(0.0, 0.0, 0.0, 1.0);
ng_markerDiameter = 5.0;
ng_markerBorderWidth = 1.0;
${this.invokeUserMain}
emitCircle(uModelViewProjection * vec4(projectModelVectorToSubspace(modelPosition), 1.0), ng_markerDiameter, ng_markerBorderWidth);
${this.setPartIndex(builder, 'uint(getEndpointIndex()) + 1u')};
`);
        builder.setFragmentMain(`
vec4 color = getCircleColor(vColor, vBorderColor);
color.a *= vClipCoefficient;
emitAnnotation(color);
`);
      });

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

  drawEdges(context: AnnotationRenderContext) {
    this.enable(this.edgeShaderGetter, context, shader => {
      initializeLineShader(
          shader, context.renderContext.projectionParameters, /*featherWidthInPixels=*/ 1.0);
      drawLines(shader.gl, 1, context.count);
    });
  }

  drawEndpoints(context: AnnotationRenderContext) {
    this.enable(this.endpointShaderGetter, context, shader => {
      initializeCircleShader(shader, context.renderContext.projectionParameters, {featherWidthInPixels: 0.5});
      drawCircles(shader.gl, 1, context.count);
    });
  }

  draw(context: AnnotationRenderContext) {
    const basePickId = context.basePickId;

    this.drawEdges(context);
    context.basePickId += context.count;
    this.drawEndpoints(context);

    context.basePickId = basePickId; // Just in case the original value is needed downstream.
  }
}

function snapPositionToLine(position: Float32Array, endpoints: Float32Array) {
  const rank = position.length;
  projectPointToLineSegment(
      position, endpoints.subarray(0, rank), endpoints.subarray(rank), position);
}

function snapPositionToEndpoint(
    position: Float32Array, endpoints: Float32Array, endpointIndex: number) {
  const rank = position.length;
  const startOffset = rank * endpointIndex;
  for (let i = 0; i < rank; ++i) {
    position[i] = endpoints[startOffset + i];
  }
}

registerAnnotationTypeRenderHandler<LineString>(AnnotationType.LINE_STRING, {
  bytes: (annotation: LineString) => annotation.points.length * 3 * 4,
  sliceViewRenderHelper: RenderHelper,
  perspectiveViewRenderHelper: RenderHelper,
  defineShaderNoOpSetters(builder) {
    defineNoOpControlPointMarkerSetters(builder);
    defineNoOpLineSegmentSetters(builder);
  },
  staticPickIdsPerInstance: null,
  pickIdsPerInstance: (annotations:LineString[]) => annotations.map(a => a.points.length * 2),
  assignPickingInformation(mouseState:MouseSelectionState, pickIds:number[], pickedOffset:number) {
    const pickIdCountLines = pickIds.reduce((a, b) => a + (b / 2) / 2, 0);
    const typeIndex = pickedOffset >= pickIdCountLines ? pickedOffset - pickIdCountLines - 1 : pickedOffset;
    let instanceIndex = 0;
    let linePickIdSum = 0;
    let pointPickIdSum = 0;
    let partIndex = 0;

    // Given the pick ID and the annotations being rendered, determine which piece of geometry is being interacted with.
    // Points are rendered after line segments, so they will have higher pick ID's; a modulo must be performed on point
    // ID's using the number of line segments to calculate which control point is being picked.
    for (const instancePickIds of pickIds) {
      const instanceLinePickIds = (instancePickIds / 2) / 2;
      const instancePointPickIds = instanceLinePickIds + 1;
      
      if (pickedOffset > pickIdCountLines) { // Picking an endpoint.
        const pickedPointInstance = pickedOffset - pickIdCountLines;
        const pickedPointOffset = pickedOffset - pickIdCountLines - 1;

        if (pointPickIdSum + instancePointPickIds > pickedPointInstance) {
          partIndex = pickedPointOffset - pointPickIdSum + instanceLinePickIds;
          break;
        }
      }
      else { // Picking a line.
        if (linePickIdSum + instanceLinePickIds > pickedOffset) {
          partIndex = typeIndex - linePickIdSum;
          break;
        }
      }

      linePickIdSum += instanceLinePickIds;
      pointPickIdSum += instancePointPickIds - 1;
      ++instanceIndex;
    }

    mouseState.pickedOffset = partIndex;
    mouseState.pickedAnnotationIndex = instanceIndex;
  },
  snapPosition(position, data, offset, partIndex) {
    const rank = position.length;
    const endpoints = new Float32Array(data, offset, rank * 2);
    if (partIndex === FULL_OBJECT_PICK_OFFSET) {
      snapPositionToLine(position, endpoints);
    } else {
      snapPositionToEndpoint(position, endpoints, partIndex - ENDPOINTS_PICK_OFFSET);
    }
  },
  getRepresentativePoint(out, ann, partIndex) {
    if (partIndex >= (ann.points.length) / 2) { // An endpoint was selected; modulo away the line segments.
      partIndex = partIndex - ((ann.points.length) / 2);
    }

    out.set((ann.points[partIndex * 2]));
  },
  updateViaRepresentativePoint(oldAnnotation, position, partIndex) {
    const baseLine = {...oldAnnotation};
    const pointIndicesToMove = [];
    let pointOffset = null;

    if (partIndex < (baseLine.points.length - 1) / 2) { // Moving an edge.
      const pointIndex = partIndex * 2;
      pointOffset = vec3.subtract(vec3.create(), [...position], [...baseLine.points[pointIndex]]);

      // Move both ends of the segment, plus the point that begins the subsequent segment.
      pointIndicesToMove.push(pointIndex, pointIndex + 1, pointIndex + 2);

      if (pointIndex != 0) { // Move the point that the preceeding segment connects to, if the segment being moved is not the first one.
        pointIndicesToMove.push(pointIndex - 1);
      }
      if (pointIndex == baseLine.points.length - 4) { // Special case for the last segment of a line, which has a terminal degenerate line.
        pointIndicesToMove.push(pointIndex + 3);
      }
    }
    else { // Moving a point.
      const pointIndex = (partIndex - ((baseLine.points.length) / 2)) * 2;
      pointOffset = vec3.subtract(vec3.create(), [...position], [...baseLine.points[pointIndex]]);

      // Move the point itself.
      pointIndicesToMove.push(pointIndex);

      // If it's not the first point, also move the point before it which the previous segment connects to.
      if (pointIndex != 0) {
        pointIndicesToMove.push(pointIndex - 1)
      }

      // If it's not the last point, move the point after it which the subsequent point connects to.
      if (pointIndex == baseLine.points.length - 2) {
        pointIndicesToMove.push(pointIndex + 1)
      }
    }

    // Move all points involved in either the point or segment shift.
    for (const pointIndex of pointIndicesToMove) {
      baseLine.points[pointIndex] = vec3.add(vec3.create(), [...baseLine.points[pointIndex]], pointOffset);
    }

    return baseLine;
  }
});
