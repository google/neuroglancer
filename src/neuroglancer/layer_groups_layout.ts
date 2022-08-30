/**
 * @license
 * Copyright 2017 Google Inc.
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
 * @file Facilities for laying out multiple LayerGroupViewer instances.
 */

import './layer_groups_layout.css';

import debounce from 'lodash/debounce';
import {LayerListSpecification, LayerSubsetSpecification} from 'neuroglancer/layer';
import {getViewerDropEffect, hasViewerDrag, LayerGroupViewer, viewerDragType} from 'neuroglancer/layer_group_viewer';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {popDragStatus, pushDragStatus} from 'neuroglancer/ui/drag_and_drop';
import {DropLayers, endLayerDrag, getDropLayers, getLayerDragInfo, updateLayerDropEffect} from 'neuroglancer/ui/layer_drag_and_drop';
import {SIZE_FOR_DIRECTION} from 'neuroglancer/ui/side_panel';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {getDropEffect, setDropEffect} from 'neuroglancer/util/drag_and_drop';
import {parseArray, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {startRelativeMouseDrag} from 'neuroglancer/util/mouse_drag';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

interface LayoutComponent extends RefCounted {
  element: HTMLElement;
  changed: NullarySignal;
  toJSON(): any;
}

const layoutComponentContainerSymbol = Symbol('layoutComponentContainer');

/**
 * Container for a LayoutComponent.  The contained LayoutComponent may change.
 */
export class LayoutComponentContainer extends RefCounted {
  changed = new NullarySignal();
  private componentValue: LayoutComponent;

  private unsetComponent() {
    const oldComponent = this.componentValue;
    if (oldComponent !== undefined) {
      oldComponent.changed.remove(this.changed.dispatch);
      this.element.removeChild(oldComponent.element);
      oldComponent.dispose();
    }
  }

  get component() {
    return this.componentValue;
  }

  // flexGrow value when this is contained in a StackLayoutComponent
  flex = new TrackableValue<number>(1, verifyFinitePositiveFloat);

  private setComponent(component: LayoutComponent) {
    this.unsetComponent();
    this.componentValue = component;
    component.changed.add(this.changed.dispatch);
    this.element.appendChild(component.element);

    if (component instanceof LayerGroupViewer) {
      const {layerManager} = component;
      const scheduleMaybeDelete = component.registerCancellable(debounce(() => {
        if (layerManager.managedLayers.length === 0) {
          this.dispose();
        }
      }, 0));
      component.registerDisposer(layerManager.layersChanged.add(() => {
        if (layerManager.managedLayers.length === 0) {
          scheduleMaybeDelete();
        }
      }));
      scheduleMaybeDelete();
    } else if (component instanceof StackLayoutComponent) {
      const scheduleMaybeDelete = component.registerCancellable(debounce(() => {
        const {length} = component;
        if (length === 0 && this.parent !== undefined) {
          this.dispose();
        } else if (length === 1) {
          const childComponent = component.get(0).component;
          let spec: any;
          if (this.parent === undefined && childComponent instanceof LayerGroupViewer) {
            spec = childComponent.layout.specification.toJSON();
            childComponent.viewerNavigationState.copyToParent();
            const childManagedLayers = childComponent.layerManager.managedLayers;
            const layersToKeep = new Set(childManagedLayers);
            const {layerSpecification} = childComponent;
            // Retain only layers that are part of the layer group, or are archived.
            layerSpecification.rootLayers.filter(
                layer => layersToKeep.has(layer) || layer.archived);
            // Permute the non-archived layers to match the order in the layer group.
            const childLayerIndices: number[] = [];
            const {managedLayers: rootManagedLayers} = layerSpecification.rootLayers;
            for (let i = 0, count = rootManagedLayers.length; i < count; ++i) {
              if (layersToKeep.has(rootManagedLayers[i])) {
                childLayerIndices.push(i);
              }
            }
            for (let i = 0, count = childManagedLayers.length; i < count; ++i) {
              rootManagedLayers[childLayerIndices[i]] = childManagedLayers[i];
            }
            layerSpecification.rootLayers.layersChanged.dispatch();
          } else {
            spec = childComponent.toJSON();
          }
          this.setSpecification(spec);
        }
      }, 0));
      component.registerDisposer(component.changed.add(() => {
        if (component.length < 2) {
          scheduleMaybeDelete();
        }
      }));
      scheduleMaybeDelete();
    }
    this.changed.dispatch();
  }
  element = document.createElement('div');

  constructor(public viewer: Viewer, spec: any, public parent: StackLayoutComponent|undefined) {
    super();
    const {element} = this;
    element.style.display = 'flex';
    element.style.flex = '1';
    element.style.position = 'relative';
    element.style.alignItems = 'stretch';
    (<any>element)[layoutComponentContainerSymbol] = this;
    this.flex.changed.add(() => {
      element.style.flexGrow = '' + this.flex.value;
      this.changed.dispatch();
    });
    this.setSpecification(spec);

    interface DropZone {
      element: HTMLElement;
      direction: 'row'|'column';
      orientation: 'left'|'right'|'top'|'bottom';
    }

    const dropZones: DropZone[] = [];
    const makeDropZone = (name: 'left'|'right'|'top'|'bottom') => {
      const dropZone = document.createElement('div');
      dropZone.className = 'neuroglancer-layout-split-drop-zone';
      let direction: 'row'|'column';
      dropZone.style[name] = '0';
      switch (name) {
        case 'left':
        case 'right':
          direction = 'row';
          dropZone.style.width = '10px';
          dropZone.style.height = '100%';
          break;
        case 'top':
        case 'bottom':
          direction = 'column';
          dropZone.style.height = '10px';
          dropZone.style.width = '100%';
          break;
      }
      dropZone.style.display = 'none';
      dropZones.push({element: dropZone, direction: direction!, orientation: name});
      element.appendChild(dropZone);
      setupDropZone(
          dropZone, this.viewer.layerSpecification,
          () => <LayerGroupViewer>(this.split(name).newContainer.component),
          direction === 'row' ? 'column' : 'row');
    };
    makeDropZone('left');
    makeDropZone('right');
    makeDropZone('top');
    makeDropZone('bottom');

    let dropZonesVisible = false;
    element.addEventListener('dragenter', (event: DragEvent) => {
      if (dropZonesVisible) {
        return;
      }
      if (getLayerDragInfo(event) === undefined) {
        return;
      }
      dropZonesVisible = true;
      for (const {element: dropZone, direction, orientation} of dropZones) {
        if (parent !== undefined && direction === parent.direction) {
          if (((orientation === 'left' || orientation === 'top') && parent.get(0) !== this) ||
              ((orientation === 'bottom' || orientation === 'right') &&
               parent.get(parent.length - 1) !== this)) {
            continue;
          }
        }
        const {component} = this;
        if (component instanceof StackLayoutComponent && component.direction === direction) {
          continue;
        }
        dropZone.style.display = 'block';
      }
    }, true);

    element.addEventListener('drop', (_event: DragEvent) => {
      if (!dropZonesVisible) {
        return;
      }
      dropZonesVisible = false;
      for (const {element: dropZone} of dropZones) {
        dropZone.style.display = 'none';
      }
    }, /*capture=*/ true);
    element.addEventListener('dragleave', (event: DragEvent) => {
      const {relatedTarget} = event;
      if (!dropZonesVisible) {
        return;
      }
      if (relatedTarget instanceof HTMLElement && this.element.contains(relatedTarget)) {
        return;
      }
      dropZonesVisible = false;
      for (const {element: dropZone} of dropZones) {
        dropZone.style.display = 'none';
      }
    }, true);
  }

  toJSON() {
    const j = this.component.toJSON();
    if (this.parent instanceof StackLayoutComponent) {
      j.flex = this.flex.toJSON();
    }
    return j;
  }

  setSpecification(spec: any) {
    this.setComponent(makeComponent(this, spec));
    this.flex.value = verifyOptionalObjectProperty(spec, 'flex', verifyFinitePositiveFloat, 1);
  }

  static getFromElement(element: Element): LayoutComponentContainer {
    return (<any>element)[layoutComponentContainerSymbol];
  }

  disposed() {
    this.unsetComponent();
    (<any>this).componentValue = undefined;
    super.disposed();
  }

  split(side: 'left'|'top'|'bottom'|'right'):
      {newContainer: LayoutComponentContainer, existingContainer: LayoutComponentContainer} {
    const newComponentSpec: any = {
      type: 'viewer',
    };

    const {parent} = this;
    if (parent !== undefined) {
      if ((side === 'left' && parent.direction === 'row') ||
          (side === 'top' && parent.direction === 'column')) {
        return {newContainer: parent.insertChild(newComponentSpec, this), existingContainer: this};
      } else if (
          (side === 'right' && parent.direction === 'row') ||
          (side === 'bottom' && parent.direction === 'column')) {
        return {newContainer: parent.insertChild(newComponentSpec), existingContainer: this};
      }
    }

    let existingComponentSpec: any;
    const existingComponent = this.component;
    if (existingComponent instanceof SingletonLayerGroupViewer) {
      existingComponentSpec = existingComponent.layerGroupViewer.toJSON();
    } else {
      existingComponentSpec = existingComponent.toJSON();
    }
    let spec: any;
    let newIndex: number;
    const direction = side === 'left' || side === 'right' ? 'row' : 'column';
    switch (side) {
      case 'left':
      case 'top':
        spec = {type: direction, children: [newComponentSpec, existingComponentSpec]};
        newIndex = 0;
        break;
      case 'right':
      case 'bottom':
        spec = {type: direction, children: [existingComponentSpec, newComponentSpec]};
        newIndex = 1;
        break;
    }
    this.setSpecification(spec!);
    const stackComponent = <StackLayoutComponent>this.component;
    return {
      newContainer: stackComponent.get(newIndex!),
      existingContainer: stackComponent.get(1 - newIndex!)
    };
  }
}

function getCommonViewerState(viewer: Viewer) {
  return {
    mouseState: viewer.mouseState,
    showAxisLines: viewer.showAxisLines,
    wireFrame: viewer.wireFrame,
    showScaleBar: viewer.showScaleBar,
    scaleBarOptions: viewer.scaleBarOptions,
    showPerspectiveSliceViews: viewer.showPerspectiveSliceViews,
    inputEventBindings: viewer.inputEventBindings,
    visibility: viewer.visibility,
    selectedLayer: viewer.selectedLayer,
    visibleLayerRoles: viewer.visibleLayerRoles,
    navigationState: viewer.navigationState.addRef(),
    perspectiveNavigationState: viewer.perspectiveNavigationState.addRef(),
    crossSectionBackgroundColor: viewer.crossSectionBackgroundColor,
    perspectiveViewBackgroundColor: viewer.perspectiveViewBackgroundColor,
  };
}

export class SingletonLayerGroupViewer extends RefCounted implements LayoutComponent {
  layerGroupViewer: LayerGroupViewer;

  constructor(public element: HTMLElement, layout: any, viewer: Viewer) {
    super();
    this.layerGroupViewer = this.registerDisposer(new LayerGroupViewer(
        element, {
          display: viewer.display,
          layerSpecification: viewer.layerSpecification.addRef(),
          ...getCommonViewerState(viewer),
        },
        {
          showLayerPanel: viewer.uiControlVisibility.showLayerPanel,
          showViewerMenu: false,
          showLayerHoverValues: viewer.uiControlVisibility.showLayerHoverValues
        }));
    this.layerGroupViewer.layout.restoreState(layout);
  }

  toJSON() {
    return this.layerGroupViewer.layout.specification.toJSON();
  }

  get changed() {
    return this.layerGroupViewer.layout.changed;
  }
}

function setupDropZone(
    dropZone: HTMLElement, manager: Borrowed<LayerListSpecification>,
    makeLayerGroupViewer: () => Borrowed<LayerGroupViewer>, direction: 'row'|'column') {
  dropZone.addEventListener('dragenter', (event: DragEvent) => {
    const dragInfo = getLayerDragInfo(event);
    if (dragInfo === undefined) {
      return;
    }
    dropZone.classList.add('neuroglancer-drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    popDragStatus(dropZone, 'drop');
    dropZone.classList.remove('neuroglancer-drag-over');
  });
  dropZone.addEventListener('dragover', (event: DragEvent) => {
    const allowDrag = (info: {dropEffect: string, dropEffectMessage: string}, message: string) => {
      if (info.dropEffectMessage) message += ` (${info.dropEffectMessage})`;
      pushDragStatus(dropZone, 'drop', message);
      event.stopPropagation();
      event.preventDefault();
    };
    if (hasViewerDrag(event)) {
      const info = getViewerDropEffect(event, manager);
      setDropEffect(event, info.dropEffect);
      allowDrag(info, `Drop to ${info.dropEffect} layer group as new ${direction}`);
      return;
    }
    if (getLayerDragInfo(event) !== undefined) {
      const info = updateLayerDropEffect(
          event, manager, /*targetIsLayerListPanel=*/ false, /*newTarget=*/ true);
      allowDrag(info, `Drop to ${info.dropEffect} layer as new ${direction}`);
      return;
    }
  });
  dropZone.addEventListener('drop', (event: DragEvent) => {
    dropZone.classList.remove('neuroglancer-drag-over');
    popDragStatus(dropZone, 'drop');
    let dropLayers: DropLayers|undefined;
    let layoutSpec: any;
    if (hasViewerDrag(event)) {
      event.stopPropagation();
      try {
        layoutSpec = JSON.parse(event.dataTransfer!.getData(viewerDragType));
      } catch (e) {
        return;
      }
      dropLayers = getDropLayers(event, manager, {forceCopy: false, newTarget: true});
      if (dropLayers === undefined) return;
    } else {
      dropLayers =
          getDropLayers(event, manager, {forceCopy: getDropEffect() === 'copy', newTarget: true});
      if (dropLayers === undefined) return;
      layoutSpec = dropLayers.layoutSpec;
    }

    if (!dropLayers.initializeExternalLayers(event)) {
      if (!dropLayers.moveSupported) {
        for (const layer of dropLayers.layers.keys()) {
          layer.dispose();
        }
      }
      return;
    }
    event.preventDefault();
    const dropEffect = event.dataTransfer!.dropEffect = getDropEffect()!;
    endLayerDrag(dropEffect);
    const layerGroupViewer = makeLayerGroupViewer();
    dropLayers.updateArchiveStates(event);
    for (const newLayer of dropLayers.layers.keys()) {
      layerGroupViewer.layerSpecification.add(newLayer);
    }
    try {
      layerGroupViewer.restoreState(layoutSpec);
    } catch {
      layerGroupViewer.layout.reset();
      // Ignore error restoring layout.
    }
  });
}

export class StackLayoutComponent extends RefCounted implements LayoutComponent {
  changed = new NullarySignal();

  get length() {
    return (this.element.childElementCount - 1) / 2;
  }

  private makeDropPlaceholder(refCounted: RefCounted) {
    const dropZone = document.createElement('div');
    dropZone.className = 'neuroglancer-stack-layout-drop-placeholder';
    setupDropZone(dropZone, this.viewer.layerSpecification, () => {
      const nextElement = dropZone.nextElementSibling;
      let nextChild: LayoutComponentContainer|undefined;
      if (nextElement !== null) {
        nextChild = LayoutComponentContainer.getFromElement(nextElement);
      }
      const newChild = this.insertChild({type: 'viewer', layers: []}, nextChild);
      return <LayerGroupViewer>newChild.component;
    }, this.direction === 'row' ? 'column' : 'row');
    refCounted.registerDisposer(() => {
      removeFromParent(dropZone);
    });
    dropZone.addEventListener('pointerdown', event => {
      if ('button' in event && event.button !== 0) {
        return;
      }
      const nextElement = dropZone.nextElementSibling;
      if (nextElement === null) return;
      const nextChild = LayoutComponentContainer.getFromElement(nextElement);
      const prevElement = dropZone.previousElementSibling;
      if (prevElement === null) return;
      const prevChild = LayoutComponentContainer.getFromElement(prevElement);
      event.preventDefault();
      const updateMessage = () => {
        pushDragStatus(
            dropZone, 'drag',
            `Drag to resize, current ${SIZE_FOR_DIRECTION[this.direction]} ratio is ` +
                `${prevChild.flex.value} : ` +
                `${nextChild.flex.value}`);
      };
      updateMessage();
      startRelativeMouseDrag(
          event,
          newEvent => {
            const firstRect = prevChild.element.getBoundingClientRect();
            const secondRect = nextChild.element.getBoundingClientRect();
            const firstFraction = Math.max(
                0.1,
                Math.min(
                    0.9,
                  this.direction === 'column' ?
                        (newEvent.clientY - firstRect.top) / (secondRect.bottom - firstRect.top) :
                    (newEvent.clientX - firstRect.left) / (secondRect.right - firstRect.left)));
            const existingFlexSum = Number(prevChild.flex.value) + Number(nextChild.flex.value);
            prevChild.flex.value = Math.round(firstFraction * existingFlexSum * 100) / 100;
            nextChild.flex.value = Math.round((1 - firstFraction) * existingFlexSum * 100) / 100;
            updateMessage();
          },
          () => {
            popDragStatus(dropZone, 'drag');
          });
    });
    return dropZone;
  }

  get viewer() {
    return this.container.viewer;
  }

  constructor(
      public element: HTMLElement, public direction: 'row'|'column', children: any[],
      public container: LayoutComponentContainer) {
    super();
    element.classList.add('neuroglancer-stack-layout');
    element.classList.add(`neuroglancer-stack-layout-${direction}`);
    element.style.display = 'flex';
    element.style.flexDirection = direction;
    element.appendChild(this.makeDropPlaceholder(this));
    for (const childSpec of children) {
      this.insertChild(childSpec);
    }
  }

  get(index: number) {
    return LayoutComponentContainer.getFromElement(this.element.children[index * 2 + 1]);
  }

  insertChild(spec: any, before?: LayoutComponentContainer) {
    const child = new LayoutComponentContainer(this.viewer, spec, this);
    const dropZone = this.makeDropPlaceholder(child);
    child.element.classList.add('neuroglancer-stack-layout-child');
    child.registerDisposer(child.changed.add(this.changed.dispatch));
    child.registerDisposer(() => {
      this.element.removeChild(child.element);
      this.changed.dispatch();
    });
    const beforeElement = before !== undefined ? before.element : null;
    this.element.insertBefore(child.element, beforeElement);
    this.element.insertBefore(dropZone, beforeElement);
    this.changed.dispatch();
    return child;
  }

  disposed() {
    this.clear();
    super.disposed();
  }

  clear() {
    while (this.length !== 0) {
      this.get(0).dispose();
    }
  }

  * [Symbol.iterator]() {
    const {length} = this;
    for (let i = 0; i < length; ++i) {
      yield this.get(i);
    }
  }

  toJSON() {
    return {
      type: this.direction,
      children: Array.from(this).map(x => x.toJSON()),
    };
  }
}

function makeComponent(container: LayoutComponentContainer, spec: any) {
  const element = document.createElement('div');
  element.style.flex = '1';
  element.style.width = '0px';
  if (typeof spec === 'string') {
    if (container.parent !== undefined) {
      throw new Error(`Invalid layout component specification: ${JSON.stringify(spec)}`);
    }
    return new SingletonLayerGroupViewer(element, spec, container.viewer);
  }
  verifyObject(spec);
  const componentType = verifyObjectProperty(spec, 'type', verifyString);
  switch (componentType) {
    case 'row':
    case 'column': {
      return new StackLayoutComponent(
          element, componentType, verifyObjectProperty(spec, 'children', x => {
            const children = parseArray(x, y => y);
            if (container.parent === undefined && children.length === 0) {
              throw new Error('Stack layout requires at least one child.');
            }
            return children;
          }), container);
    }
    case 'viewer': {
      const viewer = container.viewer;
      const layerSpecification = new LayerSubsetSpecification(viewer.layerSpecification.addRef());
      const layerGroupViewer = new LayerGroupViewer(
          element, {
            display: viewer.display,
            layerSpecification,
            ...getCommonViewerState(viewer),
          },
          {
            showLayerPanel: viewer.uiControlVisibility.showLayerPanel,
            showViewerMenu: true,
            showLayerHoverValues: viewer.uiControlVisibility.showLayerHoverValues
          });
      try {
        layerGroupViewer.restoreState(spec);
      } catch (e) {
        layerGroupViewer.dispose();
        throw e;
      }
      return layerGroupViewer;
    }
    default: {
      // Treat it as a singleton layer group.
      return new SingletonLayerGroupViewer(element, spec, container.viewer);
    }
  }
}

export class RootLayoutContainer extends RefCounted implements Trackable {
  container = this.registerDisposer(
      new LayoutComponentContainer(this.viewer, this.defaultSpecification, undefined));

  get changed() {
    return this.container.changed;
  }

  get element() {
    return this.container.element;
  }

  constructor(public viewer: Viewer, public defaultSpecification: any) {
    super();
  }

  reset() {
    this.container.setSpecification(this.defaultSpecification);
  }

  restoreState(obj: any) {
    this.container.setSpecification(obj);
  }

  disposed() {
    super.disposed();
  }

  toJSON() {
    return this.container.toJSON();
  }
}
