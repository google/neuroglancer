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

import debounce from 'lodash/debounce';
import {getViewerDropEffect, hasViewerDrag, LayerGroupViewer, viewerDragType} from 'neuroglancer/layer_group_viewer';
import {LayerListSpecification, LayerSubsetSpecification} from 'neuroglancer/layer_specification';
import {endLayerDrag, getDropLayers, getLayerDragInfo, updateLayerDropEffect} from 'neuroglancer/ui/layer_drag_and_drop';
import {Borrowed, RefCounted, registerEventListener} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {getDropEffect, setDropEffect} from 'neuroglancer/util/drag_and_drop';
import {parseArray, verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

require('./layer_groups_layout.css');

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
            const layersToKeep = new Set(childComponent.layerManager.managedLayers);
            const {layerSpecification} = childComponent;
            layerSpecification.rootLayers.filter(layer => layersToKeep.has(layer));
            layerSpecification.rootLayers.managedLayers =
              Array.from(childComponent.layerManager.managedLayers);
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
    (<any>element).foo = 'hello';
    (<any>element)[layoutComponentContainerSymbol] = this;

    this.setSpecification(spec);

    interface DropZone {
      element: HTMLElement;
      direction: 'row' | 'column';
      orientation: 'left' | 'right' | 'top' | 'bottom';
    }

    const dropZones: DropZone[] = [];
    const makeDropZone = (name: 'left'|'right'|'top'|'bottom') => {
      const dropZone = document.createElement('div');
      dropZone.className = 'neuroglancer-layout-split-drop-zone';
      let direction: 'row' | 'column';
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
      this.registerDisposer(setupDropZone(
          dropZone, this.viewer.layerSpecification,
          () => <LayerGroupViewer>(this.split(name).newContainer.component)));
    };
    makeDropZone('left');
    makeDropZone('right');
    makeDropZone('top');
    makeDropZone('bottom');

    let dropZonesVisible = false;
    this.registerEventListener(element, 'dragenter', (event: DragEvent) => {
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

    this.registerEventListener(element, 'drop', (_event: DragEvent) => {
      if (!dropZonesVisible) {
        return;
      }
      dropZonesVisible = false;
      for (const {element: dropZone} of dropZones) {
        dropZone.style.display = 'none';
      }
    });
    this.registerEventListener(element, 'dragleave', (event: DragEvent) => {
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
    return this.component.toJSON();
  }

  setSpecification(spec: any) {
    this.setComponent(makeComponent(this, spec));
  }

  static getFromElement(element: Element): LayoutComponentContainer {
    return (<any>element)[layoutComponentContainerSymbol];
  }

  disposed () {
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
    sliceViewPrefetchingEnabled: viewer.sliceViewPrefetchingEnabled
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
        {showLayerPanel: viewer.uiControlVisibility.showLayerPanel, showViewerMenu: false}));
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
  dropZone: HTMLElement, manager: Borrowed<LayerListSpecification>, makeLayerGroupViewer: () => Borrowed<LayerGroupViewer>) {
  const enterDisposer = registerEventListener(dropZone, 'dragenter', (event: DragEvent) => {
    if (getLayerDragInfo(event) === undefined) {
      return;
    }
    dropZone.classList.add('neuroglancer-drag-over');
  });
  const leaveDisposer = registerEventListener(dropZone, 'dragleave', () => {
    dropZone.classList.remove('neuroglancer-drag-over');
  });
  const overDisposer = registerEventListener(dropZone, 'dragover', (event: DragEvent) => {
    if (hasViewerDrag(event)) {
      setDropEffect(event, getViewerDropEffect(event, manager));
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (getLayerDragInfo(event) !== undefined) {
      updateLayerDropEffect(event, manager, /*newTarget=*/true);
      event.stopPropagation();
      event.preventDefault();
      return;
    }
  });
  const dropDisposer = registerEventListener(dropZone, 'drop', (event: DragEvent) => {
    dropZone.classList.remove('neuroglancer-drag-over');
    if (hasViewerDrag(event)) {
      event.stopPropagation();
      let dropState: any;
      try {
        dropState = JSON.parse(event.dataTransfer.getData(viewerDragType));
      } catch (e) {
        return;
      }
      const dropLayers = getDropLayers(
          event, manager, /*forceCopy=*/false, /*allowMove=*/false,
          /*newTarget=*/true);
      if (dropLayers !== undefined && dropLayers.finalize(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = getDropEffect();
        endLayerDrag(event);
        const layerGroupViewer = makeLayerGroupViewer();
        for (const newLayer of dropLayers.layers.keys()) {
          layerGroupViewer.layerSpecification.add(newLayer);
        }
        try {
          layerGroupViewer.restoreState(dropState);
        } catch {
        }
      }
    } else {
      const dropLayers = getDropLayers(
          event, manager, /*forceCopy=*/getDropEffect() === 'copy',
          /*allowMove=*/false,
          /*newTarget=*/true);
      if (dropLayers !== undefined && dropLayers.finalize(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = getDropEffect();
        endLayerDrag(event);
        const layerGroupViewer = makeLayerGroupViewer();
        for (const newLayer of dropLayers.layers.keys()) {
          layerGroupViewer.layerSpecification.add(newLayer);
        }
        try {
          layerGroupViewer.layout.restoreState(dropLayers.layoutSpec);
        } catch {
          layerGroupViewer.layout.reset();
          // Ignore error restoring layout.
        }
        return;
      }
    }
  });
  return () => {
    dropDisposer();
    overDisposer();
    leaveDisposer();
    enterDisposer();
  };
}

export class StackLayoutComponent extends RefCounted implements LayoutComponent {
  changed = new NullarySignal();

  get length () {
    return (this.element.childElementCount - 1) / 2;
  }

  private makeDropPlaceholder (refCounted: RefCounted) {
    const dropZone = document.createElement('div');
    dropZone.className = 'neuroglancer-stack-layout-drop-placeholder';
    refCounted.registerDisposer(setupDropZone(dropZone, this.viewer.layerSpecification, () => {
      const nextElement = dropZone.nextElementSibling;
      let nextChild: LayoutComponentContainer|undefined;
      if (nextElement !== null) {
        nextChild = LayoutComponentContainer.getFromElement(nextElement);
      }
      const newChild = this.insertChild({type: 'viewer', layers: []}, nextChild);
      return <LayerGroupViewer>newChild.component;
    }));
    refCounted.registerDisposer(() => {
      removeFromParent(dropZone);
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

  * [Symbol.iterator] () {
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
          {showLayerPanel: viewer.uiControlVisibility.showLayerPanel, showViewerMenu: true});
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

  get changed () { return this.container.changed; }

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
