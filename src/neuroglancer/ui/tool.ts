/**
 * @license
 * Copyright 2018 Google Inc.
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
 * @file Support for defining user-selectable tools.
 */

import './tool.css';

import debounce from 'lodash/debounce';
import {MouseSelectionState, UserLayer, UserLayerConstructor} from 'neuroglancer/layer';
import {StatusMessage} from 'neuroglancer/status';
import {TrackableValueInterface} from 'neuroglancer/trackable_value';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {ActionEvent, EventActionMap, registerActionListener} from 'neuroglancer/util/event_action_map';
import {verifyObject, verifyObjectProperty, verifyString} from 'neuroglancer/util/json';
import {AnyConstructor} from 'neuroglancer/util/mixin';
import {Signal} from 'neuroglancer/util/signal';

const TOOL_KEY_PATTERN = /^[A-Z]$/;

export type InputEventMapBinder = (eventActionMap: EventActionMap, context: RefCounted) => void;

export class ToolActivation<ToolType extends Tool = Tool> extends RefCounted {
  constructor(public tool: ToolType, public inputEventMapBinder: InputEventMapBinder) {
    super();
  }
  bindAction<Info>(action: string, listener: (event: ActionEvent<Info>) => void) {
    this.registerDisposer(registerActionListener(window, action, listener));
  }
  bindInputEventMap(inputEventMap: EventActionMap) {
    this.inputEventMapBinder(inputEventMap, this);
  }
}

export abstract class Tool<LayerType extends UserLayer = UserLayer> extends RefCounted {
  changed = new Signal();
  keyBinding: string|undefined = undefined;
  constructor(public layer: LayerType) {
    super();
  }
  get mouseState() {
    return this.layer.manager.root.layerSelectedValues.mouseState;
  }
  abstract activate(activation: ToolActivation<this>): void;
  abstract toJSON(): any;
  deactivate(): void {}
  abstract description: string;
  unbind() {
    const {layer} = this;
    const {keyBinding} = this;
    if (keyBinding !== undefined) {
      layer.toolBinder.set(keyBinding, undefined);
    }
  }
}

export abstract class LegacyTool<LayerType extends UserLayer = UserLayer> extends RefCounted {
  changed = new Signal();
  constructor(public layer: LayerType) {
    super();
  }
  get mouseState() {
    return this.layer.manager.root.layerSelectedValues.mouseState;
  }
  abstract trigger(mouseState: MouseSelectionState): void;
  abstract toJSON(): any;
  deactivate(): void {}
  abstract description: string;
  unbind() {
    const {layer} = this;
    if (layer.tool.value === this) {
      layer.tool.value = undefined;
    }
  }
}

export function restoreTool(layer: UserLayer, obj: any) {
  if (obj === undefined) {
    return undefined;
  }
  if (typeof obj === 'string') {
    obj = {'type': obj};
  }
  verifyObject(obj);
  const type = verifyObjectProperty(obj, 'type', verifyString);
  // First look for layer-specific tool.
  let getter: ToolGetter|undefined =
      layerTools.get(layer.constructor as UserLayerConstructor)?.get(type);
  if (getter === undefined) {
    // Look for layer-independent tool.
    getter = tools.get(type);
  }
  if (getter === undefined) {
    throw new Error(`Invalid tool type: ${JSON.stringify(obj)}.`);
  }
  return getter(layer, obj);
}

export function restoreLegacyTool(layer: UserLayer, obj: any) {
  if (obj === undefined) {
    return undefined;
  }
  if (typeof obj === 'string') {
    obj = {'type': obj};
  }
  verifyObject(obj);
  const type = verifyObjectProperty(obj, 'type', verifyString);
  const getter = legacyTools.get(type);
  if (getter === undefined) {
    throw new Error(`Invalid tool type: ${JSON.stringify(obj)}.`);
  }
  return getter(layer, obj);
}

export type ToolGetter<LayerType extends UserLayer = UserLayer> =
    (layer: LayerType, options: any) => Owned<Tool>|undefined;

export type LegacyToolGetter<LayerType extends UserLayer = UserLayer> =
    (layer: LayerType, options: any) => Owned<LegacyTool>|undefined;

const legacyTools = new Map<string, LegacyToolGetter>();
const tools = new Map<string, ToolGetter>();
const layerTools = new Map<UserLayerConstructor, Map<string, ToolGetter>>();

export function registerLegacyTool(type: string, getter: LegacyToolGetter) {
  legacyTools.set(type, getter);
}

export function registerTool(type: string, getter: ToolGetter) {
  tools.set(type, getter);
}

export function registerLayerTool<LayerType extends UserLayer>(
    layerType: UserLayerConstructor&AnyConstructor<LayerType>, type: string,
    getter: ToolGetter<LayerType>) {
  let tools = layerTools.get(layerType);
  if (tools === undefined) {
    tools = new Map();
    layerTools.set(layerType, tools);
  }
  tools.set(type, getter);
}

export class SelectedLegacyTool extends RefCounted implements
    TrackableValueInterface<LegacyTool|undefined> {
  changed = new Signal();
  private value_: Owned<LegacyTool>|undefined;

  get value() {
    return this.value_;
  }

  set value(newValue: Owned<LegacyTool>|undefined) {
    if (newValue === this.value_) return;
    this.unregister();
    if (newValue !== undefined) {
      newValue.changed.add(this.changed.dispatch);
      this.value_ = newValue;
    }
    this.changed.dispatch();
  }

  private unregister() {
    const existingValue = this.value_;
    if (existingValue !== undefined) {
      existingValue.changed.remove(this.changed.dispatch);
      existingValue.dispose();
      this.value_ = undefined;
    }
  }

  disposed() {
    this.unregister();
    super.disposed();
  }

  restoreState(obj: unknown) {
    this.value = restoreLegacyTool(this.layer, obj);
  }

  reset() {
    this.value = undefined;
  }

  toJSON() {
    const value = this.value_;
    if (value === undefined) return undefined;
    return value.toJSON();
  }
  constructor(public layer: UserLayer) {
    super();
  }
}

export class ToolBinder extends RefCounted {
  bindings = new Map<string, Borrowed<Tool>>();
  changed = new Signal();
  private activeTool: Owned<ToolActivation>|undefined;
  private debounceDeactivate = this.registerCancellable(debounce(() => this.deactivate(), 1));

  get(key: string): Borrowed<Tool>|undefined {
    return this.bindings.get(key);
  }

  set(key: string, tool: Owned<Tool>|undefined) {
    const {bindings} = this;
    const existingTool = bindings.get(key);
    if (existingTool !== undefined) {
      existingTool.keyBinding = undefined;
      bindings.delete(key);
      const layerToolBinder = existingTool.layer.toolBinder;
      layerToolBinder.bindings.delete(key);
      layerToolBinder.jsonToKey.delete(JSON.stringify(existingTool.toJSON()));
      this.destroyTool(existingTool);
      layerToolBinder.changed.dispatch();
    }
    if (tool !== undefined) {
      const layerToolBinder = tool.layer.toolBinder;
      const json = JSON.stringify(tool.toJSON());
      const existingKey = layerToolBinder.jsonToKey.get(json);
      if (existingKey !== undefined) {
        const existingTool = layerToolBinder.bindings.get(existingKey)!;
        existingTool.keyBinding = undefined;
        bindings.delete(existingKey);
        layerToolBinder.bindings.delete(existingKey);
        layerToolBinder.jsonToKey.delete(json);
        this.destroyTool(existingTool);
      }
      layerToolBinder.bindings.set(key, tool);
      tool.keyBinding = key;
      layerToolBinder.jsonToKey.set(json, key);
      bindings.set(key, tool);
      layerToolBinder.changed.dispatch();
    }
    this.changed.dispatch();
  }

  activate(key: string, inputEventMapBinder: InputEventMapBinder): Borrowed<Tool>|undefined {
    const tool = this.get(key);
    if (tool === undefined) {
      this.deactivate();
      return;
    }
    this.debounceDeactivate.cancel();
    if (tool === this.activeTool?.tool) {
      return;
    }
    const activation = new ToolActivation(tool, inputEventMapBinder);
    this.activeTool = activation;
    const expectedCode = `Key${key}`;
    activation.registerEventListener(window, 'keyup', (event: KeyboardEvent) => {
      if (event.code === expectedCode) {
        this.debounceDeactivate();
      }
    });
    activation.registerEventListener(window, 'blur', () => {
      this.debounceDeactivate();
    });
    tool.activate(activation);
    return tool;
  }

  destroyTool(tool: Owned<Tool>) {
    if (this.activeTool?.tool === tool) {
      this.deactivate();
    }
    tool.dispose();
  }

  disposed() {
    this.deactivate();
    super.disposed();
  }

  private deactivate() {
    this.debounceDeactivate.cancel();
    const activation = this.activeTool;
    if (activation === undefined) return;
    this.activeTool = undefined;
    activation.dispose();
  }
}

export class LayerToolBinder {
  // Maps the the tool key (i.e. "A", "B", ...) to the bound tool.
  bindings = new Map<string, Owned<Tool>>();
  // Maps the serialized json representation of the tool to the tool key.
  jsonToKey = new Map<string, string>();
  changed = new Signal();

  private get globalBinder() {
    return this.layer.manager.root.toolBinder;
  }
  constructor(public layer: UserLayer) {
    layer.registerDisposer(() => this.clear());
  }

  get(key: string): Borrowed<Tool>|undefined {
    return this.bindings.get(key);
  }

  set(key: string, tool: Owned<Tool>|undefined) {
    this.globalBinder.set(key, tool);
  }

  setJson(key: string, toolJson: any) {
    const tool = restoreTool(this.layer, toolJson);
    if (tool === undefined) return;
    this.set(key, tool);
  }

  removeJsonString(toolJsonString: string) {
    const key = this.jsonToKey.get(toolJsonString);
    if (key === undefined) return;
    this.set(key, undefined);
  }

  toJSON(): any {
    const {bindings} = this;
    if (bindings.size === 0) return undefined;
    const obj: any = {};
    for (const [key, value] of bindings) {
      obj[key] = value.toJSON();
    }
    return obj;
  }

  clear() {
    const {globalBinder, bindings} = this;
    if (bindings.size !== 0) {
      for (const [key, tool] of bindings) {
        tool.keyBinding = undefined;
        globalBinder.bindings.delete(key);
        globalBinder.destroyTool(tool);
      }
      bindings.clear();
      this.jsonToKey.clear();
      globalBinder.changed.dispatch();
      this.changed.dispatch();
    }
  }

  reset() {
    this.clear();
  }

  restoreState(obj: any) {
    if (obj === undefined) return;
    verifyObject(obj);
    for (const [key, value] of Object.entries(obj)) {
      if (!key.match(TOOL_KEY_PATTERN)) {
        throw new Error(`Invalid tool key: ${JSON.stringify(key)}`);
      }
      const tool = restoreTool(this.layer, value);
      if (tool === undefined) return;
      this.set(key, tool);
    }
  }
}

export class ToolBindingWidget<LayerType extends UserLayer> extends RefCounted {
  element = document.createElement('div');
  private toolJsonString = JSON.stringify(this.toolJson);
  constructor(public layer: LayerType, public toolJson: any) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-tool-key-binding');
    this.registerDisposer(layer.toolBinder.changed.add(
        this.registerCancellable(animationFrameDebounce(() => this.updateView()))));
    this.updateView();
    element.title = 'click → bind key, dbclick → unbind';
    element.addEventListener('dblclick', () => {
      this.layer.toolBinder.removeJsonString(this.toolJsonString);
    });
    addToolKeyBindHandlers(this, element, key => this.layer.toolBinder.setJson(key, this.toolJson));
  }

  private updateView() {
    const {toolBinder} = this.layer;
    const key = toolBinder.jsonToKey.get(this.toolJsonString);
    this.element.textContent = key ?? ' ';
  }
}

export function addToolKeyBindHandlers(
    context: RefCounted, element: HTMLElement, bindKey: (key: string) => void) {
  let mousedownContext: RefCounted|undefined;
  element.addEventListener('mousedown', event => {
    if (event.button !== 0 || mousedownContext !== undefined) return;
    event.preventDefault();
    event.stopPropagation();
    mousedownContext = new RefCounted();
    context.registerDisposer(mousedownContext);
    const message = mousedownContext.registerDisposer(new StatusMessage(false));
    message.setText('Press A-Z to bind key');
    mousedownContext.registerEventListener(window, 'keydown', (event: KeyboardEvent) => {
      const {code} = event;
      const m = code.match(/^Key([A-Z])$/);
      if (m === null) return;
      event.stopPropagation();
      event.preventDefault();
      const key = m[1];
      bindKey(key);
    }, {capture: true});
    mousedownContext.registerEventListener(window, 'mouseup', (event: MouseEvent) => {
      if (event.button !== 0 || mousedownContext === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      context.unregisterDisposer(mousedownContext);
      mousedownContext.dispose();
      mousedownContext = undefined;
    });
  });
  element.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
  });
}

export function makeToolButton(
    context: RefCounted, layer: UserLayer,
    options: {toolJson: any, label: string, title?: string}) {
  const element = document.createElement('div');
  element.classList.add('neuroglancer-tool-button');
  element.appendChild(
      context.registerDisposer(new ToolBindingWidget(layer, options.toolJson)).element);
  const labelElement = document.createElement('div');
  labelElement.classList.add('neuroglancer-tool-button-label');
  labelElement.textContent = options.label;
  if (options.title) {
    labelElement.title = options.title;
  }
  element.appendChild(labelElement);
  return element;
}

export function makeToolActivationStatusMessage(activation: ToolActivation) {
  const message = activation.registerDisposer(new StatusMessage(false));
  message.element.classList.add('neuroglancer-tool-status');
  const content = document.createElement('div');
  content.classList.add('neuroglancer-tool-status-content');
  message.element.appendChild(content);
  const {inputEventMapBinder} = activation;
  activation.inputEventMapBinder = (inputEventMap: EventActionMap, context: RefCounted) => {
    const bindingHelp = document.createElement('div');
    bindingHelp.textContent = inputEventMap.describe();
    bindingHelp.classList.add('neuroglancer-tool-status-bindings');
    message.element.appendChild(bindingHelp);
    inputEventMapBinder(inputEventMap, context);
  };
  return {message, content};
}

export function makeToolActivationStatusMessageWithHeader(activation: ToolActivation) {
  const {message, content} = makeToolActivationStatusMessage(activation);
  const header = document.createElement('div');
  header.classList.add('neuroglancer-tool-status-header');
  const headerContainer = document.createElement('div');
  headerContainer.classList.add('neuroglancer-tool-status-header-container');
  headerContainer.appendChild(header);
  content.appendChild(headerContainer);
  const body = document.createElement('div');
  body.classList.add('neuroglancer-tool-status-body');
  content.appendChild(body);
  return {message, body, header};
}
