/**
 * @file Support for rendering collections.
 */

import {AnnotationType, Collection} from 'neuroglancer/annotation';
import {MultiStepAnnotationTool} from 'neuroglancer/annotation/annotation';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {registerTool} from 'neuroglancer/ui/tool';
import {mat4, vec3} from 'neuroglancer/util/geom';

const ANNOTATE_COLLECTION_TOOL_ID = 'annotateCollection';

class RenderHelper extends AnnotationRenderHelper {
  draw(context: AnnotationRenderContext) {
    context;
  }
}

registerAnnotationTypeRenderHandler(AnnotationType.COLLECTION, {
  bytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: Collection, index: number) => {
      const {source} = annotation;
      const coordinateOffset = index * 3;
      coordinates[coordinateOffset] = source[0];
      coordinates[coordinateOffset + 1] = source[1];
      coordinates[coordinateOffset + 2] = source[2];
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
    vec3.transformMat4(repPoint, ann.source, objectToData);
    return repPoint;
  },
  updateViaRepresentativePoint: (oldAnnotation, position: vec3, dataToObject: mat4) => {
    let annotation = {...oldAnnotation};
    annotation.source = vec3.transformMat4(vec3.create(), position, dataToObject);
    return annotation;
  }
});

export class PlaceCollectionTool extends MultiStepAnnotationTool {
  annotationType: AnnotationType.COLLECTION;

  get description() {
    return `annotate collection: ${
        this.childTool ? this.childTool.description : 'no child tool selected'}`;
  }

  toJSON() {
    return ANNOTATE_COLLECTION_TOOL_ID;
  }
}
PlaceCollectionTool.prototype.annotationType = AnnotationType.COLLECTION;

registerTool(
    ANNOTATE_COLLECTION_TOOL_ID,
    (layer, options) => new PlaceCollectionTool(<UserLayerWithAnnotations>layer, options));
