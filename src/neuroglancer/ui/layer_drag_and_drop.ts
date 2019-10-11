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

import {LayerListSpecification, ManagedUserLayer} from 'neuroglancer/layer';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {decodeParametersFromDragTypeList, DragInfo, encodeParametersAsDragType, setDropEffect} from 'neuroglancer/util/drag_and_drop';
import {parseArray, verifyBoolean, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';

const layerDragTypePrefix = 'neuroglancer-layer\0';

export interface LayerDragSourceInfo {
  manager: Owned<LayerListSpecification>;
  layers: Owned<ManagedUserLayer>[];
  layoutSpec: any;
}

interface LayerDragSourceData extends LayerDragSourceInfo {
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
    disposer,
  };
}

export function endLayerDrag(event?: DragEvent) {
  if (dragSource !== undefined) {
    if (event && event.dataTransfer!.dropEffect === 'move') {
      const removedLayers = new Set(dragSource.layers);
      dragSource.manager.layerManager.filter((x: ManagedUserLayer) => !removedLayers.has(x));
    }
    dragSource.disposer();
  }
}


export function getLayerDragInfo(event: DragEvent): DragInfo|undefined {
  return decodeParametersFromDragTypeList(event.dataTransfer!.types, layerDragTypePrefix);
}

function getCompatibleDragSource(manager: Borrowed<LayerListSpecification>): LayerDragSourceInfo|
    undefined {
  if (dragSource !== undefined && dragSource.manager.rootLayers === manager.rootLayers) {
    return dragSource;
  }
  return undefined;
}

export class DropLayers {
  dragType: string|undefined;

  sourceManager: Borrowed<LayerListSpecification>|undefined;

  moveSupported: boolean;

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
  finalize(event: DragEvent): boolean {
    const {dragType} = this;
    if (dragType !== undefined) {
      try {
        const {layers: spec, layout} = JSON.parse(event.dataTransfer!.getData(dragType));
        if (!Array.isArray(spec) || this.numSourceLayers !== spec.length) {
          throw new Error('Invalid layer drop data');
        }
        this.layoutSpec = layout;
        for (const [layer, index] of this.layers) {
          this.manager.initializeLayerFromSpec(layer, spec[index]);
        }
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  get method() {
    if (this.sourceManager !== undefined) {
      if (this.manager === this.sourceManager) {
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
    if (!this.moveSupported && otherMethod === 'move') {
      return true;
    }
    return false;
  }
}

export function getDefaultLayerDropEfect(
    manager: Borrowed<LayerListSpecification>, newTarget = false) {
  const source = getCompatibleDragSource(manager);
  if (source === undefined) {
    return 'copy';
  }
  if (!newTarget && source.manager === manager) {
    return 'move';
  }
  return 'link';
}

export function getLayerDropEffect(
    event: DragEvent, manager: Borrowed<LayerListSpecification>, newTarget = false): 'move'|'copy'|
    'link' {
  if (event.shiftKey) {
    return 'copy';
  } else if (event.ctrlKey) {
    return 'move';
  } else {
    return getDefaultLayerDropEfect(manager, newTarget);
  }
}

export function updateLayerDropEffect(
    event: DragEvent, manager: Borrowed<LayerListSpecification>, newTarget = false): 'move'|'copy'|
    'link' {
  return setDropEffect(event, getLayerDropEffect(event, manager, newTarget));
}

export function getDropLayers(
    event: DragEvent, manager: Borrowed<LayerListSpecification>, forceCopy: boolean,
    allowMove: boolean, newTarget: boolean): DropLayers|undefined {
  const source = getCompatibleDragSource(manager);
  const moveSupported = !newTarget && source !== undefined && source.manager === manager;
  if (!forceCopy) {
    if (source !== undefined) {
      const result = new DropLayers();
      result.manager = manager;
      result.numSourceLayers = source.layers.length;
      result.sourceManager = source.manager;
      result.moveSupported = moveSupported;
      result.layers = new Map();
      result.layoutSpec = source.layoutSpec;
      if (!newTarget && source.manager === manager) {
        if (allowMove) {
          source.layers.forEach((layer, index) => {
            result.layers.set(layer, index);
          });
        } else {
          return undefined;
        }
      }
      source.layers.forEach((layer, index) => {
        if (newTarget || !manager.layerManager.has(layer)) {
          result.layers.set(layer.addRef(), index);
        }
      });
      return result;
    }
  }
  const info = getLayerDragInfo(event);
  if (info !== undefined) {
    try {
      const layers = parseArray(info.parameters, (layerInfo, index) => {
        const name = verifyObjectProperty(layerInfo, 'name', verifyString);
        const visible = verifyObjectProperty(layerInfo, 'visible', verifyBoolean);
        const newLayer = new ManagedUserLayer(name, null, manager);
        newLayer.visible = visible;
        return <[ManagedUserLayer, number]>[newLayer, index];
      });
      const result = new DropLayers();
      result.numSourceLayers = layers.length;
      result.moveSupported = moveSupported;
      result.manager = manager;
      result.dragType = info.dragType;
      result.layers = new Map(layers);
      return result;
    } catch {
    }
  }
  return undefined;
}
