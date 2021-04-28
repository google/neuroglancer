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

import {initializeLayerFromSpecShowErrorStatus, LayerListSpecification, ManagedUserLayer} from 'neuroglancer/layer';
import {popDragStatus, pushDragStatus} from 'neuroglancer/ui/drag_and_drop';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {decodeParametersFromDragTypeList, DragInfo, encodeParametersAsDragType, getDropEffect, setDropEffect} from 'neuroglancer/util/drag_and_drop';
import {parseArray, verifyBoolean, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';

const layerDragTypePrefix = 'neuroglancer-layer\0';

export interface LayerDragSourceInfo {
  manager: Owned<LayerListSpecification>;
  layers: Owned<ManagedUserLayer>[];
  layoutSpec: any;
  isLayerListPanel?: boolean;
}

interface LayerDragSourceData extends LayerDragSourceInfo {
  isLayerListPanel: boolean;
  disposer: () => void;
}

let dragSource: LayerDragSourceData|undefined;

export function startLayerDrag(event: DragEvent, sourceInfo: LayerDragSourceInfo) {
  event.dataTransfer!.setData(
      encodeParametersAsDragType(
          layerDragTypePrefix,
          sourceInfo.layers.map(layer => ({name: layer.name, visible: layer.visible}))),
      JSON.stringify(
          {layers: sourceInfo.layers.map(layer => layer.toJSON()), layout: sourceInfo.layoutSpec}));
  if (dragSource !== undefined) {
    dragSource.disposer();
  }
  let newDragSource: LayerDragSourceData;
  let disposer = () => {
    sourceInfo.manager.unregisterDisposer(disposer);
    for (const layer of sourceInfo.layers) {
      layer.dispose();
    }
    sourceInfo.manager.dispose();
    if (dragSource === newDragSource) {
      dragSource = undefined;
    }
  };
  dragSource = newDragSource = {
    manager: sourceInfo.manager.addRef(),
    layers: sourceInfo.layers.map(x => x.addRef()),
    layoutSpec: sourceInfo.layoutSpec,
    isLayerListPanel: sourceInfo.isLayerListPanel ?? false,
    disposer,
  };
}

export function endLayerDrag(dropEffect: string = 'none') {
  if (dragSource !== undefined) {
    if (dropEffect === 'move') {
      // Remove source layers since they have been moved.
      const removedLayers = new Set(dragSource.layers);
      dragSource.manager.layerManager.filter((x: ManagedUserLayer) => !removedLayers.has(x));
    }
    dragSource.disposer();
  }
}


export function getLayerDragInfo(event: DragEvent): DragInfo|undefined {
  return decodeParametersFromDragTypeList(event.dataTransfer!.types, layerDragTypePrefix);
}

function getCompatibleDragSource(manager: Borrowed<LayerListSpecification>): LayerDragSourceData|
    undefined {
  if (dragSource !== undefined && dragSource.manager.rootLayers === manager.rootLayers) {
    return dragSource;
  }
  return undefined;
}

export class DropLayers {
  // If the layers are from another window, this set to the drag type (starting with
  // `layerDragTypePrefix`) that encodes the layer names and visible state.  If the layers
  // are from this same Neuroglancer instance, set to undefined.
  dragType: string|undefined;

  targetIsLayerListPanel: boolean;

  sourceManager: Borrowed<LayerListSpecification>|undefined;
  sourceIsLayerListPanel: boolean;

  moveSupported: boolean;
  forceCopy: boolean;

  manager: Borrowed<LayerListSpecification>;

  // Maps each layer to its index in the specification.
  layers: Map<Owned<ManagedUserLayer>, number>;

  numSourceLayers: number;

  // LayerGroupViewer layout specification associated with these layers.  Only used if the drop
  // operation creates a new layer group viewer.
  layoutSpec: any;

  /**
   * Called in the 'drop' event handler to actually initialize the layers if they are external.
   * Returns false if any layers failed to initialized.
   */
  initializeExternalLayers(event: DragEvent): boolean {
    const {dragType} = this;
    if (dragType !== undefined) {
      try {
        const {layers: spec, layout} = JSON.parse(event.dataTransfer!.getData(dragType));
        if (!Array.isArray(spec) || this.numSourceLayers !== spec.length) {
          throw new Error('Invalid layer drop data');
        }
        this.layoutSpec = layout;
        for (const [layer, index] of this.layers) {
          initializeLayerFromSpecShowErrorStatus(layer, spec[index]);
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  updateArchiveStates(event: DragEvent) {
    // If archived === false (i.e. drop target is a layer bar or new layer group location), set
    // all layers as non-archived, since those drop targets can only contain non-archived layers.
    //
    // If archived === true, drop target is the layer list panel.  If the layer would not be
    // logically present in any layer groups, set it to archived.
    const {targetIsLayerListPanel} = this;
    const dropEffect = event.dataTransfer!.dropEffect;
    for (const layer of this.layers.keys()) {
      let shouldBeArchived = targetIsLayerListPanel;
      if (targetIsLayerListPanel && !layer.archived && dropEffect !== 'copy') {
        if (this.sourceIsLayerListPanel) {
          shouldBeArchived = false;
        }
      }
      if (layer.archived !== shouldBeArchived || (shouldBeArchived && layer.visible)) {
        layer.archived = shouldBeArchived;
        if (shouldBeArchived) layer.visible = false;
        layer.layerChanged.dispatch();
      }
    }
  }

  get method() {
    if (this.sourceManager !== undefined) {
      if (this.manager === this.sourceManager &&
          (this.sourceIsLayerListPanel === this.targetIsLayerListPanel)) {
        return 'move';
      } else {
        return 'link';
      }
    } else {
      return 'copy';
    }
  }

  compatibleWithMethod(otherMethod: string) {
    if (this.method === otherMethod) {
      return true;
    }
    if (this.forceCopy && otherMethod !== 'copy') {
      return false;
    }
    if (!this.moveSupported && otherMethod === 'move') {
      return true;
    }
    return false;
  }
}

type LayerDropEffect =  'none'| 'move'|'copy'|'link';

export function getDropEffectFromModifiers<DropEffect extends string>(
  event: DragEvent, defaultDropEffect: DropEffect, moveAllowed: boolean): {dropEffect: DropEffect|'move'|'copy', dropEffectMessage: string} {
  let dropEffect: DropEffect | 'move'|'copy';
  if (event.shiftKey) {
    dropEffect = 'copy';
  } else if (event.ctrlKey && moveAllowed) {
    dropEffect = 'move';
  } else {
    dropEffect = defaultDropEffect;
  }
  let message = '';
  const addMessage = (msg: string) => {
    if (message !== '') {
      message += ', ';
    }
    message += msg;
  };
  if (defaultDropEffect !== 'none' && dropEffect !== defaultDropEffect) {
    if (event.shiftKey) {
      addMessage(`release SHIFT to ${defaultDropEffect}`);
    } else {
      addMessage(`release CONTROL to ${defaultDropEffect}`);
    }
  }
  if (dropEffect !== 'copy') {
    addMessage('hold SHIFT to copy');
  }
  if (dropEffect !== 'move' && moveAllowed && defaultDropEffect !== 'move') {
    addMessage('hold CONTROL to move');
  }
  return {dropEffect, dropEffectMessage: message};
}

export function getLayerDropEffect(
    event: DragEvent, manager: Borrowed<LayerListSpecification>, targetIsLayerListPanel: boolean,
  newTarget: boolean): {dropEffect: LayerDropEffect, dropEffectMessage: string} {
  const source = getCompatibleDragSource(manager);
  let moveAllowed = false;
  let defaultDropEffect:LayerDropEffect;
  if (source === undefined) {
    defaultDropEffect = 'copy';
  } else {
    if (newTarget) {
      // We cannot "move" layers out of the layer list panel.
      if (!source.isLayerListPanel) {
        moveAllowed = true;
      }
      defaultDropEffect = 'link';
    } else {
      if (source.manager === manager && source.isLayerListPanel === targetIsLayerListPanel) {
        defaultDropEffect = 'move';
        moveAllowed = true;
      } else if (targetIsLayerListPanel) {
        defaultDropEffect = 'none';
      } else if (source.isLayerListPanel) {
        defaultDropEffect = 'link';
      } else {
        moveAllowed = true;
        defaultDropEffect = 'link';
      }
    }
  }
  return getDropEffectFromModifiers(event, defaultDropEffect, moveAllowed);
}

export function updateLayerDropEffect(
    event: DragEvent, manager: Borrowed<LayerListSpecification>, targetIsLayerListPanel: boolean,
    newTarget: boolean): {dropEffect: LayerDropEffect, dropEffectMessage: string} {
  const result = getLayerDropEffect(event, manager, targetIsLayerListPanel, newTarget);
  setDropEffect(event, result.dropEffect);
  return result;
}

export interface GetDropLayersOptions {
  // Indicates that the user specifically requested copying.  This ensures that a copy-compatible
  // DropLayers object will be returned.
  forceCopy: boolean;

  // Indicates that the `manager` is not the actual target, but instead a new layer group will be
  // created to hold the dropped layers.
  newTarget: boolean;

  // Indicates that the target is the layer list panel.  New layers that are dropped will be
  // archived.
  isLayerListPanel?: boolean;
}

export function getDropLayers(
    event: DragEvent, manager: Borrowed<LayerListSpecification>,
  options: GetDropLayersOptions): DropLayers|undefined {
  const {forceCopy, newTarget, isLayerListPanel = false} = options;
  const source = getCompatibleDragSource(manager);
  if (!forceCopy && source !== undefined) {
    const moveSupported = !newTarget && source.manager === manager &&
        (source.isLayerListPanel === isLayerListPanel || source.isLayerListPanel);
    const result = new DropLayers();
    result.manager = manager;
    result.numSourceLayers = source.layers.length;
    result.sourceManager = source.manager;
    result.targetIsLayerListPanel = isLayerListPanel;
    result.sourceIsLayerListPanel = source.isLayerListPanel;
    result.moveSupported = moveSupported;
    result.layers = new Map();
    result.forceCopy = false;
    result.layoutSpec = source.layoutSpec;
    if (moveSupported) {
      source.layers.forEach((layer, index) => {
        result.layers.set(layer, index);
      });
    } else {
      source.layers.forEach((layer, index) => {
        if (newTarget || !manager.layerManager.has(layer)) {
          result.layers.set(layer.addRef(), index);
        }
      });
    }
    return result;
  }
  const info = getLayerDragInfo(event);
  if (info !== undefined) {
    try {
      const layers = parseArray(info.parameters, (layerInfo, index) => {
        const name = verifyObjectProperty(layerInfo, 'name', verifyString);
        let visible = verifyObjectProperty(layerInfo, 'visible', verifyBoolean);
        const newLayer = new ManagedUserLayer(name, manager);
        if (isLayerListPanel) visible = false;
        newLayer.visible = visible;
        newLayer.archived = isLayerListPanel;
        return [newLayer, index] as [ManagedUserLayer, number];
      });
      const result = new DropLayers();
      result.numSourceLayers = layers.length;
      result.targetIsLayerListPanel = isLayerListPanel;
      result.sourceIsLayerListPanel = false;
      result.sourceManager = undefined;
      result.moveSupported = false;
      result.forceCopy = source !== undefined;
      result.manager = manager;
      result.dragType = info.dragType;
      result.layers = new Map(layers);
      return result;
    } catch {
    }
  }
  return undefined;
}

function destroyDropLayers(dropLayers: DropLayers, targetLayer?: ManagedUserLayer) {
  if (dropLayers.moveSupported) {
    // Nothing to do.
    return false;
  }
  dropLayers.manager.layerManager.filter(layer => !dropLayers.layers.has(layer));
  return targetLayer !== undefined && dropLayers.layers.has(targetLayer);
}

export interface LayerBarDropInterface {
  element: HTMLElement;
  manager: LayerListSpecification;
  dropLayers: DropLayers|undefined;
  dragEnterCount: number;
}

export function registerLayerBarDropHandlers(
    panel: LayerBarDropInterface, target: EventTarget, targetLayer: ManagedUserLayer|undefined,
    isLayerListPanel = false) {
  function update(event: DragEvent, updateDropEffect: boolean): {dropLayers: DropLayers, dropEffect: LayerDropEffect, dropEffectMessage: string}|undefined {
    let dropLayers = panel.dropLayers;
    const {dropEffect, dropEffectMessage} = updateDropEffect ?
        getLayerDropEffect(event, panel.manager, isLayerListPanel, /*newTarget=*/ false) :
        {dropEffect: getDropEffect() as LayerDropEffect, dropEffectMessage: ''};
    if (dropEffect === undefined) return undefined;
    setDropEffect(event, dropEffect);
    let existingDropLayers = true;
    if (dropLayers !== undefined) {
      if (!dropLayers.compatibleWithMethod(dropEffect)) {
        panel.dropLayers = undefined;
        if (destroyDropLayers(dropLayers, targetLayer)) {
          // We destroyed the layer for which we received the dragenter event.  Wait until we get
          // another dragenter or drop event to do something.
          return undefined;
        }
      }
    }
    if (dropLayers === undefined) {
      dropLayers = panel.dropLayers = getDropLayers(
          event, panel.manager,
          {forceCopy: dropEffect === 'copy', newTarget: false, isLayerListPanel});
      if (dropLayers === undefined) {
        return undefined;
      }
      existingDropLayers = dropLayers.method === 'move';
    }
    if (targetLayer !== undefined && dropLayers.layers.has(targetLayer)) {
      // Dragged onto itself, nothing to do.
      return {dropLayers, dropEffect, dropEffectMessage};
    }
    if (!existingDropLayers) {
      let newIndex: number|undefined;
      if (targetLayer !== undefined) {
        newIndex = panel.manager.layerManager.managedLayers.indexOf(targetLayer);
      }
      for (const newLayer of dropLayers.layers.keys()) {
        panel.manager.add(newLayer, newIndex);
      }
    } else {
      // Rearrange layers.
      const {layerManager} = panel.manager;
      const existingLayers = new Set<ManagedUserLayer>();
      let firstRemovalIndex = Number.POSITIVE_INFINITY;
      const managedLayers = layerManager.managedLayers =
          layerManager.managedLayers.filter((x: ManagedUserLayer, index) => {
            if (dropLayers!.layers.has(x)) {
              if (firstRemovalIndex === Number.POSITIVE_INFINITY) {
                firstRemovalIndex = index;
              }
              existingLayers.add(x);
              return false;
            } else {
              return true;
            }
          });
      let newIndex: number;
      if (targetLayer !== undefined) {
        newIndex = managedLayers.indexOf(targetLayer);
        if (firstRemovalIndex <= newIndex) {
          ++newIndex;
        }
      } else {
        newIndex = managedLayers.length;
      }
      // Filter out layers that have been concurrently removed.
      for (const layer of dropLayers.layers.keys()) {
        if (!existingLayers.has(layer)) {
          dropLayers.layers.delete(layer);
        }
      }
      managedLayers.splice(newIndex, 0, ...dropLayers.layers.keys());
      layerManager.layersChanged.dispatch();
    }
    return {dropLayers,dropEffect,dropEffectMessage};
  }
  target.addEventListener('dragenter', (event: DragEvent) => {
    if (update(event, /*updateDropEffect=*/ true) !== undefined) {
      event.preventDefault();
    } else {
      popDragStatus(panel.element, 'drop');
    }
  });
  target.addEventListener('drop', (event: DragEvent) => {
    event.preventDefault();
    panel.dragEnterCount = 0;
    popDragStatus(panel.element, 'drop');
    const dropLayers = update(event, /*updateDropEffect=*/ false)?.dropLayers;
    panel.dropLayers = undefined;
    if (dropLayers === undefined) return;
    if (!dropLayers.initializeExternalLayers(event)) {
      destroyDropLayers(dropLayers);
      return;
    }
    dropLayers.updateArchiveStates(event);
    endLayerDrag(dropLayers.method === 'move' ? undefined : event.dataTransfer!.dropEffect);
  });
  target.addEventListener('dragover', (event: DragEvent) => {
    const updateResult = update(event, /*updateDropEffect=*/ true);
    if (updateResult === undefined) {
      popDragStatus(panel.element, 'drop');
      return;
    }
    const {dropLayers, dropEffect, dropEffectMessage} = updateResult;
    const numLayers = dropLayers.layers.size;
    let message = '';
    const maybePlural = dropLayers.numSourceLayers === 1 ? '' : 's';
    const numSourceLayers = dropLayers.numSourceLayers;
    if (dropEffect === 'none') {
      message = `Cannot link dragged layer${maybePlural} here`;
    } else {
    const layerCountMessage = numSourceLayers === numLayers ? `${numSourceLayers}` : `${numLayers}/${numSourceLayers}`;
      message = `Drop to ${dropEffect} ${layerCountMessage} layer${maybePlural}`
    }
    if (dropEffectMessage) {
      message += ` (${dropEffectMessage})`;
    }
    pushDragStatus(panel.element, 'drop', message);
    event.preventDefault();
    event.stopPropagation();
  });
}

export function registerLayerDragHandlers(
    panel: LayerBarDropInterface, element: HTMLElement, layer: ManagedUserLayer,
    options: {getLayoutSpec: () => any, isLayerListPanel?: boolean}) {
  element.draggable = true;
  element.addEventListener('dragstart', (event: DragEvent) => {
    pushDragStatus(
        element, 'drag',
        'Drag layer to another layer bar/panel (including in another Neuroglancer window), ' +
            'or to the left/top/right/bottom edge of a layer group');
    startLayerDrag(event, {
      manager: panel.manager,
      layers: [layer],
      layoutSpec: options.getLayoutSpec(),
      isLayerListPanel: options.isLayerListPanel
    });
    event.stopPropagation();
  });
  element.addEventListener('dragend', () => {
    popDragStatus(element, 'drag');
    // This call to endLayerDrag is a no-op if a drag was completed successfully within the same
    // browser window, because it will already have been called by the `drop` handler.  This call
    // has an effect only for a cancelled drag or a successful cross-browser window drag.
    // Cross-browser window drags are always `copy` operations because Chrome does not properly
    // communicate the drag effect, so there is no way to signal a `move`.
    //
    // https://bugs.chromium.org/p/chromium/issues/detail?id=39399
    endLayerDrag();
  });
}

export function registerLayerBarDragLeaveHandler(panel: LayerBarDropInterface) {
  panel.element.addEventListener('dragenter', () => {
    ++panel.dragEnterCount;
  });
  panel.element.addEventListener('dragleave', () => {
    if (--panel.dragEnterCount !== 0) return;
    popDragStatus(panel.element, 'drop');
    const {dropLayers} = panel;
    if (dropLayers !== undefined) {
      destroyDropLayers(dropLayers);
      panel.manager.layerManager.layersChanged.dispatch();
      panel.dropLayers = undefined;
    }
  });
}
