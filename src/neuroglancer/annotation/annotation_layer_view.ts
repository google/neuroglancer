import {Annotation, AnnotationCT, AnnotationSource, AnnotationTag, AnnotationType, Collection, Ellipsoid, getAnnotationTypeHandler, Line, LineStrip, LocalAnnotationSource, makeAnnotationId, Point, Spoke} from 'neuroglancer/annotation';
import {AnnotationTool, MultiStepAnnotationTool, PlaceAnnotationTool, SubAnnotationTool} from 'neuroglancer/annotation/annotation';
import {PlaceBoundingBoxTool} from 'neuroglancer/annotation/bounding_box';
import {PlaceCollectionTool} from 'neuroglancer/annotation/collection';
import {PlaceSphereTool} from 'neuroglancer/annotation/ellipsoid';
import {AnnotationLayerState} from 'neuroglancer/annotation/frontend';
import {PlaceLineTool} from 'neuroglancer/annotation/line';
import {PlaceLineStripTool} from 'neuroglancer/annotation/line_strip';
import {PlacePointTool} from 'neuroglancer/annotation/point';
import {PlaceSpokeTool} from 'neuroglancer/annotation/spoke';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {getPositionSummary, SelectedAnnotationState, UserLayerWithAnnotations} from 'neuroglancer/ui/annotations';
import {HidingList} from 'neuroglancer/ui/hiding_list';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {mat4, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {formatIntegerBounds, formatIntegerPoint} from 'neuroglancer/util/spatial_units';
import {ColorWidget} from 'neuroglancer/widget/color';
import {MinimizableGroupWidget} from 'neuroglancer/widget/minimizable_group';
import {RangeWidget} from 'neuroglancer/widget/range';
import {Tab} from 'neuroglancer/widget/tab_view';

const tempVec3 = vec3.create();

const Papa = require('papaparse');

function getCenterPosition(annotation: Annotation, transform: mat4) {
  const center = vec3.create();
  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      vec3.add(center, annotation.pointA, annotation.pointB);
      vec3.scale(center, center, 0.5);
      break;
    case AnnotationType.POINT:
      vec3.copy(center, annotation.point);
      break;
    case AnnotationType.ELLIPSOID:
      vec3.copy(center, annotation.center);
      break;
    case AnnotationType.SPOKE:
    case AnnotationType.LINE_STRIP:
    case AnnotationType.COLLECTION:
      vec3.copy(center, annotation.source);
      break;
  }
  return vec3.transformMat4(center, center, transform);
}

interface StateOverride {
  id?: string;
  multiple?: Set<string>;
}

export class AnnotationLayerView extends Tab {
  private annotationListContainer = document.createElement('ul');
  private annotationListElements = new Map<string, HTMLElement>();
  private annotationHidingList: HidingList;
  private annotationsToAdd: HTMLElement[] = [];
  private annotationTags = new Map<number, HTMLOptionElement>();
  private previousHoverId: string|undefined;
  private previousSelectedId: string|undefined;
  private updated = false;
  private toolbox: HTMLDivElement;
  private buttonMap: any = {};
  groupVisualization = this.registerDisposer(new MinimizableGroupWidget('Visualization'));
  groupAnnotations = this.registerDisposer(new MinimizableGroupWidget('Annotations'));

  private highlightButton(typekey: string, toolset?: AnnotationType) {
    let target = this.toolbox.querySelector(`.${typekey}`);
    if (target) {
      target.classList.remove(typekey);
    }
    // target?.classList.remove(typekey); TODO: Optional Chaining doesn't work w/ Webpack yet
    if (toolset !== undefined) {
      this.buttonMap[toolset].classList.add(typekey);
    }
  }

  private changeTool(toolset?: AnnotationType) {
    const activeToolkey = 'neuroglancer-active-tool';
    const activeChildToolKey = 'neuroglancer-child-tool';
    const currentTool = <PlaceAnnotationTool>this.layer.tool.value;
    const toCollection = toolset === AnnotationType.COLLECTION;
    const setTool = (parent?: MultiStepAnnotationTool) => {
      let tool;
      switch (toolset) {
        case AnnotationType.POINT:
          tool = PlacePointTool;
          break;
        case AnnotationType.LINE:
          tool = PlaceLineTool;
          break;
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
          tool = PlaceBoundingBoxTool;
          break;
        case AnnotationType.ELLIPSOID:
          tool = PlaceSphereTool;
          break;
        case AnnotationType.SPOKE:
          tool = PlaceSpokeTool;
          break;
        case AnnotationType.LINE_STRIP:
          tool = PlaceLineStripTool;
          break;
        case AnnotationType.COLLECTION:
          tool = PlaceCollectionTool;
          break;
      }
      const {toolbox} = this;
      if (parent) {
        if (parent.childTool) {
          parent.childTool.dispose();
        }
        parent.childTool =
            tool ? <SubAnnotationTool>new tool(this.layer, {toolbox, parent}) : undefined;
        parent.toolset = <AnnotationTool>tool;
        this.layer.tool.changed.dispatch();
      } else {
        this.layer.tool.value = tool ? new tool(this.layer, {toolbox}) : undefined;
      }
    };

    if (currentTool && toolset !== undefined) {
      const isCollection = currentTool.annotationType === AnnotationType.COLLECTION;
      const multiTool = <MultiStepAnnotationTool>currentTool;
      if (isCollection && !toCollection) {
        const {childTool} = multiTool;
        if (childTool) {
          if (childTool.annotationType === toolset) {
            toolset = undefined;
          }
          const {COLLECTION, LINE_STRIP, SPOKE} = AnnotationType;
          const multiStepTypes = <(AnnotationType | undefined)[]>[COLLECTION, LINE_STRIP, SPOKE];
          if (multiStepTypes.includes(childTool.annotationType)) {
            multiTool.complete();
          }
        }
        this.highlightButton(activeChildToolKey, toolset);
        setTool(/*parent=*/ multiTool);
      } else if (currentTool.annotationType === toolset) {
        multiTool.complete(false, true);
        toolset = undefined;
        this.highlightButton(activeToolkey);
        this.highlightButton(activeChildToolKey);
        setTool();
      } else {
        if (!isCollection) {
          multiTool.complete();
        }
        this.highlightButton(activeToolkey, toolset);
        setTool();
      }
    } else {
      this.highlightButton(activeToolkey, toolset);
      this.highlightButton(activeChildToolKey);
      setTool();
    }
  }

  private buttonFactory(type: AnnotationType): HTMLButtonElement {
    const button = document.createElement('button');
    const annotationType = getAnnotationTypeHandler(type);
    button.textContent = annotationType.icon;
    button.title = annotationType.title;
    button.addEventListener('click', () => {
      this.changeTool(type);
    });
    this.buttonMap[type] = button;
    return button;
  }

  private annotationToolboxSetup() {
    if (!this.annotationLayer.source.readonly) {
      const annotationTypes =
          <AnnotationType[]>Object.values(AnnotationType).filter(enu => !isNaN(Number(enu)));
      const annotationButtons = annotationTypes.map((value) => this.buttonFactory(value));
      const getActiveToolByType = (toolset?: AnnotationType): PlaceAnnotationTool|undefined => {
        const tool = <MultiStepAnnotationTool>this.layer.tool.value;
        if (tool) {
          const {annotationType, childTool} = tool;
          if (annotationType === toolset) {
            return tool;
          } else if (childTool) {
            const childType = childTool.annotationType;
            if (childType === toolset) {
              return childTool;
            }
          }
        }
        return;
      };
      const activeTool = <MultiStepAnnotationTool>this.layer.tool.value;
      const separator = document.createElement('button');
      separator.disabled = true;
      separator.classList.add('neuroglancer-seperator-element');
      annotationButtons.unshift(...annotationButtons.splice(4, 1));
      annotationButtons.splice(1, 0, separator);

      if (activeTool) {
        activeTool.toolbox = this.toolbox;
        this.highlightButton('neuroglancer-active-tool', activeTool.annotationType);
      }

      this.buttonMap[AnnotationType.LINE_STRIP].addEventListener('contextmenu', () => {
        // Alt Behavior
        const tool = <PlaceLineStripTool>getActiveToolByType(AnnotationType.LINE_STRIP);
        if (tool) {
          this.buttonMap[AnnotationType.LINE_STRIP].classList.toggle(
              'neuroglancer-linestrip-looped');
          tool.looped = !tool.looped;
          this.layer.tool.changed.dispatch();
        }
      });

      this.buttonMap[AnnotationType.SPOKE].addEventListener('contextmenu', () => {
        // Alt Behavior
        const tool = <PlaceSpokeTool>getActiveToolByType(AnnotationType.SPOKE);
        if (tool) {
          this.buttonMap[AnnotationType.SPOKE].classList.toggle('neuroglancer-spoke-wheeled');
          tool.wheeled = !tool.wheeled;
          this.layer.tool.changed.dispatch();
        }
      });

      this.toolbox.append(...annotationButtons);
    }
  }

  private addOpacitySlider() {
    const widget = this.registerDisposer(new RangeWidget(this.annotationLayer.fillOpacity));
    widget.promptElement.textContent = 'Fill opacity';
    this.groupVisualization.appendFixedChild(widget.element);
  }

  private addColorPicker() {
    const colorPicker = this.registerDisposer(new ColorWidget(this.annotationLayer.color));
    colorPicker.element.title = 'Change annotation display color';
    this.toolbox.appendChild(colorPicker.element);
  }

  private bracketShortcutCheckbox() {
    const jumpingShowsSegmentationCheckbox = this.registerDisposer(
        new TrackableBooleanCheckbox(this.annotationLayer.annotationJumpingDisplaysSegmentation));
    const label = document.createElement('label');
    label.textContent = 'Bracket shortcuts show segmentation: ';
    label.appendChild(jumpingShowsSegmentationCheckbox.element);
    this.groupVisualization.appendFixedChild(label);
  }

  private filterAnnotationByTagControl() {
    const annotationTagFilter = document.createElement('select');
    const {source} = this.annotationLayer;
    annotationTagFilter.id = 'annotation-tag-filter';
    annotationTagFilter.add(new Option('View all', '0', true, true));
    const createOptionText = (tag: AnnotationTag) => {
      return '#' + tag.label + ' (id: ' + tag.id.toString() + ')';
    };
    for (const tag of source.getTags()) {
      const option = new Option(createOptionText(tag), tag.id.toString(), false, false);
      this.annotationTags.set(tag.id, option);
      annotationTagFilter.add(option);
    }
    this.registerDisposer(source.tagAdded.add((tag) => {
      const option = new Option(createOptionText(tag), tag.id.toString(), false, false);
      this.annotationTags.set(tag.id, option);
      annotationTagFilter.add(option);
    }));
    this.registerDisposer(source.tagUpdated.add((tag) => {
      const option = this.annotationTags.get(tag.id)!;
      option.text = createOptionText(tag);
      for (const annotation of source) {
        if (this.annotationLayer.source.isAnnotationTaggedWithTag(annotation.id, tag.id)) {
          this.updateAnnotationElement(annotation, false);
        }
      }
    }));
    this.registerDisposer(source.tagDeleted.add((tagId) => {
      annotationTagFilter.removeChild(this.annotationTags.get(tagId)!);
      this.annotationTags.delete(tagId);
      for (const annotation of source) {
        this.updateAnnotationElement(annotation, false);
      }
    }));
    annotationTagFilter.addEventListener('change', () => {
      const tagIdSelected = parseInt(annotationTagFilter.selectedOptions[0].value, 10);
      this.annotationLayer.selectedAnnotationTagId.value = tagIdSelected;
      this.filterAnnotationsByTag(tagIdSelected);
    });
    const label = document.createElement('label');
    label.textContent = 'Filter annotation list by tag: ';
    label.appendChild(annotationTagFilter);
    this.groupVisualization.appendFixedChild(label);
  }

  private csvToolboxSetup() {
    const exportToCSVButton = document.createElement('button');
    const importCSVButton = document.createElement('button');
    const importCSVForm = document.createElement('form');
    const importCSVFileSelect = document.createElement('input');
    exportToCSVButton.id = 'exportToCSVButton';
    exportToCSVButton.textContent = 'Export to CSV';
    exportToCSVButton.addEventListener('click', () => {
      this.exportToCSV();
    });
    importCSVFileSelect.id = 'importCSVFileSelectmultipleKey';
    importCSVFileSelect.type = 'file';
    importCSVFileSelect.accept = 'text/csv';
    importCSVFileSelect.multiple = true;
    importCSVButton.textContent = 'Import from CSV';
    importCSVButton.addEventListener('click', () => {
      importCSVFileSelect.click();
    });
    importCSVForm.appendChild(importCSVFileSelect);
    importCSVFileSelect.addEventListener('change', () => {
      this.importCSV(importCSVFileSelect.files);
      importCSVForm.reset();
    });
    importCSVFileSelect.classList.add('neuroglancer-hidden-button');
    const csvContainer = document.createElement('span');
    csvContainer.append(exportToCSVButton, importCSVButton, importCSVForm);
    this.groupAnnotations.appendFixedChild(csvContainer);
  }

  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>,
      public annotationLayer: Owned<AnnotationLayerState>, public voxelSize: Owned<VoxelSize>,
      public setSpatialCoordinates: (point: vec3) => void) {
    super();
    this.element.classList.add('neuroglancer-annotation-layer-view');
    this.annotationListContainer.classList.add('neuroglancer-annotation-list');
    this.registerDisposer(state);
    this.registerDisposer(voxelSize);
    this.registerDisposer(annotationLayer);
    const {source} = annotationLayer;
    const updateView = () => {
      this.updated = false;
      this.updateView();
    };
    this.registerDisposer(
        source.childAdded.add((annotation) => this.addAnnotationElement(annotation)));
    this.registerDisposer(
        source.childrenAdded.add((annotations) => this.addAnnotationElements(annotations)));
    this.registerDisposer(
        source.childUpdated.add((annotation) => this.updateAnnotationElement(annotation)));
    this.registerDisposer(
        source.childDeleted.add((annotationId) => this.deleteAnnotationElement(annotationId)));
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.registerDisposer(annotationLayer.transform.changed.add(updateView));
    this.updateView();

    this.toolbox = document.createElement('div');
    const {toolbox} = this;
    toolbox.className = 'neuroglancer-annotation-toolbox';

    layer.initializeAnnotationLayerViewTab(this);

    // Visualization Group
    this.addOpacitySlider();
    this.bracketShortcutCheckbox();
    this.filterAnnotationByTagControl();
    // Annotations Group
    this.addColorPicker();
    this.annotationToolboxSetup();
    this.csvToolboxSetup();

    this.groupAnnotations.appendFixedChild(toolbox);
    this.groupAnnotations.appendFlexibleChild(this.annotationListContainer);
    this.element.appendChild(this.groupVisualization.element);
    this.element.appendChild(this.groupAnnotations.element);

    this.annotationListContainer.addEventListener('mouseleave', () => {
      this.annotationLayer.hoverState.value = undefined;
    });
    this.registerDisposer(
        this.annotationLayer.hoverState.changed.add(() => this.updateHoverView()));
    this.registerDisposer(this.state.changed.add(() => this.updateSelectionView()));

    this.annotationListContainer.parentElement!.classList.add(
        'neuroglancer-annotation-hiding-list-parent');
    this.annotationListContainer.classList.add('neuroglancer-annotation-hiding-list-container');
    const scrollArea = document.createElement('div');
    scrollArea.classList.add('neuroglancer-annotation-hiding-list-scrollarea');
    this.annotationListContainer.appendChild(scrollArea);
    const scrollbar = document.createElement('div');
    scrollbar.classList.add('neuroglancer-annotation-hiding-list-scrollbar');
    const scrollbarFiller = document.createElement('div');
    scrollbar.appendChild(scrollbarFiller);
    this.annotationListContainer.appendChild(scrollbar);
    this.annotationHidingList =
        new HidingList(scrollArea, scrollbar, scrollbarFiller, this.groupAnnotations.element);
  }

  private designateFirst() {
    const selectedValue = this.state.value;
    if (!selectedValue || !selectedValue.multiple) {
      return;
    }
    const multiple = [...selectedValue.multiple];
    const first = multiple[0];
    const firstKey = 'neuroglancer-annotation-first';
    if (first) {
      const element = this.annotationListElements.get(first);
      const oldFirst = this.annotationListContainer.querySelector(`.${firstKey}`);
      if (oldFirst) {
        oldFirst.classList.remove('neuroglancer-annotation-first');
      }
      if (element && !element.classList.contains(firstKey)) {
        element.classList.add('neuroglancer-annotation-multiple');
        element.classList.add(firstKey);
      }
    }
  }

  private clearSelectionClass() {
    const {previousSelectedId} = this;
    const selectedKey = 'neuroglancer-annotation-selected';
    if (previousSelectedId !== undefined) {
      const element = this.annotationListElements.get(previousSelectedId);
      if (element !== undefined) {
        element.classList.remove(selectedKey);
      }
      this.previousSelectedId = undefined;
    }
  }

  private clearHoverClass() {
    const {previousHoverId} = this;
    if (previousHoverId !== undefined) {
      const element = this.annotationListElements.get(previousHoverId);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-hover');
      }
      this.previousHoverId = undefined;
    }
  }

  getAnnotationElement(annotationId: string) {
    return this.annotationListElements.get(annotationId);
  }

  private updateSelectionView() {
    const state = this.state.value;
    const {previousSelectedId} = this;
    const editingKey = 'neuroglancer-annotation-editing';
    let newSelectedId: string|undefined;
    let multiple: string[] = [];

    this.designateFirst();
    if (state) {
      newSelectedId = state.id;
      multiple = [...(state.multiple || [])];
    }
    const removedFromMultiple =
        newSelectedId ? !multiple.includes(newSelectedId) && multiple.length : false;
    if (newSelectedId === previousSelectedId || removedFromMultiple) {
      return;
    }
    this.clearSelectionClass();

    if (newSelectedId !== undefined) {
      const element = this.annotationListElements.get(newSelectedId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-selected');
        if (state!.edit === state!.id) {
          element.classList.add(editingKey);
        }

        // TODO: Why? This is a anti user ui pattern
        this.annotationHidingList.scrollTo(element);
      }
    }
    if (!multiple.length) {
      [...this.annotationListElements].forEach((ele) => {
        ele[1].classList.remove(
            'neuroglancer-annotation-multiple', 'neuroglancer-annotation-first');
      });
    }
    this.previousSelectedId = newSelectedId;
  }

  private updateHoverView() {
    const selectedValue = this.annotationLayer.hoverState.value;
    let newHoverId: string|undefined;
    if (selectedValue !== undefined) {
      newHoverId = selectedValue.id;
    }
    const {previousHoverId} = this;
    if (newHoverId === previousHoverId) {
      return;
    }
    this.clearHoverClass();
    if (newHoverId !== undefined) {
      const element = this.annotationListElements.get(newHoverId);
      if (element !== undefined) {
        element.classList.add('neuroglancer-annotation-hover');
      }
    }
    this.previousHoverId = newHoverId;
  }

  private updateView() {
    if (!this.visible) {
      return;
    }
    if (this.updated) {
      return;
    }

    const {annotationLayer, annotationListElements} = this;
    const {source} = annotationLayer;
    this.annotationHidingList.removeAll();
    annotationListElements.clear();

    this.addAnnotationsHelper(source);
  }

  private arrangeAnnotationsToAdd() {
    // Sort this.annotationsToAdd into a tree, then flatten back into a list with the proper order
    // Based on https://stackoverflow.com/a/444303
    class TreeNode {
      element: HTMLElement;
      children: TreeNode[];

      constructor(element: HTMLElement) {
        this.element = element;
        this.children = [];
      }
    }

    const idNodes = new Map<string, TreeNode>();
    for (const element of this.annotationsToAdd) {
      idNodes.set(element.dataset.id!, new TreeNode(element));
    }

    for (const element of this.annotationsToAdd) {
      if (element.dataset.parent) {
        const parentNode = idNodes.get(element.dataset.parent)!;
        const elementNode = idNodes.get(element.dataset.id!)!;
        parentNode.children.push(elementNode);
      }
    }

    const orderedAnnotations: HTMLElement[] = [];

    const self = this;
    function addFlattenedElement(node: TreeNode, depth: number) {
      const element = node.element;
      self.setPadding(element, depth);
      orderedAnnotations.push(element);
      for (const child of node.children) {
        addFlattenedElement(child, depth + 1);
      }
    }

    for (const element of this.annotationsToAdd) {
      if (!element.dataset.parent) {
        addFlattenedElement(idNodes.get(element.dataset.id!)!, 0);
      }
    }
    this.annotationsToAdd = orderedAnnotations;
  }

  private setPadding(element: HTMLElement, depth: number) {
    element.style.paddingLeft = (depth + 0.5) + 'em';
  }

  private addAnnotationElement(annotation: Annotation) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    const element = this.makeAnnotationListElement(annotation);
    const parent = element.dataset.parent ?
        this.annotationListElements.get(element.dataset.parent) :
        undefined;
    this.annotationHidingList.insertElement(element, parent);
    this.resetOnUpdate();
  }

  private addAnnotationsHelper(annotations: Iterable<Annotation>) {
    this.annotationsToAdd = [];
    for (const annotation of annotations) {
      this.annotationsToAdd.push(this.makeAnnotationListElement(annotation, false));
    }
    this.arrangeAnnotationsToAdd();
    this.annotationHidingList.addElements(this.annotationsToAdd);
    this.resetOnUpdate();
  }

  private addAnnotationElements(annotations: Annotation[]) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    this.addAnnotationsHelper(annotations);
  }

  private updateAnnotationElement(annotation: Annotation, checkVisibility = true) {
    if (checkVisibility && !this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }

    const {annotationListElements} = this;
    const element = annotationListElements.get(annotation.id);
    if (!element) {
      return;
    }
    const {annotationHidingList} = this;
    const newElement = this.makeAnnotationListElement(annotation);
    // This makes sure the new element preserves classes of the old
    newElement.classList.add(...[...element.classList]);
    let isInProgress = (<AnnotationSource>this.annotationLayer.source).isPending(annotation.id);
    newElement.classList.toggle('neuroglancer-annotation-inprogress', isInProgress);
    annotationHidingList.replaceElement(newElement, element);
    annotationListElements.set(annotation.id, newElement);
    this.resetOnUpdate();
  }

  private deleteAnnotationElement(annotationId: string) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    let element = this.annotationListElements.get(annotationId);
    if (element) {
      this.annotationHidingList.removeElement(element);
      this.annotationListElements.delete(annotationId);
    }
    this.resetOnUpdate();
  }

  private resetOnUpdate() {
    this.clearHoverClass();
    this.clearSelectionClass();
    this.updated = true;
    this.updateHoverView();
    this.updateSelectionView();
  }

  handleInitialMultipleState(override: StateOverride) {
    const state = this.state.value;

    if (override.multiple) {
      return override.multiple;
    }

    if (state) {
      if (state.ungroupable) {
        return;
      }
      return state.multiple ? state.multiple : new Set<string>([override.id || state.id]);
    }
    return;
  }

  selectAnnotationInGroup(annotationId: string, previousId?: string, givenSet?: Set<string>) {
    const element = this.annotationListElements.get(annotationId);
    const multiple = this.handleInitialMultipleState({id: previousId, multiple: givenSet});
    if (!element || !multiple) {
      return;
    }
    const multipleKey = 'neuroglancer-annotation-multiple';

    if (multiple.has(annotationId)) {
      multiple.delete(annotationId);
      element.classList.remove(multipleKey);
    } else {
      multiple.add(annotationId);
      element.classList.add(multipleKey);
    }
    return multiple;
  }

  shiftSelect(origin: string, target: string) {
    let multiple: Set<string>|undefined;
    const source = (<AnnotationSource>this.annotationLayer.source);
    let pList: string[]|null = [];
    let nList: string[]|null = [];

    while (pList || nList) {
      if (pList) {
        let prev: AnnotationCT|undefined = source.getPrevAnnotation(
            !pList.length ? origin : pList[pList.length - 1], this.annotationListContainer);
        const current = pList[pList.length - 1];
        if (current === target) {
          nList = null;
          break;
        } else if (!prev || prev.loopedOver || current === origin) {
          pList = null;
        } else {
          pList.push(prev.id);
        }
      }
      if (nList) {
        let next: AnnotationCT|undefined = source.getNextAnnotation(
            !nList.length ? origin : nList[nList.length - 1], this.annotationListContainer);
        const current = nList[nList.length - 1];
        if (current === target) {
          pList = null;
          break;
        } else if (!next || next.loopedOver || current === origin) {
          nList = null;
        } else {
          nList.push(next.id);
        }
      }
    }
    const shiftList = nList || pList || [];
    shiftList.forEach((id, n, list) => {
      // element?.classList.add('neuroglancer-annotation-multiple');
      // TODO: Optional Chaining doesn't work w/ Webpack yet
      multiple = this.selectAnnotationInGroup(id, n!? origin : list[n - 1], multiple);
    });

    return multiple;
  }

  private makeAnnotationListElement(annotation: Annotation, doPadding: boolean = true) {
    const transform = this.annotationLayer.objectToGlobal;
    const element = document.createElement('li');

    element.dataset.id = annotation.id;
    element.title = 'Click to select, right click to recenter view.';
    let isInProgress = (<AnnotationSource>this.annotationLayer.source).isPending(annotation.id);
    element.classList.toggle('neuroglancer-annotation-inprogress', isInProgress);

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-icon';
    icon.textContent = getAnnotationTypeHandler(annotation.type).icon;
    element.appendChild(icon);

    const position = document.createElement('div');
    position.className = 'neuroglancer-annotation-position';
    getPositionSummary(position, annotation, transform, this.voxelSize, this.setSpatialCoordinates);
    element.appendChild(position);
    if (annotation.parentId) {
      element.dataset.parent = annotation.parentId;
    }
    this.createAnnotationDescriptionElement(element, annotation);

    if ((<Collection>annotation).entries) {
      element.title = 'Click to select, right click to toggle children.';
    }

    this.annotationListElements.set(annotation.id, element);

    let depth = 0;
    let parent = undefined;
    let checkElement: HTMLElement = element;
    while (checkElement && checkElement.dataset.parent) {
      const parentId = checkElement.dataset.parent;
      parent = this.annotationListElements.get(parentId);
      checkElement = parent!;
      let checkCollection = <Collection>this.annotationLayer.source.getReference(parentId).value;
      if (checkCollection.entries) {
        if (!checkCollection.entries.includes(annotation.id) &&
            checkCollection.id === annotation.parentId) {
          checkCollection.entries.push(annotation.id);
        }
        if (!checkCollection.childrenVisible.value) {
          element.classList.add('neuroglancer-annotation-child-hidden');
          this.setChildrenVisibleHelper(element.dataset.id, false);
        }
      }
      depth++;
    }
    if (doPadding) {
      this.setPadding(element, depth);
    }

    const collectionAnnotation = <Collection>annotation;
    if (collectionAnnotation.entries && !collectionAnnotation.childrenVisible.value) {
      this.setChildrenVisibleHelper(element.dataset.id, false);
    }

    element.addEventListener('mouseenter', () => {
      this.annotationLayer.hoverState.value = {id: annotation.id, partIndex: 0};
    });

    element.addEventListener('click', (event: MouseEvent) => {
      let lastSelected, groupable, edit;
      let selectedId = annotation.id;
      const state = this.state.value;
      if (state) {
        lastSelected = [...(state.multiple || [])].pop();
        const otherSelected = annotation.id !== state.id;
        groupable = lastSelected || otherSelected;
        edit = state.edit;
      }
      let multiple;
      if (event.ctrlKey || event.metaKey || (event.shiftKey && !groupable)) {
        multiple = this.selectAnnotationInGroup(annotation.id);
        if (multiple && multiple.size <= 1) {
          selectedId = [...multiple].pop()!;
          multiple = undefined;
          this.previousSelectedId = undefined;
        }
      } else if (event.shiftKey && groupable) {
        const first = lastSelected ? lastSelected : state!.id;
        const firstAnnotation = (<AnnotationSource>this.annotationLayer.source).get(first);
        if (firstAnnotation && firstAnnotation.parentId === annotation.parentId) {
          multiple = this.shiftSelect(first, annotation.id);
        } else {
          if (state) {
            multiple = state.multiple;
          }
          StatusMessage.showTemporaryMessage(
              `Cannot Shift Select between annotations of different hierarchy. Use Ctrl Select instead.`,
              3000);
        }
      }

      this.state.value = {id: selectedId, multiple, edit};
      event.stopPropagation();
    });

    element.addEventListener('mouseup', (event: MouseEvent) => {
      const collection = <Collection>annotation;
      if (event.button === 2) {
        if (collection.entries) {
          collection.childrenVisible.value = !collection.childrenVisible.value;
          this.setChildrenVisible(element.dataset.id!, collection.childrenVisible.value);
        } else {
          this.setSpatialCoordinates(
              getCenterPosition(collection, this.annotationLayer.objectToGlobal));
        }
        event.stopPropagation();
      }
    });
    return element;
  }

  private setChildrenVisible(elementId: string, visible: boolean) {
    this.setChildrenVisibleHelper(elementId, visible);
    this.annotationHidingList.recalculateHeights();
    this.annotationLayer.source.changed.dispatch();
  }

  private setChildrenVisibleHelper(elementId: string, visible: boolean) {
    const collection = <Collection>this.annotationLayer.source.getReference(elementId).value;
    if (!collection.entries) {
      return;
    }
    for (const childId of collection.entries) {
      const child = this.annotationListElements.get(childId);
      if (!child) {
        continue;
      }  // child not defined yet
      if (visible) {
        child.classList.remove('neuroglancer-annotation-child-hidden');
        const annotation = this.annotationLayer.source.getReference(childId).value;
        const collectionAnnotation = <Collection>annotation;
        // expand the children if they had been shown before collapsing this
        if (collectionAnnotation.entries && collectionAnnotation.childrenVisible.value) {
          this.setChildrenVisibleHelper(childId, true);
        }
      } else {
        child.classList.add('neuroglancer-annotation-child-hidden');
        this.setChildrenVisibleHelper(childId, false);
      }
    }
  }

  private createAnnotationDescriptionElement(
      annotationElement: HTMLElement, annotation: Annotation) {
    const annotationText = this.layer.getAnnotationText(annotation);
    if (annotationText) {
      const description = document.createElement('div');
      description.className = 'neuroglancer-annotation-description';
      description.textContent = annotationText;
      annotationElement.appendChild(description);
    }
  }

  private filterAnnotationsByTag(tagId: number) {
    for (const [annotationId, annotationElement] of this.annotationListElements) {
      if (tagId === 0 ||
          this.annotationLayer.source.isAnnotationTaggedWithTag(annotationId, tagId)) {
        annotationElement.classList.remove('neuroglancer-annotation-hiding-list-tagged-hidden');
      } else {
        annotationElement.classList.add('neuroglancer-annotation-hiding-list-tagged-hidden');
      }
    }
    this.annotationHidingList.recalculateHeights();
  }

  private exportToCSV() {
    const filename = 'annotations.csv';
    const pointToCoordinateText = (point: vec3, transform: mat4) => {
      const spatialPoint = vec3.transformMat4(vec3.create(), point, transform);
      return formatIntegerPoint(this.voxelSize.voxelFromSpatial(tempVec3, spatialPoint));
    };
    const columnHeaders = [
      'Coordinate 1', 'Coordinate 2', 'Ellipsoid Dimensions', 'Tags', 'Description', 'Segment IDs',
      'Parent ID', 'Type', 'ID'
    ];
    const csvData: string[][] = [];
    for (const annotation of this.annotationLayer.source) {
      const annotationRow = [];
      let coordinate1String = '';
      let coordinate2String = '';
      let ellipsoidDimensions = '';
      let stringType = '';
      let collectionID = '';
      switch (annotation.type) {
        case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
        case AnnotationType.LINE:
          stringType = annotation.type === AnnotationType.LINE ? 'Line' : 'AABB';
          coordinate1String =
              pointToCoordinateText(annotation.pointA, this.annotationLayer.objectToGlobal);
          coordinate2String =
              pointToCoordinateText(annotation.pointB, this.annotationLayer.objectToGlobal);
          break;
        case AnnotationType.POINT:
          stringType = 'Point';
          coordinate1String =
              pointToCoordinateText(annotation.point, this.annotationLayer.objectToGlobal);
          break;
        case AnnotationType.ELLIPSOID:
          stringType = 'Ellipsoid';
          coordinate1String =
              pointToCoordinateText(annotation.center, this.annotationLayer.objectToGlobal);
          const transformedRadii = transformVectorByMat4(
              tempVec3, annotation.radii, this.annotationLayer.objectToGlobal);
          this.voxelSize.voxelFromSpatial(transformedRadii, transformedRadii);
          ellipsoidDimensions = formatIntegerBounds(transformedRadii);
          break;
        case AnnotationType.SPOKE:
        case AnnotationType.LINE_STRIP:
        case AnnotationType.COLLECTION:
          switch (annotation.type) {
            case AnnotationType.SPOKE:
              stringType = (<Spoke>annotation).wheeled ? 'Spoke*' : 'Spoke';
              break;
            case AnnotationType.LINE_STRIP:
              stringType = (<LineStrip>annotation).looped ? 'Line Strip*' : 'Line Strip';
              break;
            default:
              stringType = 'Collection';
          }
          coordinate1String =
              pointToCoordinateText(annotation.source, this.annotationLayer.objectToGlobal);
          collectionID = annotation.id;
          break;
      }
      annotationRow.push(coordinate1String);
      annotationRow.push(coordinate2String);
      annotationRow.push(ellipsoidDimensions);
      // Tags
      if (this.annotationLayer.source instanceof AnnotationSource && annotation.tagIds) {
        // Papa.unparse expects an array of arrays even though here we only want to create a csv
        // for one row of tags
        const annotationTags: string[][] = [[]];
        annotation.tagIds.forEach(tagId => {
          const tag = (<AnnotationSource>this.annotationLayer.source).getTag(tagId);
          if (tag) {
            annotationTags[0].push(tag.label);
          }
        });
        if (annotationTags[0].length > 0) {
          annotationRow.push(Papa.unparse(annotationTags));
        } else {
          annotationRow.push('');
        }
      } else {
        annotationRow.push('');
      }
      // Description
      if (annotation.description) {
        annotationRow.push(annotation.description);
      } else {
        annotationRow.push('');
      }
      // Segment IDs
      if (annotation.segments) {
        // Papa.unparse expects an array of arrays even though here we only want to create a csv
        // for one row of segments
        const annotationSegments: string[][] = [[]];
        annotation.segments.forEach(segmentID => {
          annotationSegments[0].push(segmentID.toString());
        });
        if (annotationSegments[0].length > 0) {
          annotationRow.push(Papa.unparse(annotationSegments));
        } else {
          annotationRow.push('');
        }
      } else {
        annotationRow.push('');
      }
      // Parent ID
      annotationRow.push(annotation.parentId || '');
      // Type
      annotationRow.push(stringType);
      // ID
      annotationRow.push(collectionID);

      csvData.push(annotationRow);
    }
    const csvString = Papa.unparse({'fields': columnHeaders, 'data': csvData});
    const blob = new Blob([csvString], {type: 'text/csv;charset=utf-8;'});
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // TODO: pull request to papa repo
  private betterPapa = (inputFile: File|Blob): Promise<any> => {
      return new Promise((resolve) => {
        Papa.parse(inputFile, {
          complete: (results: any) => {
            resolve(results);
          }
        });
      });
    }

    private stringToVec3 = (input: string): vec3 => {
      // format: (x, y, z)
      let raw = input.split('');
      raw.shift();
      raw.pop();
      let list = raw.join('');
      let val = list.split(',').map(v => parseInt(v, 10));
      return vec3.fromValues(val[0], val[1], val[2]);
    }

    private dimensionsToVec3 = (input: string): vec3 => {
      // format: A × B × C
      let raw = input.replace(/s/g, '');
      let val = raw.split('×').map(v => parseInt(v, 10));
      return vec3.fromValues(val[0], val[1], val[2]);
    }

    private async importCSV(files: FileList|null) {
    const rawAnnotations = <Annotation[]>[];
    let successfulImport = 0;

    if (!files) {
      return;
    }

    for (const file of files) {
      const rawData = await this.betterPapa(file);
      rawData.data = rawData.data.filter((v: any) => v.join('').length);
      if (!rawData.data.length) {
        continue;
      }
      const annStrings = rawData.data;
      const csvIdToRealAnnotationIdMap: {[key: string]: string} = {};
      const childStorage: {[key: string]: string[]} = {};
      const textToPoint = (point: string, transform: mat4, dimension?: boolean) => {
        const parsedVec = dimension ? this.dimensionsToVec3(point) : this.stringToVec3(point);
        const spatialPoint = this.voxelSize.spatialFromVoxel(tempVec3, parsedVec);
        return vec3.transformMat4(vec3.create(), spatialPoint, transform);
      };
      let row = -1;
      for (const annProps of annStrings) {
        row++;
        const type = annProps[7];
        const parentId = annProps[6];
        const annotationID: string|undefined = annProps[8];
        const tags = annProps[3];
        let raw = <Annotation>{id: makeAnnotationId(), description: annProps[4]};

        switch (type) {
          case 'AABB':
          case 'Line':
            raw.type =
                type === 'Line' ? AnnotationType.LINE : AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;
            (<Line>raw).pointA = textToPoint(annProps[0], this.annotationLayer.globalToObject);
            (<Line>raw).pointB = textToPoint(annProps[1], this.annotationLayer.globalToObject);
            break;
          case 'Point':
            raw.type = AnnotationType.POINT;
            (<Point>raw).point = textToPoint(annProps[0], this.annotationLayer.globalToObject);
            break;
          case 'Ellipsoid':
            raw.type = AnnotationType.ELLIPSOID;
            (<Ellipsoid>raw).center = textToPoint(annProps[0], this.annotationLayer.globalToObject);
            (<Ellipsoid>raw).radii =
                textToPoint(annProps[2], this.annotationLayer.globalToObject, true);
            break;
          case 'Line Strip':
          case 'Line Strip*':
          case 'Spoke':
          case 'Spoke*':
          case 'Collection':
            if (type === 'Line Strip' || type === 'Line Strip*') {
              raw.type = AnnotationType.LINE_STRIP;
              (<LineStrip>raw).connected = true;
              (<LineStrip>raw).looped = type === 'Line Strip*';
            } else if (type === 'Spoke' || type === 'Spoke*') {
              raw.type = AnnotationType.SPOKE;
              (<Spoke>raw).connected = true;
              (<Spoke>raw).wheeled = type === 'Spoke*';
            } else {
              raw.type = AnnotationType.COLLECTION;
              (<Collection>raw).connected = false;
            }
            (<Collection>raw).childrenVisible = new TrackableBoolean(false, true);
            (<Collection>raw).source =
                textToPoint(annProps[0], this.annotationLayer.globalToObject);
            (<Collection>raw).entry = (index: number) =>
                (<LocalAnnotationSource>this.annotationLayer.source)
                    .get((<Collection>raw).entries[index]);
            break;
          default:
            // Do not add annotation row, if it has unexpected type
            console.error(
                `No annotation of type ${type}. Cannot parse ${file.name}:${row} ${annProps}`);
            continue;
        }

        if (annotationID) {
          if (csvIdToRealAnnotationIdMap[annotationID]) {
            raw.id = csvIdToRealAnnotationIdMap[annotationID];
            (<Collection>raw).entries = childStorage[raw.id];
          } else {
            csvIdToRealAnnotationIdMap[annotationID] = raw.id;
            (<Collection>raw).entries = [];
            childStorage[raw.id] = (<Collection>raw).entries;
          }
        }

        if (parentId) {
          if (csvIdToRealAnnotationIdMap[parentId]) {
            raw.parentId = csvIdToRealAnnotationIdMap[parentId];
            childStorage[raw.parentId].push(raw.id);
          } else {
            raw.parentId = makeAnnotationId();
            csvIdToRealAnnotationIdMap[parentId] = raw.parentId;
            if (childStorage[raw.parentId]) {
              childStorage[raw.parentId].push(raw.id);
            } else {
              childStorage[raw.parentId] = [raw.id];
            }
          }
        }

        if (tags) {
          raw.tagIds = new Set();
          const labels = tags.split(',');
          const alayer = (<AnnotationSource>this.annotationLayer.source);
          const currentTags = Array.from(alayer.getTags());
          labels.forEach((label: string) => {
            const tagId = (currentTags.find(tag => tag.label === label) || <any>{}).id ||
                alayer.addTag(label);
            raw.tagIds!.add(tagId);
          });
        }
        // Segments not supported

        rawAnnotations.push(raw);
      }
      successfulImport++;
    }

    this.annotationLayer.source.addAll(rawAnnotations, true);
    // TODO: Undoable
    StatusMessage.showTemporaryMessage(`Imported ${successfulImport} csv(s).`, 3000);
  }
}
