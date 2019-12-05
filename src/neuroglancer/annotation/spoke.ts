/**
 * @file Support for rendering line strip annotations.
 */

import {Annotation, AnnotationReference, AnnotationType, Spoke} from 'neuroglancer/annotation';
import {getSelectedAssocatedSegment, MultiStepAnnotationTool, Spoof} from 'neuroglancer/annotation/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {MouseSelectionState} from 'neuroglancer/layer';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {registerTool} from 'neuroglancer/ui/tool';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';

const ANNOTATE_SPOKE_TOOL_ID = 'annotateSpoke';

class RenderHelper extends AnnotationRenderHelper {
  draw(context: AnnotationRenderContext) {
    context;
  }
}

registerAnnotationTypeRenderHandler(AnnotationType.SPOKE, {
  bytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: Spoke, index: number) => {
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

export class PlaceSpokeTool extends MultiStepAnnotationTool {
  annotationType: AnnotationType.SPOKE;
  toolset = PlaceLineTool;
  initMouseState: MouseSelectionState;
  initPos: any;
  childTool: PlaceLineTool;
  wheeled = false;
  lastMouseState?: MouseSelectionState;
  lastPos?: any;
  initSegments?: Uint64[]|null;
  lastSegments: any;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
    this.childTool = new this.toolset(layer, {...options, parent: this});
    this.toolbox = options.toolbox;
    if (this.toolbox && this.toolbox.querySelector('.neuroglancer-spoke-wheeled')) {
      this.wheeled = true;
    }
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = <Spoke>super.getInitialAnnotation(mouseState, annotationLayer);
    result.connected = true;
    result.wheeled = this.wheeled;
    result.type = this.annotationType;
    return result;
  }

  trigger(mouseState: MouseSelectionState, parentReference?: AnnotationReference) {
    if (mouseState.active) {
      if (this.inProgressAnnotation === undefined || !this.inProgressAnnotation.reference.value) {
        this.initMouseState = <MouseSelectionState>{...mouseState};
        this.initPos = mouseState.position.slice();
        if (this.annotationLayer) {
          this.initSegments = getSelectedAssocatedSegment(this.annotationLayer);
        }
        super.trigger(mouseState, parentReference);
        this.assignToParent(this.inProgressAnnotation!.reference, parentReference);
      } else {
        super.trigger(mouseState, parentReference);
        // Start new annotation automatically at source point
        const mouse = <MouseSelectionState>{...this.initMouseState, position: this.initPos};
        const segments = this.initSegments;
        if (this.wheeled && this.lastMouseState && this.lastPos) {
          // Connect the current completed and last completed points
          const intermediate = <Spoof>{
            mouse: <MouseSelectionState>{...this.lastMouseState, position: this.lastPos},
            segments: this.lastSegments
          };
          this.appendNewChildAnnotation(
              this.inProgressAnnotation.reference!, mouseState, intermediate);
          super.trigger(mouseState, parentReference);
        }
        this.appendNewChildAnnotation(
            this.inProgressAnnotation.reference!, mouseState, <Spoof>{mouse, segments});
        this.lastMouseState = <MouseSelectionState>{...mouseState};
        this.lastPos = mouseState.position.slice();
        if (this.annotationLayer) {
          this.lastSegments = getSelectedAssocatedSegment(this.annotationLayer);
        }
      }
    }
  }

  get description() {
    return `annotate spoke ${this.wheeled ? '(wheel)' : ''}`;
  }

  toJSON() {
    return ANNOTATE_SPOKE_TOOL_ID;
  }
}
PlaceSpokeTool.prototype.annotationType = AnnotationType.SPOKE;

registerTool(
    ANNOTATE_SPOKE_TOOL_ID,
    (layer, options) => new PlaceSpokeTool(<UserLayerWithAnnotations>layer, options));
