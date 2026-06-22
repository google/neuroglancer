/**
 * @license
 * Copyright 2024 Google Inc.
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

import "#src/ui/tool_palette.css";

import svg_search from "ikonate/icons/search.svg?raw";
import svg_tool from "ikonate/icons/tool.svg?raw";
import { debounce } from "lodash-es";
import type { UserLayer } from "#src/layer/index.js";
import {
  ElementVisibilityFromTrackableBoolean,
  TrackableBooleanCheckbox,
} from "#src/trackable_boolean.js";
import {
  makeCachedDerivedWatchableValue,
  makeCachedLazyDerivedWatchableValue,
  TrackableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import { popDragStatus, pushDragStatus } from "#src/ui/drag_and_drop.js";
import { LayerVisibilityWidget } from "#src/ui/layer_list_panel.js";
import { LayerNameWidget } from "#src/ui/layer_side_panel.js";
import type {
  RegisteredSidePanel,
  SidePanelManager,
} from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";
import type { SidePanelLocation } from "#src/ui/side_panel_location.js";
import {
  DEFAULT_SIDE_PANEL_LOCATION,
  TrackableSidePanelLocation,
} from "#src/ui/side_panel_location.js";
import type { Tool } from "#src/ui/tool.js";
import {
  getMatchingTools,
  LayerToolBinder,
  restoreTool,
  ToolBindingWidget,
  updateToolDragDropEffect,
} from "#src/ui/tool.js";
import type { ToolDragSource } from "#src/ui/tool_drag_and_drop.js";
import { toolDragSource } from "#src/ui/tool_drag_and_drop.js";
import {
  getPropertyNameCompletions,
  getPropertyValueCompletions,
  getQueryTermToComplete,
  parsePartialToolQuery,
  parseToolQuery,
} from "#src/ui/tool_query.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { arraysEqual } from "#src/util/array.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  updateChildren,
  removeFromParent,
  removeChildren,
} from "#src/util/dom.js";
import {
  getDropEffectFromModifiers,
  getDropEffect,
  setDropEffect,
} from "#src/util/drag_and_drop.js";
import { positionRelativeDropdown } from "#src/util/dropdown.js";
import {
  parseArray,
  verifyObject,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import { CompoundTrackable, getCachedJson } from "#src/util/trackable.js";
import type { Viewer } from "#src/viewer.js";
import { CheckboxIcon } from "#src/widget/checkbox_icon.js";
import { makeDeleteButton } from "#src/widget/delete_button.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import type {
  CompletionResult,
  CompletionWithDescription,
} from "#src/widget/multiline_autocomplete.js";
import {
  AutocompleteTextInput,
  makeCompletionElementWithDescription,
} from "#src/widget/multiline_autocomplete.js";
import { TextInputWidget } from "#src/widget/text_input.js";

const DEFAULT_TOOL_PALETTE_PANEL_LOCATION: SidePanelLocation = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: "right",
  row: 0,
  visible: true,
};

function getToolFromJson(viewer: Viewer, toolJson: unknown): Tool | undefined {
  verifyObject(toolJson);
  const layerName = verifyOptionalObjectProperty(
    toolJson,
    "layer",
    verifyString,
  );
  if (layerName !== undefined) {
    const { layer: _ignoredLayer, ...adjustedToolJson } = toolJson as any;
    const managedLayer = viewer.layerManager.getLayerByName(layerName);
    if (managedLayer === undefined) {
      return undefined;
    }
    const userLayer = managedLayer.layer;
    if (userLayer === null) {
      return undefined;
    }
    return restoreTool(userLayer, adjustedToolJson);
  } else {
    return restoreTool(viewer, toolJson);
  }
}

export class TrackableToolList extends RefCounted implements Trackable {
  tools: Tool[] = [];

  changed = new NullarySignal();

  constructor(private viewer: Viewer) {
    super();
  }

  get value() {
    return this.tools;
  }

  reset() {
    const { tools } = this;
    if (tools.length === 0) return;
    for (const tool of tools) {
      tool.dispose();
    }
    tools.length = 0;
    this.changed.dispatch();
  }

  private makeTool(toolJson: unknown): Tool | undefined {
    const tool = getToolFromJson(this.viewer, toolJson);
    if (tool === undefined) return undefined;
    this.initializeTool(tool);
    return tool;
  }

  private initializeTool(tool: Tool) {
    tool.unbound.add(() => {
      this.remove(tool);
    });
  }

  restoreState(obj: unknown) {
    const tools: Tool[] = [];
    this.tools = tools;
    parseArray(obj, (j) => {
      const tool = this.makeTool(j);
      if (tool === undefined) return;
      tools.push(tool);
    });
    this.changed.dispatch();
  }

  insert(
    toolJson: unknown,
    before: Tool | undefined = undefined,
  ): Tool | undefined {
    let insertIndex: number;
    const { tools } = this;
    if (before === undefined) {
      insertIndex = tools.length;
    } else {
      insertIndex = tools.indexOf(before);
    }
    const tool = this.makeTool(toolJson);
    if (tool === undefined) return undefined;
    tools.splice(insertIndex, 0, tool);
    this.changed.dispatch();
    return tool;
  }

  move(source: Tool, before: Tool | undefined) {
    const { tools } = this;
    const sourceIndex = tools.indexOf(source);
    if (sourceIndex === -1) return false;
    let targetIndex: number;
    if (before === undefined) {
      targetIndex = tools.length;
    } else {
      targetIndex = tools.indexOf(before);
      if (targetIndex === -1) return false;
    }
    if (targetIndex === sourceIndex) return true;
    tools.splice(sourceIndex, 1);
    if (targetIndex > sourceIndex) {
      --targetIndex;
    }
    tools.splice(targetIndex, 0, source);
    this.changed.dispatch();
    return true;
  }

  remove(tool: Tool): boolean {
    const { tools } = this;
    const index = tools.indexOf(tool);
    if (index === -1) return false;
    tools.splice(index, 1);
    tool.dispose();
    this.changed.dispatch();
    return true;
  }

  toJSON() {
    const { tools } = this;
    if (tools.length === 0) return undefined;
    return Array.from(tools, (tool) => {
      return tool.localBinder.convertLocalJSONToPaletteJSON(tool.toJSON());
    });
  }

  addTools(newTools: Tool[]) {
    for (const tool of newTools) {
      this.initializeTool(tool);
    }
    this.tools.push(...newTools);
    this.changed.dispatch();
  }

  disposed() {
    super.disposed();
    for (const tool of this.tools) {
      tool.dispose();
    }
  }
}

export class ToolPaletteState extends RefCounted implements Trackable {
  location = new TrackableSidePanelLocation(
    DEFAULT_TOOL_PALETTE_PANEL_LOCATION,
  );

  name = new TrackableValue<string>("", verifyString);

  tools: TrackableToolList;

  query = new TrackableValue("", verifyString);

  parsedQuery = this.registerDisposer(
    makeCachedLazyDerivedWatchableValue((query) => {
      return parseToolQuery(query);
    }, this.query),
  );

  queryDefined;

  private trackable = new CompoundTrackable();

  get changed() {
    return this.trackable.changed;
  }

  constructor(public viewer: Viewer) {
    super();
    this.tools = this.registerDisposer(new TrackableToolList(viewer));
    this.location.changed.add(this.changed.dispatch);
    this.name.changed.add(this.changed.dispatch);
    this.trackable.add("tools", this.tools);
    this.trackable.add("query", this.query);
    this.queryDefined = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (value) => value.length === 0,
        [this.tools],
      ),
    );
  }

  restoreState(obj: unknown) {
    this.location.restoreState(obj);
    this.trackable.restoreState(obj);
    if (this.query.value !== "") {
      this.tools.reset();
    }
  }

  reset() {
    this.location.reset();
    this.trackable.reset();
  }

  toJSON() {
    return { ...this.location.toJSON(), ...this.trackable.toJSON() };
  }
}

class RenderedLayerGroup extends RefCounted {
  element = document.createElement("div");
  header = document.createElement("div");
  content = document.createElement("div");
  firstTool: Tool | undefined;
  constructor(public layer: UserLayer) {
    super();
    const { element, header, content } = this;
    element.classList.add("neuroglancer-tool-palette-layer-group");
    element.appendChild(header);
    element.appendChild(content);
    header.classList.add("neuroglancer-tool-palette-layer-group-header");
    content.classList.add("neuroglancer-tool-palette-layer-group-content");
    header.appendChild(
      this.registerDisposer(new LayerVisibilityWidget(layer.managedLayer))
        .element,
    );
    header.appendChild(
      this.registerDisposer(new LayerNameWidget(layer.managedLayer)).element,
    );
  }
}

class QueryResults extends RefCounted {
  changed = new NullarySignal();

  private results: Tool[] = [];
  private jsonToTool = new Map<string, Tool>();

  constructor(public state: ToolPaletteState) {
    super();

    this.registerDisposer(state.query.changed.add(this.debouncedUpdateResults));
    this.registerDisposer(
      state.viewer.globalToolBinder.localBindersChanged.add(
        this.debouncedUpdateResults,
      ),
    );

    this.updateResults();
  }

  disposed() {
    for (const tool of this.jsonToTool.values()) {
      tool.dispose();
    }
    super.dispose();
  }

  private debouncedUpdateResults = this.registerCancellable(
    debounce(() => {
      this.updateResults();
    }),
  );

  private getMatches(): Map<string, any> | undefined {
    let triggered = false;
    const onChange = () => {
      if (triggered) return;
      triggered = true;
      this.debouncedUpdateResults();
    };
    const parsedQuery = this.state.parsedQuery.value;
    if (parsedQuery === undefined) return undefined;
    if (!("query" in parsedQuery)) {
      return undefined;
    }
    const matches = getMatchingTools(
      this.state.viewer.globalToolBinder,
      parsedQuery.query,
      onChange,
    );
    return matches;
  }

  private updateResults() {
    const matches = this.getMatches() ?? new Map();
    const { results, jsonToTool } = this;
    const newResults: Tool[] = [];
    for (const [key, toolJson] of matches) {
      let tool = jsonToTool.get(key);
      if (tool === undefined) {
        tool = getToolFromJson(this.state.viewer, toolJson);
        if (tool === undefined) {
          continue;
        }
        jsonToTool.set(key, tool);
      }
      newResults.push(tool);
    }

    for (const [key, tool] of jsonToTool) {
      if (!matches.has(key)) {
        tool.dispose();
        jsonToTool.delete(key);
      }
    }
    if (!arraysEqual(results, newResults)) {
      this.results = newResults;
      this.changed.dispatch();
    }
  }

  convertToExplicitPalette() {
    this.debouncedUpdateResults.flush();
    this.state.query.value = "";
    this.state.tools.addTools(this.results);
    this.results.length = 0;
    this.jsonToTool.clear();
  }

  get value() {
    return this.results;
  }
}

class RenderedTool extends RefCounted {
  layerGroup: RenderedLayerGroup | undefined;
  element = document.createElement("label")!;
  private context: RefCounted | undefined = undefined;

  constructor(
    public tool: Tool,
    public palette: ToolPalettePanel,
  ) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-tool-palette-tool-container");
    element.addEventListener("dblclick", () => {
      this.tool.unbind();
    });
    element.append(
      this.registerDisposer(
        new ToolBindingWidget(tool.localBinder, tool.toJSON(), element, {
          tool,
          palette,
        }),
      ).element,
    );
    this.updateView();
    this.updateTooltip();

    this.registerDisposer(tool.changed.add(this.debouncedUpdateTooltip));
    this.registerDisposer(
      palette.state.queryDefined.changed.add(this.debouncedUpdateTooltip),
    );
  }

  private debouncedUpdateView = this.registerCancellable(
    animationFrameDebounce(() => this.updateView()),
  );

  private debouncedUpdateTooltip = this.registerCancellable(
    animationFrameDebounce(() => this.updateTooltip()),
  );

  private updateTooltip() {
    let toolJson = this.tool.toJSON();
    if (typeof toolJson === "string") {
      toolJson = { type: toolJson };
    }
    let text = Object.entries(toolJson)
      .map(([key, value]) => `${key}:${value}`)
      .join(" ");
    if (!this.palette.state.queryDefined.value) {
      text += "\nDrag to move/copy, dblclick to remove";
    } else {
      text += "\nDrag to copy to another palette";
    }
    this.element.title = text;
  }

  private updateView() {
    let { context } = this;
    const { element } = this;
    if (context !== undefined) {
      context.dispose();
      element.removeChild(element.lastElementChild as Element);
    }
    this.context = context = new RefCounted();
    const { tool } = this;
    let toolElement = this.tool.renderInPalette(context);
    if (toolElement === undefined) {
      toolElement = document.createElement("div");
      toolElement.textContent = "Loading...";
      if (tool.localBinder instanceof LayerToolBinder) {
        context.registerDisposer(
          tool.localBinder.context.managedLayer.layerChanged.add(
            this.debouncedUpdateView,
          ),
        );
      }
    }
    toolElement.classList.add("neuroglancer-tool-palette-tool-content");
    element.appendChild(toolElement);
  }

  disposed() {
    this.context?.dispose();
    this.layerGroup?.dispose();
    super.disposed();
  }
}

export class ToolPalettePanel extends SidePanel {
  private itemContainer = document.createElement("div");
  private dropZone = document.createElement("div");
  private renderedTools = new Map<Tool, RenderedTool>();
  private dragState:
    | { dragSource: ToolDragSource; ephemeralTool: Tool }
    | undefined = undefined;
  private dragEnterCount = 0;
  private queryResults: QueryResults;

  private clearDragState() {
    const { dragState } = this;
    if (dragState === undefined) return;
    this.dragState = undefined;
    this.state.tools.remove(dragState.ephemeralTool);
  }

  get hasQuery() {
    return this.state.query.value !== "";
  }

  private registerDropHandlers(
    element: HTMLElement,
    getTool: () => Tool | undefined,
  ) {
    const isDragSourceSupported = () => {
      return (
        toolDragSource?.localBinder.globalBinder ===
        this.manager.state.viewer.globalToolBinder
      );
    };

    const update = (event: DragEvent, updateDropEffect: boolean) => {
      if (!isDragSourceSupported()) {
        return undefined;
      }
      if (this.hasQuery) {
        this.clearDragState();
        const otherPalette = toolDragSource?.paletteState?.palette;
        if (
          updateDropEffect &&
          otherPalette !== undefined &&
          otherPalette !== this
        ) {
          pushDragStatus(
            event,
            this.itemContainer,
            "drop",
            "Tools cannot be dropped into a query-defined palette.  To allow dropping tools into this palette, first click the magnifying glass icon in the panel titlebar to convert it to a manually-defined palette.",
          );
        }
        updateToolDragDropEffect(toolDragSource!, "none", false);
        return "none";
      }
      if (this.dragState?.dragSource !== toolDragSource) {
        this.clearDragState();
      }
      let dropEffect: "copy" | "move";
      let message: string = "";
      if (updateDropEffect) {
        const explicitPaletteSource =
          toolDragSource!.paletteState?.palette.state.queryDefined.value ===
          false;
        const result = getDropEffectFromModifiers(
          event,
          /*defaultDropEffect=*/ explicitPaletteSource ? "move" : "copy",
          /*moveAllowed=*/ explicitPaletteSource,
        );
        dropEffect = result.dropEffect;
        setDropEffect(event, dropEffect);
        message = `Drop to ${dropEffect} the tool`;
        if (result.dropEffectMessage) {
          message += ` (${result.dropEffectMessage})`;
        }
      } else {
        dropEffect = getDropEffect() as "copy" | "move";
      }

      const tool = getTool();

      const samePalette = toolDragSource!.paletteState?.palette === this;

      if (dropEffect === "copy" || !samePalette) {
        const { dragState } = this;
        if (dragState === undefined) {
          const sourceToolJson =
            toolDragSource!.localBinder.convertLocalJSONToPaletteJSON(
              toolDragSource!.toolJson,
            );
          const ephemeralTool = this.state.tools.insert(sourceToolJson, tool);
          if (ephemeralTool === undefined) {
            // Unexpected failure
            console.error("Failed to create tool: ", toolDragSource!.toolJson);
            return undefined;
          }
          this.dragState = { dragSource: toolDragSource!, ephemeralTool };
        } else {
          this.state.tools.move(dragState.ephemeralTool, tool);
        }
      } else {
        this.clearDragState();
        this.state.tools.move(toolDragSource!.paletteState!.tool, tool);
      }

      if (updateDropEffect) {
        const source = toolDragSource!;
        const leaveHandler = () => {
          updateToolDragDropEffect(source);
        };
        pushDragStatus(
          event,
          this.itemContainer,
          "drop",
          message,
          leaveHandler,
        );
        updateToolDragDropEffect(source, dropEffect, samePalette);
      }
      return dropEffect;
    };

    const handleDragOver = (event: DragEvent) => {
      const updateResult = update(event, /*updateDropEffect=*/ true);
      if (updateResult === undefined) {
        popDragStatus(event, this.itemContainer, "drop");
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("dragover", handleDragOver);
    element.addEventListener("dragenter", (event: DragEvent) => {
      ++this.dragEnterCount;
      handleDragOver(event);
    });
    element.addEventListener("dragleave", (event: DragEvent) => {
      if (--this.dragEnterCount !== 0) return;
      popDragStatus(event, this.itemContainer, "drop");
      this.clearDragState();
      event.stopPropagation();
    });
    element.addEventListener("drop", (event: DragEvent) => {
      event.preventDefault();
      this.dragEnterCount = 0;
      popDragStatus(event, this.itemContainer, "drop");
      const updateResult = update(event, /*updateDropEffect=*/ false);
      if (updateResult === undefined) {
        this.clearDragState();
        return;
      }
      event.stopPropagation();
      // The "ephemeral tool", if any, is no longer ephemeral.
      this.dragState = undefined;
      if (updateResult === "move") {
        const { paletteState } = toolDragSource!;
        if (paletteState !== undefined && paletteState.palette !== this) {
          paletteState.palette.state.tools.remove(paletteState.tool);
        }
      }
    });
  }

  constructor(
    private manager: MultiToolPaletteManager,
    sidePanelManager: SidePanelManager,
    public state: ToolPaletteState,
  ) {
    super(sidePanelManager, state.location);
    const { titleBar } = this.addTitleBar({});
    titleBar.appendChild(
      this.registerDisposer(new PaletteNameWidget(state.name)).element,
    );
    this.queryResults = this.registerDisposer(new QueryResults(state));
    const hasQuery = this.registerDisposer(
      makeCachedDerivedWatchableValue((value) => value !== "", [state.query]),
    );
    const self = this;
    const searchButton = this.registerDisposer(
      new CheckboxIcon(
        {
          changed: hasQuery.changed,
          get value() {
            return hasQuery.value;
          },
          set value(newValue: boolean) {
            if (newValue === false && hasQuery.value !== false) {
              self.queryResults.convertToExplicitPalette();
            }
          },
        },
        {
          svg: svg_search,
          disableTitle: "Convert query results to an explicit tool palette",
        },
      ),
    );
    titleBar.appendChild(searchButton.element);
    this.registerDisposer(
      new ElementVisibilityFromTrackableBoolean(hasQuery, searchButton.element),
    );
    const deleteButton = makeDeleteButton({ title: "Delete tool palette" });
    deleteButton.addEventListener("click", () => {
      state.dispose();
    });
    titleBar.appendChild(deleteButton);

    const body = document.createElement("div");
    body.classList.add("neuroglancer-tool-palette-body");
    const { itemContainer } = this;
    itemContainer.classList.add("neuroglancer-tool-palette-items");
    body.appendChild(
      this.registerDisposer(
        new DependentViewWidget(
          self.state.queryDefined,
          (hasQuery: boolean, parent, context) => {
            if (!hasQuery) return;
            parent.appendChild(
              context.registerDisposer(new ToolQueryWidget(state)).element,
            );
          },
        ),
      ).element,
    );
    body.appendChild(itemContainer);
    this.addBody(body);

    const { dropZone } = this;
    dropZone.classList.add("neuroglancer-tool-palette-drop-zone");
    this.registerDropHandlers(dropZone, () => undefined);
    const debouncedRender = this.registerCancellable(
      animationFrameDebounce(() => this.render()),
    );
    this.registerDisposer(this.state.tools.changed.add(debouncedRender));
    this.registerDisposer(this.queryResults.changed.add(debouncedRender));
    this.visibility.changed.add(debouncedRender);
    this.render();
  }

  private getRenderedTool(tool: Tool) {
    const { renderedTools } = this;
    let renderedTool = renderedTools.get(tool);
    if (renderedTool === undefined) {
      renderedTool = new RenderedTool(tool, this);
      this.registerDropHandlers(renderedTool.element, () => tool);
      renderedTools.set(tool, renderedTool);
    }
    return renderedTool;
  }

  override getDragDropDescription() {
    return "tool palette";
  }

  override canCopy() {
    return true;
  }

  override copyToNewLocation(location: SidePanelLocation) {
    const newPalette = this.manager.state.addNew({
      location: { ...this.state.location.value, ...location },
      name: this.state.name.value,
    });
    newPalette.tools.restoreState(this.state.tools.toJSON() ?? []);
    newPalette.query.value = this.state.query.value;
  }

  render() {
    const self = this;
    function* getItems() {
      const tools = self.state.queryDefined.value
        ? self.queryResults.value
        : self.state.tools.tools;
      const { renderedTools } = self;
      const seenTools = new Set(tools);
      const numTools = tools.length;
      const seenLayerGroups = new Set();
      for (let toolIndex = 0; toolIndex < numTools; ) {
        let tool = tools[toolIndex];
        const { localBinder } = tool;
        if (localBinder instanceof LayerToolBinder) {
          const layer: UserLayer = localBinder.context;

          let renderedTool = self.getRenderedTool(tool);

          let { layerGroup } = renderedTool;
          if (seenLayerGroups.has(layerGroup) || layerGroup === undefined) {
            layerGroup = new RenderedLayerGroup(layer);
            self.registerDropHandlers(
              layerGroup.header,
              () => layerGroup!.firstTool,
            );
            layerGroup.firstTool = tool;
          } else {
            layerGroup.addRef();
          }
          seenLayerGroups.add(layerGroup);

          // Fill layer group.
          function* getGroupItems() {
            while (true) {
              renderedTool.layerGroup?.dispose();
              renderedTool.layerGroup = layerGroup!.addRef();
              yield renderedTool.element;
              if (
                ++toolIndex === numTools ||
                (tool = tools[toolIndex]).localBinder !== localBinder
              ) {
                break;
              }
              renderedTool = self.getRenderedTool(tool);
            }
          }
          updateChildren(layerGroup.content, getGroupItems());
          yield layerGroup.element;
          layerGroup.dispose();
        } else {
          const renderedTool = self.getRenderedTool(tool);
          yield renderedTool.element;
          ++toolIndex;
        }
      }
      for (const [tool, renderedTool] of renderedTools) {
        if (!seenTools.has(tool)) {
          renderedTool.dispose();
          renderedTools.delete(tool);
        }
      }

      yield self.dropZone;
    }
    updateChildren(this.itemContainer, getItems());
  }

  disposed() {}
}

class ToolQueryWidget extends RefCounted {
  element = document.createElement("div");
  errorsElement = document.createElement("ul");
  constructor(public state: ToolPaletteState) {
    super();

    const textInput = this.registerDisposer(
      new AutocompleteTextInput({
        completer: this.completeQuery.bind(this),
      }),
    );
    textInput.placeholder = "Enter tool query or drag in tools";
    textInput.element.classList.add("neuroglancer-tool-palette-query");
    textInput.value = state.query.value ?? "";

    this.registerDisposer(
      state.parsedQuery.changed.add(
        this.registerCancellable(debounce(() => this.updateErrors(), 200)),
      ),
    );
    this.updateErrors();
    textInput.onCommit.add(() => {
      state.query.value = textInput.value;
    });
    state.query.changed.add(() => {
      textInput.value = state.query.value ?? "";
    });
    const { element, errorsElement } = this;
    element.appendChild(textInput.element);
    element.appendChild(errorsElement);
    errorsElement.classList.add("neuroglancer-tool-palette-query-errors");
  }

  private updateErrors() {
    const { errorsElement } = this;
    removeChildren(errorsElement);
    const query = this.state.parsedQuery.value;
    if (query === undefined || !("errors" in query)) return;
    for (const error of query.errors) {
      const element = document.createElement("li");
      element.textContent = error.message;
      errorsElement.appendChild(element);
    }
  }

  private async completeQuery({
    value,
  }: {
    value: string;
  }): Promise<CompletionResult> {
    const parsed = parsePartialToolQuery(value);
    const info = getQueryTermToComplete(parsed);

    const matches = getMatchingTools(
      this.state.viewer.globalToolBinder,
      info.completionQuery,
    );

    let completions: [string, number][];
    if (info.property === undefined) {
      completions = getPropertyNameCompletions(
        info.completionQuery,
        matches,
        info.prefix,
      );
    } else {
      completions = getPropertyValueCompletions(matches, info.property);
    }
    const completionEntries: CompletionWithDescription[] = [];
    if (info.property === undefined && info.prefix === "") {
      if (
        parsed.query.clauses.length > 0 &&
        parsed.query.clauses[parsed.query.clauses.length - 1].terms.length !== 0
      ) {
        completionEntries.push({
          value: "+",
          description: "New inclusion clause",
        });
        completionEntries.push({
          value: "-",
          description: "New exclusion clause",
        });
      }
    }

    for (const [value, count] of completions) {
      completionEntries.push({
        value,
        description: `${count} tool${count > 0 ? "s" : ""}`,
      });
    }
    return {
      offset: info.offset,
      completions: completionEntries,
      makeElement: makeCompletionElementWithDescription,
    };
  }
}

export class MultiToolPaletteState implements Trackable {
  changed = new NullarySignal();
  changedShallow = new NullarySignal();
  visibleStateChanged = new NullarySignal();
  palettes = new Set<ToolPaletteState>();

  constructor(public viewer: Viewer) {}

  add(palette: Owned<ToolPaletteState>) {
    this.palettes.add(palette);
    palette.registerDisposer(palette.changed.add(this.changed.dispatch));
    palette.registerDisposer(
      palette.location.watchableVisible.changed.add(
        this.visibleStateChanged.dispatch,
      ),
    );
    palette.registerDisposer(
      palette.name.changed.add(() => this.checkTitles(palette)),
    );
    palette.registerDisposer(() => {
      this.palettes.delete(palette);
      this.changedShallow.dispatch();
      this.visibleStateChanged.dispatch();
      this.changed.dispatch();
    });
    this.changedShallow.dispatch();
    this.changed.dispatch();
  }

  toJSON() {
    const { palettes } = this;
    if (palettes.size === 0) {
      return undefined;
    }
    const json: any = {};
    for (const palette of palettes) {
      json[palette.name.value] = getCachedJson(palette).value;
    }
    return json;
  }

  reset() {
    const { palettes } = this;
    if (palettes.size !== 0) {
      for (const palette of palettes) {
        palette.dispose();
      }
    }
  }

  restoreState(obj: unknown) {
    if (obj === undefined) {
      return;
    }
    verifyObject(obj);
    const { viewer } = this;
    const names = new Map<string, ToolPaletteState>();
    for (const palette of this.palettes) {
      names.set(palette.name.value, palette);
    }
    for (const [name, json] of Object.entries(obj as object)) {
      const existing = names.get(name);
      if (existing !== undefined) {
        existing.restoreState(json);
        continue;
      }
      const palette = new ToolPaletteState(viewer);
      palette.name.value = name;
      palette.restoreState(json);
      names.set(name, palette);
      this.add(palette);
    }
  }

  addNew(
    options: { location?: Partial<SidePanelLocation>; name?: string } = {},
  ) {
    const palette = new ToolPaletteState(this.viewer);
    const { location, name = "Palette" } = options;
    palette.name.value = name;
    this.checkTitles(palette);
    palette.location.value = {
      ...DEFAULT_TOOL_PALETTE_PANEL_LOCATION,
      ...location,
    };
    palette.location.locationChanged.dispatch();
    this.add(palette);
    return palette;
  }

  // Ensures all palette titles are unique.
  private checkingTitles = false;
  private checkTitles(changedPalette: ToolPaletteState) {
    if (this.checkingTitles) return;
    try {
      this.checkingTitles = true;
      const titles = new Set<string>();
      for (const palette of this.palettes) {
        if (palette === changedPalette) continue;
        titles.add(palette.name.value);
      }
      const title = changedPalette.name.value;
      if (!titles.has(title)) return;
      let suffix = 0;
      while (true) {
        const modifiedTitle = title + ++suffix;
        if (!titles.has(modifiedTitle)) {
          changedPalette.name.value = modifiedTitle;
          return;
        }
      }
    } finally {
      this.checkingTitles = false;
    }
  }
}

export class MultiToolPaletteManager extends RefCounted {
  private panels = new Map<ToolPaletteState, RegisteredSidePanel>();
  constructor(
    private sidePanelManager: SidePanelManager,
    public state: MultiToolPaletteState,
  ) {
    super();
    const debouncedUpdatePanels = this.registerCancellable(
      animationFrameDebounce(() => this.updatePanels()),
    );
    this.registerDisposer(this.state.changedShallow.add(debouncedUpdatePanels));
    this.updatePanels();
    this.registerDisposer(
      this.sidePanelManager.display.multiChannelSetupFinished.add(() => {
        // Check for the canned shader control palette
        const shaderControlPalette = CANNED_PALETTES[2];
        const existingPalettes = this.state.palettes;
        for (const palette of existingPalettes) {
          if (palette.query.value === shaderControlPalette.query) {
            return;
          }
        }
        const newPalette = this.state.addNew({
          name: shaderControlPalette.name,
          location: {
            ...DEFAULT_TOOL_PALETTE_PANEL_LOCATION,
            side: "left",
            row: 0,
          },
        });
        newPalette.query.value = shaderControlPalette.query;
      }),
    );
  }

  private updatePanels() {
    const { panels } = this;
    const { palettes } = this.state;
    for (const [palette, panel] of panels) {
      if (!palettes.has(palette)) {
        this.sidePanelManager.unregisterPanel(panel);
        panels.delete(palette);
      }
    }

    for (const palette of palettes) {
      if (!panels.has(palette)) {
        const panel = {
          location: palette.location,
          makePanel: () =>
            new ToolPalettePanel(this, this.sidePanelManager, palette),
        };
        panels.set(palette, panel);
        this.sidePanelManager.registerPanel(panel);
      }
    }
  }

  disposed() {
    super.disposed();
    for (const panel of this.panels.values()) {
      this.sidePanelManager.unregisterPanel(panel);
    }
  }
}

export class PaletteNameWidget extends TextInputWidget<string> {
  constructor(public name: TrackableValue<string>) {
    super(name);
    const { element } = this;
    element.classList.add("neuroglancer-tool-palette-name");
    element.title = "Rename tool palette";
  }
}

export class PaletteListDropdownItem extends RefCounted {
  element = document.createElement("li");
  constructor(public state: ToolPaletteState) {
    super();
    const { element } = this;
    element.appendChild(
      this.registerDisposer(
        new TrackableBooleanCheckbox(state.location.watchableVisible, {
          enabledTitle: "Hide tool palette",
          disabledTitle: "Show tool palette",
        }),
      ).element,
    );
    element.appendChild(
      this.registerDisposer(new PaletteNameWidget(state.name)).element,
    );
    const deleteButton = makeDeleteButton({ title: "Delete tool palette" });
    deleteButton.addEventListener("click", () => {
      state.dispose();
    });
    element.appendChild(deleteButton);
  }
}

interface CannedPalette {
  name: string;
  description?: string;
  query: string;
}

class PaletteListCannedDropdownItem {
  element = document.createElement("li");
  constructor(
    public state: MultiToolPaletteState,
    public palette: CannedPalette,
  ) {
    const { element } = this;
    element.classList.add("neuroglancer-tool-palette-dropdown-canned-item");
    element.textContent = palette.description ?? palette.name;
    element.addEventListener("click", () => {
      const newPalette = state.addNew({ name: palette.name });
      newPalette.query.value = palette.query;
    });
  }
}

export const CANNED_PALETTES: CannedPalette[] = [
  { name: "Palette", description: "New empty palette", query: "" },
  { name: "All controls", query: "+" },
  { name: "Shader controls", query: "type:shaderControl" },
];

export class MultiToolPaletteDropdown extends RefCounted {
  element = document.createElement("div");
  itemContainer = document.createElement("ul");
  items = new Map<ToolPaletteState, PaletteListDropdownItem>();
  cannedItems = new Map<CannedPalette, PaletteListCannedDropdownItem>();
  cannedItemSeparator = document.createElement("li");
  constructor(private state: MultiToolPaletteState) {
    super();
    const { element, itemContainer, cannedItemSeparator } = this;
    element.classList.add("neuroglancer-tool-palette-dropdown");

    cannedItemSeparator.classList.add(
      "neuroglancer-tool-palette-dropdown-separator",
    );

    element.appendChild(itemContainer);
    const debouncedUpdateView = this.registerCancellable(
      animationFrameDebounce(() => this.updateView()),
    );
    this.registerDisposer(this.state.changedShallow.add(debouncedUpdateView));
    this.updateView();
  }

  private updateView() {
    const self = this;
    function* getItems() {
      const { palettes } = self.state;
      const seenQueries = new Set();
      const { items } = self;
      for (const palette of palettes) {
        let item = items.get(palette);
        if (item === undefined) {
          item = new PaletteListDropdownItem(palette);
          items.set(palette, item);
        }
        seenQueries.add(palette.query.value);
        yield item.element;
      }
      let firstCannedItem = true;
      const { cannedItems } = self;
      for (const palette of CANNED_PALETTES) {
        if (palette.query !== "" && seenQueries.has(palette.query)) {
          continue;
        }
        let item = cannedItems.get(palette);
        if (item === undefined) {
          item = new PaletteListCannedDropdownItem(self.state, palette);
          cannedItems.set(palette, item);
        }
        if (firstCannedItem) {
          firstCannedItem = false;
          if (palettes.size !== 0) {
            yield self.cannedItemSeparator;
          }
        }
        yield item.element;
      }
      for (const [palette, item] of items) {
        if (!palettes.has(palette)) {
          items.delete(palette);
          item.dispose();
        }
      }
    }
    updateChildren(this.itemContainer, getItems());
  }

  disposed() {
    super.disposed();
    removeFromParent(this.element);
  }
}

export class MultiToolPaletteDropdownButton extends RefCounted {
  countElement = document.createElement("div");
  dropdownVisible = new WatchableValue<boolean>(false);
  dropdown: MultiToolPaletteDropdown | undefined;
  element = document.createElement("div");
  constructor(private state: MultiToolPaletteState) {
    super();
    const { element, countElement } = this;

    const checkbox = this.registerDisposer(
      new CheckboxIcon(this.dropdownVisible, {
        svg: svg_tool,
        enableTitle: "Show tool palette list (control+click to create new)",
        disableTitle: "Hide tool palette list",
        backgroundScheme: "dark",
      }),
    ).element;
    element.appendChild(checkbox);
    element.classList.add("neuroglancer-tool-palette-button");
    element.classList.add("neuroglancer-sticky-focus");
    element.tabIndex = -1;

    const debouncedUpdateView = this.registerCancellable(
      animationFrameDebounce(() => this.updateView()),
    );
    this.registerDisposer(state.changedShallow.add(debouncedUpdateView));
    this.registerDisposer(state.visibleStateChanged.add(debouncedUpdateView));

    element.addEventListener("focusout", (event) => {
      const { relatedTarget } = event;
      if (relatedTarget instanceof Node && !element.contains(relatedTarget)) {
        this.dropdownVisible.value = false;
      }
    });
    checkbox.insertAdjacentElement("afterbegin", countElement);
    this.dropdownVisible.changed.add(() => {
      const visible = this.dropdownVisible.value;
      if (!visible) {
        this.dropdown?.dispose();
        this.dropdown = undefined;
      } else {
        if (this.dropdown === undefined) {
          this.dropdown = new MultiToolPaletteDropdown(this.state);
          this.element.appendChild(this.dropdown.element);
          positionRelativeDropdown(this.dropdown.element, this.element);
        }
      }
    });
    this.updateView();
  }

  private updateView() {
    const totalPalettes = this.state.palettes.size;
    let visiblePalettes = 0;
    for (const palette of this.state.palettes) {
      if (palette.location.visible) ++visiblePalettes;
    }
    this.countElement.textContent =
      visiblePalettes < totalPalettes
        ? `${visiblePalettes}/${totalPalettes}`
        : "";
  }

  disposed() {
    this.dropdown?.dispose();
  }
}
