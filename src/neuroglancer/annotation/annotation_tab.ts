import {AnnotationDetailsTab} from 'neuroglancer/annotation/annotation_details_tab';
import {AnnotationLayerView} from 'neuroglancer/annotation/annotation_layer_view';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {SelectedAnnotationState, UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {StackView, Tab} from 'neuroglancer/widget/tab_view';

export class AnnotationTab extends Tab {
  private stack = this.registerDisposer(
      new StackView<AnnotationLayerState, AnnotationLayerView>(annotationLayerState => {
        return new AnnotationLayerView(
            this.layer, this.state.addRef(), annotationLayerState.addRef(), this.voxelSize.addRef(),
            this.setSpatialCoordinates);
      }, this.visibility));
  private detailsTab = this.registerDisposer(
      new AnnotationDetailsTab(this.state, this.voxelSize.addRef(), this.setSpatialCoordinates));
  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    const {element} = this;
    element.classList.add('neuroglancer-annotations-tab');
    this.stack.element.classList.add('neuroglancer-annotations-stack');
    element.appendChild(this.stack.element);
    element.appendChild(this.detailsTab.element);
    const updateDetailsVisibility = () => {
      this.detailsTab.visibility.value = this.state.validValue !== undefined && this.visible ?
          WatchableVisibilityPriority.VISIBLE :
          WatchableVisibilityPriority.IGNORED;
    };
    this.registerDisposer(this.state.changed.add(updateDetailsVisibility));
    this.registerDisposer(this.visibility.changed.add(updateDetailsVisibility));
    const setAnnotationLayerView = () => {
      this.stack.selected = this.state.annotationLayerState.value;
    };
    this.registerDisposer(this.state.annotationLayerState.changed.add(setAnnotationLayerView));
    setAnnotationLayerView();
  }
}
