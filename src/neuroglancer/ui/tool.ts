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
import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
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
  cancel() {
    const {globalBinder} = this.tool;
    if (this == globalBinder.activeTool_) {
      globalBinder.deactivate_();
    }
  }
}

export abstract class Tool<Context extends Object = Object> extends RefCounted {
  changed = new Signal();
  keyBinding: string|undefined = undefined;

  get context () {
    return this.localBinder.context;
  }

  get globalBinder() {
    return this.localBinder.globalBinder;
  }

  constructor(
      public readonly localBinder: LocalToolBinder<Context>, public toggle: boolean = false) {
    super();
  }
  abstract activate(activation: ToolActivation<this>): void;
  abstract toJSON(): any;
  abstract description: string;
  unbind() {
    const {keyBinding} = this;
    if (keyBinding !== undefined) {
      this.localBinder.set(keyBinding, undefined);
    }
  }
}

export abstract class LayerTool<LayerType extends UserLayer = UserLayer> extends
    Tool<LayerType> {
  constructor(public layer: LayerType, toggle: boolean = false) {
    super(layer.toolBinder, toggle);
  }
  get mouseState() {
    return this.layer.manager.root.layerSelectedValues.mouseState;
  }
}

export abstract class LegacyTool<LayerType extends UserLayer = UserLayer> extends RefCounted {
  changed = new Signal();
  constructor(public layer: LayerType) {
    super();
  }
  get context() {
    return this.layer;
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

export function restoreTool<Context extends Object>(context: Context, obj: unknown) {
  if (obj === undefined) {
    return undefined;
  }
  if (typeof obj === 'string') {
    obj = {'type': obj};
  }
  verifyObject(obj);
  const type = verifyObjectProperty(obj, 'type', verifyString);

  let prototype = context;
  let getter:ToolGetter|undefined;
  while (true) {
    prototype = Object.getPrototypeOf(prototype);
    if (prototype === null) {
      throw new Error(`Invalid tool type: ${JSON.stringify(obj)}.`);
    }
    getter = toolsForPrototype.get(prototype)?.get(type);
    if (getter !== undefined) break;
  }
  return getter(context, obj);
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

export type ToolGetter<Context extends Object = Object> =
    (context: Context, options: any) => Owned<Tool>|undefined;

export type LegacyToolGetter<LayerType extends UserLayer = UserLayer> =
    (layer: LayerType, options: any) => Owned<LegacyTool>|undefined;

const legacyTools = new Map<string, LegacyToolGetter>();
const toolsForPrototype = new Map<Object, Map<string, ToolGetter>>();

export function registerLegacyTool(type: string, getter: LegacyToolGetter) {
  legacyTools.set(type, getter);
}

export function registerTool<Context extends Object>(
  contextType: AnyConstructor<Context>, type: string, getter: ToolGetter<Context>) {
  const {prototype} = contextType;
  let tools = toolsForPrototype.get(prototype);
  if (tools === undefined) {
    tools = new Map();
    toolsForPrototype.set(prototype, tools);
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

export class GlobalToolBinder extends RefCounted {
  bindings = new Map<string, Borrowed<Tool>>();
  changed = new Signal();
  activeTool_: Owned<ToolActivation>|undefined; // For internal use only- should only be called by ToolBinder and ToolActivation.cancel()
  private queuedTool: Tool|undefined;
  private debounceDeactivate = this.registerCancellable(debounce(() => this.deactivate_(), 100));
  private debounceReactivate = this.registerCancellable(debounce(() => this.reactivateQueuedTool(), 100));

  constructor(private inputEventMapBinder: InputEventMapBinder) {
    super();
  }

  get(key: string): Borrowed<Tool>|undefined {
    return this.bindings.get(key);
  }

  set(key: string, tool: Owned<Tool>|undefined) {
    const {bindings} = this;
    const existingTool = bindings.get(key);
    if (existingTool !== undefined) {
      existingTool.keyBinding = undefined;
      bindings.delete(key);
      const localToolBinder = existingTool.localBinder;
      localToolBinder.bindings.delete(key);
      localToolBinder.jsonToKey.delete(JSON.stringify(existingTool.toJSON()));
      this.destroyTool(existingTool);
      localToolBinder.changed.dispatch();
    }
    if (tool !== undefined) {
      const localToolBinder = tool.localBinder;
      const json = JSON.stringify(tool.toJSON());
      const existingKey = localToolBinder.jsonToKey.get(json);
      if (existingKey !== undefined) {
        const existingTool = localToolBinder.bindings.get(existingKey)!;
        existingTool.keyBinding = undefined;
        bindings.delete(existingKey);
        localToolBinder.bindings.delete(existingKey);
        localToolBinder.jsonToKey.delete(json);
        this.destroyTool(existingTool);
      }
      localToolBinder.bindings.set(key, tool);
      tool.keyBinding = key;
      localToolBinder.jsonToKey.set(json, key);
      bindings.set(key, tool);
      localToolBinder.changed.dispatch();
    }
    this.changed.dispatch();
  }

  activate(key: string): Borrowed<Tool>|undefined {
    const tool = this.get(key);
    if (tool === undefined) {
      this.deactivate_();
      return;
    }
    this.debounceDeactivate.cancel();
    this.debounceReactivate.cancel();
    const activeTool = this.activeTool_;
    if (tool === activeTool?.tool) {
      if (tool.toggle) {
        this.deactivate_();
      }
      return;
    }
    else if (activeTool !== undefined) {
      if (activeTool.tool.toggle && !tool.toggle) {
        this.queuedTool = activeTool.tool;
      }
      this.deactivate_();
    }
    const activation = new ToolActivation(tool, this.inputEventMapBinder);
    this.activeTool_ = activation;
    if (!tool.toggle) {
      const expectedCode = `Key${key}`;
      activation.registerEventListener(window, 'keyup', (event: KeyboardEvent) => {
        if (event.code === expectedCode) {
          this.debounceDeactivate();
          this.debounceReactivate();
        }
      });
      activation.registerEventListener(window, 'blur', () => {
        this.debounceDeactivate();
        this.debounceReactivate();
      });
    }
    tool.activate(activation);
    return tool;
  }

  private reactivateQueuedTool() {
    if (this.queuedTool) {
      const activation = new ToolActivation(this.queuedTool, this.inputEventMapBinder);
      this.activeTool_ = activation;
      this.queuedTool.activate(activation);
      this.queuedTool = undefined;
    }
  }

  destroyTool(tool: Owned<Tool>) {
    if (this.queuedTool === tool) {
      this.queuedTool = undefined;
    }
    if (this.activeTool_?.tool === tool) {
      this.deactivate_();
    }
    tool.dispose();
  }

  disposed() {
    this.deactivate_();
    super.disposed();
  }

  deactivate_() {
    // For internal use only- should only be called by ToolBinder and ToolActivation.cancel()
    this.debounceDeactivate.cancel();
    const activation = this.activeTool_;
    if (activation === undefined) return;
    this.activeTool_ = undefined;
    activation.dispose();
  }
}

export class LocalToolBinder<Context extends Object = Object> extends RefCounted {
  // Maps the the tool key (i.e. "A", "B", ...) to the bound tool.
  bindings = new Map<string, Owned<Tool>>();
  // Maps the serialized json representation of the tool to the tool key.
  jsonToKey = new Map<string, string>();
  changed = new Signal();

  constructor(public context: Context, public globalBinder: GlobalToolBinder) {
    super();
  }

  disposed() {
    this.clear();
    super.disposed();
  }

  get(key: string): Borrowed<Tool>|undefined {
    return this.bindings.get(key);
  }

  set(key: string, tool: Owned<Tool>|undefined) {
    this.globalBinder.set(key, tool);
  }

  setJson(key: string, toolJson: any) {
    const tool = restoreTool(this.context, toolJson);
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
      const tool = restoreTool(this.context, value);
      if (tool === undefined) return;
      this.set(key, tool);
    }
  }
}

export class ToolBindingWidget<Context extends Object> extends RefCounted {
  element = document.createElement('div');
  private toolJsonString = JSON.stringify(this.toolJson);
  constructor(public localBinder: LocalToolBinder<Context>, public toolJson: any) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-tool-key-binding');
    this.registerDisposer(localBinder.changed.add(
        this.registerCancellable(animationFrameDebounce(() => this.updateView()))));
    this.updateView();
    element.title = 'click → bind key, dbclick → unbind';
    element.addEventListener('dblclick', () => {
      this.localBinder.removeJsonString(this.toolJsonString);
    });
    addToolKeyBindHandlers(this, element, key => this.localBinder.setJson(key, this.toolJson));
  }

  private updateView() {
    const {localBinder} = this;
    const key = localBinder.jsonToKey.get(this.toolJsonString);
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
    context: RefCounted, localBinder: LocalToolBinder,
    options: {toolJson: any, label?: string, title?: string}) {
  const element = document.createElement('div');
  element.classList.add('neuroglancer-tool-button');
  element.appendChild(
      context.registerDisposer(new ToolBindingWidget(localBinder, options.toolJson)).element);
  const labelElement = document.createElement('div');
  labelElement.classList.add('neuroglancer-tool-button-label');
  const labelText = options.label
  if (labelText !== undefined) {
    labelElement.textContent = labelText;
  }
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
