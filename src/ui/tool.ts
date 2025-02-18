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

import "#src/ui/tool.css";

import { debounce } from "lodash-es";
import type { MouseSelectionState, UserLayer } from "#src/layer/index.js";
import { StatusMessage } from "#src/status.js";
import type { TrackableValueInterface } from "#src/trackable_value.js";
import { popDragStatus, pushDragStatus } from "#src/ui/drag_and_drop.js";
import type { ToolDragSource } from "#src/ui/tool_drag_and_drop.js";
import { beginToolDrag, endToolDrag } from "#src/ui/tool_drag_and_drop.js";
import type {
  MultiToolPaletteState,
  ToolPalettePanel,
} from "#src/ui/tool_palette.js";
import type { Query, QueryTerm } from "#src/ui/tool_query.js";
import { matchesTerms, matchPredicate } from "#src/ui/tool_query.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import type { Borrowed, Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { getDropEffectFromModifiers } from "#src/util/drag_and_drop.js";
import type {
  ActionEvent,
  EventActionMap,
} from "#src/util/event_action_map.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import type { AnyConstructor } from "#src/util/mixin.js";
import { Signal } from "#src/util/signal.js";

const TOOL_KEY_PATTERN = /^[A-Z]$/;

export type InputEventMapBinder = (
  eventActionMap: EventActionMap,
  context: RefCounted,
) => void;

export class ToolActivation<ToolType extends Tool = Tool> extends RefCounted {
  constructor(
    public tool: ToolType,
    public inputEventMapBinder: InputEventMapBinder,
  ) {
    super();
  }
  bindAction<Info>(
    action: string,
    listener: (event: ActionEvent<Info>) => void,
  ) {
    this.registerDisposer(registerActionListener(window, action, listener));
  }
  bindInputEventMap(inputEventMap: EventActionMap) {
    this.inputEventMapBinder(inputEventMap, this);
  }
  cancel() {
    const { globalBinder } = this.tool;
    if (this === globalBinder.activeTool_) {
      globalBinder.deactivate_();
    }
  }
}

export abstract class Tool<Context extends object = object> extends RefCounted {
  changed = new Signal();
  unbound = new Signal();

  keyBinding: string | undefined = undefined;
  savedJsonString: string | undefined = undefined;

  get context() {
    return this.localBinder.context;
  }

  get globalBinder() {
    return this.localBinder.globalBinder;
  }

  constructor(
    public readonly localBinder: LocalToolBinder<Context>,
    public toggle = false,
  ) {
    super();
  }
  abstract activate(activation: ToolActivation<this>): void;
  renderInPalette(context: RefCounted): HTMLElement | undefined {
    context;
    return undefined;
  }

  abstract toJSON(): any;
  abstract description: string;
  unbind() {
    const { keyBinding } = this;
    if (keyBinding !== undefined) {
      this.localBinder.set(keyBinding, undefined);
    }
    this.unbound.dispatch();
  }
}

export abstract class LayerTool<
  LayerType extends UserLayer = UserLayer,
> extends Tool<LayerType> {
  constructor(
    public layer: LayerType,
    toggle = false,
  ) {
    super(layer.toolBinder, toggle);
  }
  get mouseState() {
    return this.layer.manager.root.layerSelectedValues.mouseState;
  }
}

export abstract class LegacyTool<
  LayerType extends UserLayer = UserLayer,
> extends RefCounted {
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
    const { layer } = this;
    if (layer.tool.value === this) {
      layer.tool.value = undefined;
    }
  }
}

export function restoreTool<Context extends object>(
  context: Context,
  obj: unknown,
) {
  if (obj === undefined) {
    return undefined;
  }
  if (typeof obj === "string") {
    obj = { type: obj };
  }
  verifyObject(obj);
  const type = verifyObjectProperty(obj, "type", verifyString);

  let prototype = context;
  let getter: ToolGetter | undefined;
  while (true) {
    prototype = Object.getPrototypeOf(prototype);
    if (prototype === null) {
      return undefined;
    }
    getter = toolsForPrototype.get(prototype)?.get(type)?.getter;
    if (getter !== undefined) break;
  }
  return getter(context, obj);
}

export function restoreLegacyTool(layer: UserLayer, obj: any) {
  if (obj === undefined) {
    return undefined;
  }
  if (typeof obj === "string") {
    obj = { type: obj };
  }
  verifyObject(obj);
  const type = verifyObjectProperty(obj, "type", verifyString);
  const getter = legacyTools.get(type);
  if (getter === undefined) {
    throw new Error(`Invalid tool type: ${JSON.stringify(obj)}.`);
  }
  return getter(layer, obj);
}

export type ToolGetter<Context extends object = object> = (
  context: Context,
  options: any,
) => Owned<Tool> | undefined;

export type ToolLister<Context extends object = object> = (
  context: Context,
  onChange?: () => void,
) => any[];

export type LegacyToolGetter<LayerType extends UserLayer = UserLayer> = (
  layer: LayerType,
  options: any,
) => Owned<LegacyTool> | undefined;

const legacyTools = new Map<string, LegacyToolGetter>();
const toolsForPrototype = new Map<
  object,
  Map<string, { getter: ToolGetter; lister: ToolLister | undefined }>
>();

export function registerLegacyTool(type: string, getter: LegacyToolGetter) {
  legacyTools.set(type, getter);
}

export function registerTool<Context extends object>(
  contextType: AnyConstructor<Context>,
  type: string,
  getter: ToolGetter<Context>,
  lister?: ToolLister<Context>,
) {
  const { prototype } = contextType;
  let tools = toolsForPrototype.get(prototype);
  if (tools === undefined) {
    tools = new Map();
    toolsForPrototype.set(prototype, tools);
  }
  tools.set(type, { getter, lister });
}

export class SelectedLegacyTool
  extends RefCounted
  implements TrackableValueInterface<LegacyTool | undefined>
{
  changed = new Signal();
  private value_: Owned<LegacyTool> | undefined;

  get value() {
    return this.value_;
  }

  set value(newValue: Owned<LegacyTool> | undefined) {
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
  activeTool_: Owned<ToolActivation> | undefined; // For internal use only- should only be called by ToolBinder and ToolActivation.cancel()
  private queuedTool: Tool | undefined;
  private debounceDeactivate = this.registerCancellable(
    debounce(() => {
      this.deactivate_();
      this.reactivateQueuedTool();
    }, 100),
  );

  localBinders = new Set<LocalToolBinder>();
  localBindersChanged = new Signal();

  constructor(
    private inputEventMapBinder: InputEventMapBinder,
    public toolPaletteState: MultiToolPaletteState,
  ) {
    super();
  }

  get(key: string): Borrowed<Tool> | undefined {
    return this.bindings.get(key);
  }

  private deleteBinding(tool: Tool) {
    const keyBinding = tool.keyBinding!;
    tool.keyBinding = undefined;
    this.bindings.delete(keyBinding);
    const localToolBinder = tool.localBinder;
    localToolBinder.bindings.delete(keyBinding);
    const { jsonToKey } = localToolBinder;
    const { savedJsonString } = tool;
    if (jsonToKey.get(savedJsonString!) === keyBinding) {
      jsonToKey.delete(savedJsonString!);
    }
    this.destroyTool(tool);
  }

  private toolJsonMaybeChanged(tool: Tool) {
    // Check if tool is still bound.
    let { keyBinding } = tool;
    if (keyBinding === undefined) return;
    let newJson = JSON.stringify(tool.toJSON());
    if (newJson === tool.savedJsonString) return;

    const localToolBinder = tool.localBinder;
    localToolBinder.jsonToKey.delete(tool.savedJsonString!);

    // In the case of `DimensionTool`, there may be a chain of bindings that
    // have to be updated.
    while (true) {
      const nextKeyBinding = localToolBinder.jsonToKey.get(newJson);
      localToolBinder.jsonToKey.set(newJson, keyBinding!);
      tool.savedJsonString = newJson;
      keyBinding = nextKeyBinding;
      if (keyBinding === undefined) {
        // End of chain, all conflicts resolved.
        break;
      }
      tool = localToolBinder.bindings.get(keyBinding)!;
      const nextJson = JSON.stringify(tool.toJSON());
      if (nextJson === newJson) {
        // End of chain, conflict remains.
        this.deleteBinding(tool);
        break;
      }
      newJson = nextJson;
    }
    localToolBinder.changed.dispatch();
    this.changed.dispatch();
  }

  set(key: string, tool: Owned<Tool> | undefined) {
    const { bindings } = this;
    const existingTool = bindings.get(key);
    if (existingTool !== undefined) {
      this.deleteBinding(existingTool);
      existingTool.localBinder.changed.dispatch();
    }
    if (tool !== undefined) {
      const localToolBinder = tool.localBinder;
      const json = JSON.stringify(tool.toJSON());
      tool.savedJsonString = json;
      const existingKey = localToolBinder.jsonToKey.get(json);
      if (existingKey !== undefined) {
        const existingTool = localToolBinder.bindings.get(existingKey)!;
        this.deleteBinding(existingTool);
      }
      localToolBinder.bindings.set(key, tool);
      tool.keyBinding = key;
      localToolBinder.jsonToKey.set(json, key);
      bindings.set(key, tool);
      localToolBinder.changed.dispatch();
      tool.changed.add(() => {
        this.toolJsonMaybeChanged(tool);
      });
    }
    this.changed.dispatch();
  }

  activate(key: string): Borrowed<Tool> | undefined {
    const tool = this.get(key);
    if (tool === undefined) {
      this.deactivate_();
      return;
    }
    this.debounceDeactivate.cancel();
    const activeTool = this.activeTool_;
    if (tool === activeTool?.tool) {
      if (tool.toggle) {
        this.deactivate_();
      }
      return;
    }
    if (activeTool !== undefined) {
      if (activeTool.tool.toggle && !tool.toggle) {
        this.queuedTool = activeTool.tool;
      }
      this.deactivate_();
    }
    const activation = new ToolActivation(tool, this.inputEventMapBinder);
    this.activeTool_ = activation;
    if (!tool.toggle) {
      const expectedCode = `Key${key}`;
      activation.registerEventListener(
        window,
        "keydown",
        (event: KeyboardEvent) => {
          // Prevent other key input while tool is activated.  This
          // prevents `shift+key` from being interpreted as text input
          // if an input element becomes focused.
          event.stopPropagation();
          event.preventDefault();
        },
      );
      activation.registerEventListener(
        window,
        "keyup",
        (event: KeyboardEvent) => {
          if (event.code === expectedCode) {
            this.debounceDeactivate();
          }
        },
      );
      activation.registerEventListener(window, "blur", () => {
        this.debounceDeactivate();
      });
    }
    tool.activate(activation);
    return tool;
  }

  private reactivateQueuedTool() {
    if (this.queuedTool) {
      const activation = new ToolActivation(
        this.queuedTool,
        this.inputEventMapBinder,
      );
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
    for (const tool of this.bindings.values()) {
      tool.dispose();
    }
  }

  deactivate_() {
    // For internal use only- should only be called by ToolBinder and ToolActivation.cancel()
    this.debounceDeactivate.cancel();
    const activation = this.activeTool_;
    if (activation === undefined) return;
    this.activeTool_ = undefined;
    activation.dispose();
  }

  public deactivate() {
    this.debounceDeactivate();
  }
}

export class LocalToolBinder<
  Context extends object = object,
> extends RefCounted {
  // Maps the the tool key (i.e. "A", "B", ...) to the bound tool.
  bindings = new Map<string, Owned<Tool>>();
  // Maps the serialized json representation of the tool to the tool key.
  jsonToKey = new Map<string, string>();
  changed = new Signal();

  constructor(
    public context: Context,
    public globalBinder: GlobalToolBinder,
  ) {
    super();
    globalBinder.localBinders.add(this);
    globalBinder.localBindersChanged.dispatch();
  }

  getSortOrder() {
    return Number.NEGATIVE_INFINITY;
  }

  disposed() {
    this.globalBinder.localBinders.delete(this);
    this.globalBinder.localBindersChanged.dispatch();
    this.clear();
    super.disposed();
  }

  get(key: string): Borrowed<Tool> | undefined {
    return this.bindings.get(key);
  }

  set(key: string, tool: Owned<Tool> | undefined) {
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
    const { bindings } = this;
    if (bindings.size === 0) return undefined;
    const obj: any = {};
    for (const [key, value] of bindings) {
      obj[key] = value.toJSON();
    }
    return obj;
  }

  getCommonToolProperties(): any {
    return {};
  }

  convertLocalJSONToPaletteJSON(toolJson: any) {
    return toolJson;
  }

  clear() {
    const { globalBinder, bindings } = this;
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

export class LayerToolBinder<
  LayerType extends UserLayer,
> extends LocalToolBinder<LayerType> {
  getCommonToolProperties() {
    return {
      layer: this.context.managedLayer.name,
      layerType: this.context.managedLayer.layer?.type,
    };
  }
  convertLocalJSONToPaletteJSON(toolJson: any) {
    let j = toolJson;
    if (typeof j === "string") {
      j = { type: j };
    }
    return { layer: this.context.managedLayer.name, ...j };
  }

  getSortOrder(): number {
    const { managedLayer } = this.context;
    managedLayer.manager.layerManager.updateNonArchivedLayerIndices();
    return this.context.managedLayer.nonArchivedLayerIndex;
  }
}

export function updateToolDragDropEffect(
  dragSource: ToolDragSource,
  dropEffect?: string,
  dropSamePalette: boolean = false,
) {
  const { paletteState, dragElement } = dragSource;
  if (paletteState === undefined || dragElement === undefined) return;
  const cssClass = "neuroglancer-tool-to-be-removed";
  if (dropEffect === "move" && dropSamePalette === false) {
    dragElement.classList.add(cssClass);
  } else {
    dragElement.classList.remove(cssClass);
  }
}

export class ToolBindingWidget<Context extends object> extends RefCounted {
  element = document.createElement("div");
  private toolJsonString: string;
  constructor(
    public localBinder: LocalToolBinder<Context>,
    public toolJson: any,
    public dragElement: HTMLElement | undefined,
    public paletteState:
      | { tool: Tool<Context>; palette: ToolPalettePanel }
      | undefined = undefined,
  ) {
    super();
    this.toolJsonString = JSON.stringify(toolJson);
    const { element } = this;
    element.classList.add("neuroglancer-tool-key-binding");
    this.registerDisposer(
      localBinder.changed.add(
        this.registerCancellable(
          animationFrameDebounce(() => this.updateView()),
        ),
      ),
    );
    this.updateView();
    element.title = "click → bind key, dbclick → unbind";
    element.addEventListener("dblclick", () => {
      this.localBinder.removeJsonString(this.toolJsonString);
    });
    addToolKeyBindHandlers(this, element, (key) =>
      this.localBinder.setJson(key, this.toolJson),
    );
    if (dragElement !== undefined) {
      dragElement.draggable = true;
      dragElement.addEventListener("dragstart", (event: DragEvent) => {
        pushDragStatus(
          event,
          dragElement,
          "drag",
          "Drag tool to another tool palette, " +
            "or to the left/top/right/bottom edge of a layer group to create a new tool palette",
        );
        beginToolDrag(this);
        const { toolPaletteState } = this.localBinder.globalBinder;
        const self = this;
        toolPaletteState.viewer.sidePanelManager.startDrag(
          {
            dropAsNewPanel: (location, dropEffect) => {
              const palette = toolPaletteState.addNew({ location });
              palette.tools.insert(
                this.localBinder.convertLocalJSONToPaletteJSON(toolJson),
              );
              if (dropEffect === "move") {
                const { paletteState } = this;
                if (paletteState?.palette.state.queryDefined.value === false) {
                  paletteState.palette.state.tools.remove(paletteState.tool);
                }
              }
            },
            getNewPanelDropEffect: (event) => {
              const inExplicitPalette =
                this.paletteState?.palette.state.queryDefined.value === false;
              const result = getDropEffectFromModifiers(
                event,
                /*defaultDropEffect=*/ inExplicitPalette ? "move" : "copy",
                /*moveAllowed=*/ inExplicitPalette,
              );
              updateToolDragDropEffect(
                self,
                result.dropEffect,
                /*dropSamePalette=*/ false,
              );
              const leaveHandler = () => {
                updateToolDragDropEffect(self);
              };
              return { ...result, description: "tool", leaveHandler };
            },
          },
          event,
        );
      });
      dragElement.addEventListener("dragend", (event: DragEvent) => {
        popDragStatus(event, dragElement, "drag");
        endToolDrag(this);
        const { toolPaletteState } = this.localBinder.globalBinder;
        toolPaletteState.viewer.sidePanelManager.endDrag();
        event.stopPropagation();
      });
    }
  }

  private updateView() {
    const { localBinder } = this;
    const key = localBinder.jsonToKey.get(this.toolJsonString);
    this.element.textContent = key ?? " ";
  }
}

export function addToolKeyBindHandlers(
  context: RefCounted,
  element: HTMLElement,
  bindKey: (key: string) => void,
) {
  let mousedownContext: RefCounted | undefined;
  element.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || mousedownContext !== undefined) return;
    event.preventDefault();
    event.stopPropagation();
    mousedownContext = new RefCounted();
    context.registerDisposer(mousedownContext);
    const message = mousedownContext.registerDisposer(new StatusMessage(false));
    message.setText("Press A-Z to bind key");
    mousedownContext.registerEventListener(
      window,
      "keydown",
      (event: KeyboardEvent) => {
        const { code } = event;
        const m = code.match(/^Key([A-Z])$/);
        if (m === null) return;
        event.stopPropagation();
        event.preventDefault();
        const key = m[1];
        bindKey(key);
      },
      { capture: true },
    );
    mousedownContext.registerEventListener(
      window,
      "mouseup",
      (event: MouseEvent) => {
        if (event.button !== 0 || mousedownContext === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        context.unregisterDisposer(mousedownContext);
        mousedownContext.dispose();
        mousedownContext = undefined;
      },
    );
  });
  element.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
}

export function makeToolButton(
  context: RefCounted,
  localBinder: LocalToolBinder,
  options: {
    toolJson: any;
    label?: string;
    title?: string;
    dragElement?: HTMLElement;
  },
) {
  const element = document.createElement("div");
  element.classList.add("neuroglancer-tool-button");
  element.appendChild(
    context.registerDisposer(
      new ToolBindingWidget(
        localBinder,
        options.toolJson,
        options.dragElement ?? element,
      ),
    ).element,
  );
  const labelElement = document.createElement("div");
  labelElement.classList.add("neuroglancer-tool-button-label");
  const labelText = options.label;
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
  message.element.classList.add("neuroglancer-tool-status");
  const content = document.createElement("div");
  content.classList.add("neuroglancer-tool-status-content");
  message.element.appendChild(content);
  const { inputEventMapBinder } = activation;
  activation.inputEventMapBinder = (
    inputEventMap: EventActionMap,
    context: RefCounted,
  ) => {
    const bindingHelp = document.createElement("div");
    bindingHelp.textContent = inputEventMap.describe();
    bindingHelp.classList.add("neuroglancer-tool-status-bindings");
    message.element.appendChild(bindingHelp);
    inputEventMapBinder(inputEventMap, context);
  };
  return { message, content };
}

export function makeToolActivationStatusMessageWithHeader(
  activation: ToolActivation,
) {
  const { message, content } = makeToolActivationStatusMessage(activation);
  const header = document.createElement("div");
  header.classList.add("neuroglancer-tool-status-header");
  const headerContainer = document.createElement("div");
  headerContainer.classList.add("neuroglancer-tool-status-header-container");
  headerContainer.appendChild(header);
  content.appendChild(headerContainer);
  const body = document.createElement("div");
  body.classList.add("neuroglancer-tool-status-body");
  content.appendChild(body);
  return { message, body, header };
}

function* getToolsFromListerMatchingTerms(
  localBinder: LocalToolBinder,
  lister: ToolLister,
  terms: QueryTerm[],
  commonProperties: { [key: string]: string },
  onChange: (() => void) | undefined,
) {
  for (const tool of lister(localBinder.context, onChange)) {
    if (matchesTerms(tool, terms)) {
      yield {
        ...localBinder.convertLocalJSONToPaletteJSON(tool),
        ...commonProperties,
      };
    }
  }
}

function* getToolsMatchingTerms(
  localBinder: LocalToolBinder,
  terms: QueryTerm[],
  onChange?: () => void,
) {
  const typePredicate = terms.find(
    (term) => term.property === "type",
  )?.predicate;
  const typeEquals =
    typePredicate !== undefined && "equals" in typePredicate
      ? typePredicate.equals
      : undefined;
  const commonProperties = localBinder.getCommonToolProperties();
  for (const term of terms) {
    const { property } = term;
    if (property in commonProperties) {
      if (!matchPredicate(term.predicate, commonProperties[property])) {
        return;
      }
    }
  }
  const remainingTerms = terms.filter(
    (term) => !(term.property in commonProperties) && term.property !== "type",
  );

  const { context } = localBinder;
  let prototype = context;
  while (true) {
    prototype = Object.getPrototypeOf(prototype);
    if (prototype === null) {
      break;
    }
    const toolMap = toolsForPrototype.get(prototype);
    if (toolMap === undefined) continue;
    if (typeEquals !== undefined) {
      const lister = toolMap.get(typeEquals)?.lister;
      if (lister === undefined) continue;
      yield* getToolsFromListerMatchingTerms(
        localBinder,
        lister,
        remainingTerms,
        commonProperties,
        onChange,
      );
      break;
    }
    for (const [type, { lister }] of toolMap) {
      if (lister === undefined) continue;
      if (typePredicate !== undefined && !matchPredicate(typePredicate, type)) {
        continue;
      }
      yield* getToolsFromListerMatchingTerms(
        localBinder,
        lister,
        remainingTerms,
        commonProperties,
        onChange,
      );
    }
  }
}

export function getMatchingTools(
  globalBinder: GlobalToolBinder,
  query: Query,
  onChange?: () => void,
): Map<string, any> {
  const matchingTools = new Map<string, any>();

  const localBinders = Array.from(globalBinder.localBinders);
  localBinders.sort((a, b) => a.getSortOrder() - b.getSortOrder());

  for (const localBinder of localBinders) {
    for (const { include, terms } of query.clauses) {
      for (const toolJson of getToolsMatchingTerms(
        localBinder,
        terms,
        onChange,
      )) {
        const identifier = JSON.stringify(toolJson);
        if (include) {
          matchingTools.set(identifier, toolJson);
        } else {
          matchingTools.delete(identifier);
        }
      }
    }
  }

  return matchingTools;
}
