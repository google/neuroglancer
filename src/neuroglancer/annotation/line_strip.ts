/**
 * @file Support for rendering line strip annotations.
 */

import {Annotation, AnnotationReference, AnnotationType, LineStrip} from 'neuroglancer/annotation';
import {MultiStepAnnotationTool, getSelectedAssocatedSegment, Spoof} from 'neuroglancer/annotation/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {AnnotationRenderContext, AnnotationRenderHelper, registerAnnotationTypeRenderHandler} from 'neuroglancer/annotation/type_handler';
import {MouseSelectionState} from 'neuroglancer/layer';
import {StatusMessage} from 'neuroglancer/status';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {registerTool} from 'neuroglancer/ui/tool';
import {mat4, vec3} from 'neuroglancer/util/geom';
import { Uint64 } from 'neuroglancer/util/uint64';

const ANNOTATE_LINE_STRIP_TOOL_ID = 'annotateLineStrip';

class RenderHelper extends AnnotationRenderHelper {
  draw(context: AnnotationRenderContext) {
    context;
  }
}

registerAnnotationTypeRenderHandler(AnnotationType.LINE_STRIP, {
  bytes: 3 * 4,
  serializer: (buffer: ArrayBuffer, offset: number, numAnnotations: number) => {
    const coordinates = new Float32Array(buffer, offset, numAnnotations * 3);
    return (annotation: LineStrip, index: number) => {
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

export class PlaceLineStripTool extends MultiStepAnnotationTool {
  annotationType: AnnotationType.LINE_STRIP;
  toolset = PlaceLineTool;
  looped = false;
  initMouseState: MouseSelectionState;
  initPos: any;
  childTool: PlaceLineTool;
  initSegments?: Uint64[]|null;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
    this.childTool = new this.toolset(layer, {...options, parent: this});
    this.toolbox = options.toolbox;
    if (this.toolbox && this.toolbox.querySelector('.neuroglancer-linestrip-looped')) {
      this.looped = true;
    }
  }

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = <LineStrip>super.getInitialAnnotation(mouseState, annotationLayer);
    result.connected = true;
    result.looped = this.looped;
    result.type = this.annotationType;
    return result;
  }

  trigger(mouseState: MouseSelectionState, parentReference?: AnnotationReference) {
    if (mouseState.active) {
      if (this.inProgressAnnotation === undefined || !this.inProgressAnnotation.reference.value) {
        this.initMouseState = <MouseSelectionState>{...mouseState};
        this.initPos = mouseState.position.slice();
        super.trigger(mouseState, parentReference);
        if (this.annotationLayer) {
          this.initSegments = getSelectedAssocatedSegment(this.annotationLayer);
        }
        this.assignToParent(this.inProgressAnnotation!.reference, parentReference);
      } else {
        super.trigger(mouseState, parentReference);
        // Start new annotation automatically
        this.appendNewChildAnnotation(this.inProgressAnnotation.reference!, mouseState);
      }
    }
  }

  complete(shortcut?: boolean): boolean {
    if (!this.inProgressAnnotation) {
      return false;
    }
    const value = <LineStrip>this.inProgressAnnotation.reference.value;
    const innerEntries = value.entries;
    if (shortcut) {
      const {lastA, lastB} = value;
      this.safeDelete(lastA);
      this.safeDelete(lastB);
    }
    if (innerEntries.length > 1) {
      if (this.looped) {
        const mouse = <MouseSelectionState>{...this.initMouseState, position: this.initPos};
        const initial = <Spoof>{
          mouse, segments: this.initSegments
        };
        value.looped = true;
        this.childTool.trigger(mouse, this.inProgressAnnotation.reference, initial);
      }
      return super.complete();
    }
    StatusMessage.showTemporaryMessage(`No annotation has been made.`, 3000);
    return false;
  }

  get description() {
    return `annotate line strip ${this.looped ? '(loop)' : ''}`;
  }

  toJSON() {
    return ANNOTATE_LINE_STRIP_TOOL_ID;
  }
}
PlaceLineStripTool.prototype.annotationType = AnnotationType.LINE_STRIP;

registerTool(
    ANNOTATE_LINE_STRIP_TOOL_ID,
    (layer, options) => new PlaceLineStripTool(<UserLayerWithAnnotations>layer, options));
