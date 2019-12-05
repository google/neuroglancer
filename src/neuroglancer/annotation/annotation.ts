import {Annotation, AnnotationReference, AnnotationSource, AnnotationType, AxisAlignedBoundingBox, Collection, Line, LocalAnnotationSource} from 'neuroglancer/annotation';
import {PlaceBoundingBoxTool} from 'neuroglancer/annotation/bounding_box';
import {PlaceSphereTool} from 'neuroglancer/annotation/ellipsoid';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {PlaceLineStripTool} from 'neuroglancer/annotation/line_strip';
import {PlacePointTool} from 'neuroglancer/annotation/point';
import {PlaceSpokeTool} from 'neuroglancer/annotation/spoke';
import {MouseSelectionState} from 'neuroglancer/layer';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {Tool} from 'neuroglancer/ui/tool';
import {vec3} from 'neuroglancer/util/geom';
import {verifyObjectProperty, verifyOptionalString} from 'neuroglancer/util/json';
import {Uint64} from 'neuroglancer/util/uint64';

export function getMousePositionInAnnotationCoordinates(
    mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState) {
  return vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject);
}

export function getSelectedAssocatedSegment(annotationLayer: AnnotationLayerState) {
  let segments: Uint64[]|undefined;
  const segmentationState = annotationLayer.segmentationState.value;
  if (segmentationState != null) {
    if (segmentationState.segmentSelectionState.hasSelectedSegment) {
      segments = [segmentationState.segmentSelectionState.selectedSegment.clone()];
    }
  }
  return segments;
}

export abstract class PlaceAnnotationTool extends Tool {
  group: string;
  annotationDescription: string|undefined;
  annotationType: AnnotationType.POINT|AnnotationType.LINE|
      AnnotationType.AXIS_ALIGNED_BOUNDING_BOX|AnnotationType.ELLIPSOID|
      AnnotationType.COLLECTION|AnnotationType.LINE_STRIP|AnnotationType.SPOKE;
  parentTool?: MultiStepAnnotationTool;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super();
    if (layer.annotationLayerState === undefined) {
      throw new Error(`Invalid layer for annotation tool.`);
    }
    this.parentTool = options ? options.parent : undefined;
    this.annotationDescription = verifyObjectProperty(options, 'description', verifyOptionalString);
  }

  get annotationLayer() {
    return this.layer.annotationLayerState.value;
  }

  protected assignToParent(reference: AnnotationReference, parentReference?: AnnotationReference) {
    if (!parentReference) {
      return;
    }
    const parent = <Collection>parentReference.value;
    const annotation = reference.value;
    if (!annotation || !parent) {
      throw `Invalid reference for assignment: ${!annotation ? 'Child' : 'Parent'} has no value`;
    }
    parent.entries.push(annotation.id);
  }

  complete() {
    // True if an annotation has been created via this method
    return false;
  }
}

export abstract class TwoStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;

  abstract getInitialAnnotation(
      mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation;
  abstract getUpdatedAnnotation(
      oldAnnotation: Annotation, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation;

  private isOrphanTool(): boolean {
    const parent = this.parentTool;
    if (parent && parent.inProgressAnnotation) {
      return parent.childTool !== this;
    }
    // Can't be orphan if never had a parent
    return false;
  }

  trigger(mouseState: MouseSelectionState, parentReference?: AnnotationReference, spoof?: Spoof) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined || !mouseState.active) {
      // Not yet ready.
      return;
    }

    const updatePointB = () => {
      const state = this.inProgressAnnotation!;
      if (!this.isOrphanTool()) {
        const reference = state.reference;
        const newAnnotation =
            this.getUpdatedAnnotation(reference.value!, mouseState, annotationLayer);
        if (spoof && spoof.segments) {
          newAnnotation.segments = [...(newAnnotation.segments || []), ...spoof.segments];
        }
        state.annotationLayer.source.update(reference, newAnnotation);
        this.layer.selectedAnnotation.value = {id: reference.id};
      } else {
        state.disposer();
      }
    };

    if (!this.inProgressAnnotation || !this.inProgressAnnotation.reference.value) {
      const mouse = (spoof ? spoof.mouse : null) || mouseState;
      const annotation = this.getInitialAnnotation(mouse, annotationLayer);
      if (spoof && spoof.segments) {
        annotation.segments = spoof.segments;
      }
      const reference = annotationLayer.source.add(annotation, /*commit=*/false, parentReference);
      this.layer.selectedAnnotation.value = {id: reference.id};
      const disposer = () => {
        mouseDisposer();
        reference.dispose();
      };
      this.inProgressAnnotation = {
        annotationLayer,
        reference,
        disposer,
      };
      const mouseDisposer = mouseState.changed.add(updatePointB);
      this.assignToParent(reference, parentReference);
    } else {
      updatePointB();
      if (this.inProgressAnnotation) {
        this.inProgressAnnotation.annotationLayer.source.commit(
            this.inProgressAnnotation.reference);
        this.inProgressAnnotation.disposer();
        this.inProgressAnnotation = undefined;
        this.layer.selectedAnnotation.changed.dispatch();
      }
    }
  }

  disposed() {
    this.deactivate();
    super.disposed();
  }

  deactivate() {
    if (this.inProgressAnnotation !== undefined) {
      this.inProgressAnnotation.annotationLayer.source.delete(this.inProgressAnnotation.reference);
      this.inProgressAnnotation.disposer();
      this.inProgressAnnotation = undefined;
    }
  }
}

export abstract class PlaceTwoCornerAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.LINE|AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return <AxisAlignedBoundingBox|Line>{
      id: '',
      type: this.annotationType,
      description: '',
      pointA: point,
      pointB: point,
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: AxisAlignedBoundingBox|Line, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return {...oldAnnotation, pointB: point};
  }
}

export type Spoof = {
  mouse?: MouseSelectionState,
  segments?: Uint64[]
};
export type SubAnnotationTool = PlacePointTool|PlaceBoundingBoxTool|PlaceLineTool|PlaceSphereTool|
    PlaceLineStripTool|PlaceSpokeTool;
type DiscreteAnnotationTool =
    typeof PlacePointTool|typeof PlaceBoundingBoxTool|typeof PlaceLineTool|typeof PlaceSphereTool;
type ContinuousAnnotationTool = typeof PlaceLineStripTool|typeof PlaceSpokeTool;
export type AnnotationTool = DiscreteAnnotationTool|ContinuousAnnotationTool;

export abstract class MultiStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;
  annotationType: AnnotationType.COLLECTION|AnnotationType.LINE_STRIP|AnnotationType.SPOKE;
  toolset?: AnnotationTool;
  toolbox: HTMLDivElement;
  childTool: SubAnnotationTool|undefined;
  initialOptions: any;
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super(layer, options);
    this.toolbox = options.toolbox;
    this.initialOptions = options;
  }

  private updateLast() {
    // Reserves the last two annotations created in a collection. In the case that the user
    // completes an annotation via double click, these two annotations are deleted because they
    // would be created by the the doubleclick action.
    const inprogress = this.inProgressAnnotation;
    if (inprogress && inprogress.reference.value) {
      const oldAnnotation = <Collection>inprogress.reference.value;
      const lastB = oldAnnotation.lastA;
      const lastA = this.getChildRef();
      const newAnnotation = {...oldAnnotation, lastA, lastB};
      inprogress.annotationLayer.source.update(inprogress.reference, newAnnotation);
    }
  }

  private getChildRef() {
    // Helper for updateLast, gets the reference of the last annotation added to the collection
    const inprogress = this.inProgressAnnotation;
    if (this.childTool && inprogress && inprogress.reference.value) {
      const {entries} = <Collection>inprogress.reference.value;
      return inprogress.annotationLayer.source.getReference(entries[entries.length - 1]);
    }
    return;
  }

  private reInitChildTool() {
    // This function prevents tool.refcount < 0, by reintializing the tool when the child annotation
    // is completed as a result of the main tool being complete. Tool.refcount is always decremented
    // when dispose is called, which is done on completion
    if (!this.toolset) {
      return;
    }
    this.childTool = new this.toolset(this.layer, {...this.initialOptions, parent: this});
  }

  protected appendNewChildAnnotation(
      oldAnnotationRef: AnnotationReference, mouseState: MouseSelectionState, spoof?: Spoof) {
    this.childTool!.trigger(mouseState, oldAnnotationRef, spoof);
    this.updateLast();
  }

  protected getInitialAnnotation(
      mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation {
    const coll = <Collection>{
      id: '',
      type: this.annotationType,
      description: '',
      entries: [],
      segments: [],
      connected: false,
      source:
          vec3.transformMat4(vec3.create(), mouseState.position, annotationLayer.globalToObject),
      entry: () => {},
      segmentSet: () => {},
      childrenVisible: new TrackableBoolean(true, true)
    };
    coll.entry = (index: number) =>
        (<LocalAnnotationSource>annotationLayer.source).get(coll.entries[index]);
    coll.segmentSet = () => {
      coll.segments = [];
      coll.entries.forEach((ref, index) => {
        ref;
        const child = <Annotation>coll.entry(index);
        if (coll.segments && child && child.segments) {
          coll.segments = [...coll.segments!, ...child.segments];
        }
      });
      if (coll.segments) {
        coll.segments =
            [...new Set(coll.segments.map((e) => e.toString()))].map((s) => Uint64.parseString(s));
      }
    };
    return coll;
  }

  protected safeDelete(target?: AnnotationReference) {
    if (!this.inProgressAnnotation || !target) {
      return;
    }
    const source = <AnnotationSource>this.inProgressAnnotation.annotationLayer.source;
    if (target) {
      if (source.isPending(target.id)) {
        target.dispose();
      } else {
        source.delete(target);
      }
    }
  }

  trigger(mouseState: MouseSelectionState, parentReference?: AnnotationReference) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined || !this.childTool) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      if (this.inProgressAnnotation === undefined || !this.inProgressAnnotation.reference.value) {
        const annotation = this.getInitialAnnotation(mouseState, annotationLayer);
        const reference = annotationLayer.source.add(annotation, /*commit=*/false, parentReference);
        this.layer.selectedAnnotation.value = {id: reference.id};
        this.childTool.trigger(mouseState, /*child=*/reference);
        this.updateLast();
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
        const mouseDisposer = () => {};
      } else {
        this.childTool.trigger(mouseState, this.inProgressAnnotation.reference);
        this.updateLast();
      }
    }
  }

  complete(shortcut?: boolean, endChild?: boolean): boolean {
    if (!this.inProgressAnnotation) {
      // To complete a collection, it must have at least one completed annotation. An annotation is
      // complete if it is not inProgress/pending or it is a point.
      // If the child tool is a collection, it is completed first. Once the child collection is
      // complete or cannot be completed (in which case it is ignored), then the collection can be
      // completed.
      return false;
    }
    const isChildToolSet = !!this.childTool;
    const value = <Collection>this.inProgressAnnotation.reference.value;
    const hasChildren = value && value.entries.length;

    if (!isChildToolSet && !hasChildren) {
      return false;
    }

    if (shortcut) {
      const {lastA, lastB} = value;
      this.safeDelete(lastA);
      this.safeDelete(lastB);
    }
    const nonPointTool = <MultiStepAnnotationTool|TwoStepAnnotationTool>this.childTool;
    const childInProgress = nonPointTool ? nonPointTool.inProgressAnnotation : undefined;
    const childCount = value.entries.length;
    let isChildInProgressCollection = false;
    let success = false;
    let collection: Collection;
    const completeChild = (): boolean => {
      const successful = (<SubAnnotationTool>this.childTool).complete(shortcut);
      if (endChild && this.childTool) {
        this.childTool.dispose();
        this.childTool = undefined;
        this.layer.tool.changed.dispatch();
        this.layer.selectedAnnotation.changed.dispatch();

        let key = this.toolbox.querySelector('.neuroglancer-child-tool');
        if (key) {
          key.classList.remove('neuroglancer-child-tool');
        }
      }
      return successful;
    };

    if (childInProgress) {
      collection = <Collection>childInProgress.reference.value;
      isChildInProgressCollection = !!(collection && collection.entries);
      if (isChildInProgressCollection) {
        if (collection.entries.length > 1) {
          success = completeChild();
          if (success && !endChild) {
            return success;
          }
        }
      }
    }

    // success is true if, child annotation is a completed collection
    if (((!childInProgress || success) && childCount === 1) || childCount > 1) {
      if (this.childTool) {
        this.childTool.dispose();
        if (!endChild) {
          this.reInitChildTool();
        }
      }

      const {reference, annotationLayer} = this.inProgressAnnotation;
      const annotation = <Collection>reference.value;
      // assign segments
      annotation.segmentSet();
      annotationLayer.source.commit(reference);
      StatusMessage.showTemporaryMessage(
          `${annotation.parentId ? 'Child a' : 'A'}nnotation ${annotation.id} complete.`);
      this.inProgressAnnotation.disposer();
      this.inProgressAnnotation = undefined;
      this.layer.selectedAnnotation.changed.dispatch();
      return true;
    }
    StatusMessage.showTemporaryMessage(`No annotation has been made.`, 3000);
    return false;
  }

  dispose() {
    if (this.childTool) {
      this.childTool.dispose();
    }
    if (this.inProgressAnnotation && this.annotationLayer) {
      // completely delete the annotation
      const annotation_ref = this.inProgressAnnotation.reference;
      this.annotationLayer.source.delete(annotation_ref, true);
      this.inProgressAnnotation.disposer();
    }
    super.dispose();
  }

  abstract get description(): string;

  abstract toJSON(): string;
}
