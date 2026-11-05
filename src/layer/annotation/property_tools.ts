/**
 * @license
 * Copyright 2026 Google Inc.
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

import type {
  AnnotationNumericPropertySpec,
  AnnotationPropertySpec,
} from "#src/annotation/index.js";
import {
  isAnnotationNumericPropertySpec,
  propertyTypeDataType,
} from "#src/annotation/index.js";
import type { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import {
  ANNOTATE_ENUM_PROPERTY_TOOL_ID,
  annotateEnumPropertyToolJson,
  ANNOTATE_NUMBER_PROPERTY_TOOL_ID,
  annotateNumberPropertyToolJson,
  SELECT_NEXT_ANNOTATION_TOOL_ID,
  SELECT_PREVIOUS_ANNOTATION_TOOL_ID,
  TOGGLE_BOOL_PROPERTY_TOOL_ID,
  toggleBoolPropertyToolJson,
} from "#src/layer/annotation/tool_state.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  registerTool,
} from "#src/ui/tool.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { DataType } from "#src/util/data_type.js";
import { removeChildren } from "#src/util/dom.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";
import type { AnyConstructor } from "#src/util/mixin.js";

type AnnotationUserLayerConstructor = AnyConstructor<AnnotationUserLayer>;

function parsePropertyIdentifier(options: unknown) {
  verifyObject(options);
  return verifyObjectProperty(options, "property", verifyString);
}

function getProperty(layer: AnnotationUserLayer, propertyIdentifier: string) {
  return layer.localAnnotationProperties.value.find(
    (property) => property.identifier === propertyIdentifier,
  );
}

export function registerAnnotationPropertyTools(
  contextType: AnnotationUserLayerConstructor,
) {
  registerTool(
    contextType,
    ANNOTATE_ENUM_PROPERTY_TOOL_ID,
    (layer, options) => {
      const propertyIdentifier = parsePropertyIdentifier(options);
      const property = getProperty(layer, propertyIdentifier);
      if (
        property === undefined ||
        !isAnnotationNumericPropertySpec(property) ||
        property.enumValues === undefined
      ) {
        return undefined;
      }
      return new EnumPropertyEntryTool(propertyIdentifier, layer);
    },
  );
  registerTool(contextType, TOGGLE_BOOL_PROPERTY_TOOL_ID, (layer, options) => {
    const propertyIdentifier = parsePropertyIdentifier(options);
    if (getProperty(layer, propertyIdentifier)?.type !== "bool") {
      return undefined;
    }
    return new ToggleBoolPropertyTool(propertyIdentifier, layer);
  });
  registerTool(
    contextType,
    ANNOTATE_NUMBER_PROPERTY_TOOL_ID,
    (layer, options) => {
      const propertyIdentifier = parsePropertyIdentifier(options);
      const property = getProperty(layer, propertyIdentifier);
      if (
        property === undefined ||
        !isAnnotationNumericPropertySpec(property) ||
        property.enumValues !== undefined
      ) {
        return undefined;
      }
      return new NumberPropertyEntryTool(propertyIdentifier, layer);
    },
  );
}

function isCompatiblePropertyTool(
  tool: AnnotationPropertyEntryTool | ToggleBoolPropertyTool,
  property: AnnotationPropertySpec | undefined,
) {
  if (property === undefined) return false;
  if (tool instanceof ToggleBoolPropertyTool) return property.type === "bool";
  if (!isAnnotationNumericPropertySpec(property)) return false;
  if (tool instanceof EnumPropertyEntryTool) {
    return property.enumValues !== undefined;
  }
  return (
    tool instanceof NumberPropertyEntryTool && property.enumValues === undefined
  );
}

export function removeInvalidPropertyToolBindings(layer: AnnotationUserLayer) {
  for (const [key, tool] of layer.toolBinder.bindings) {
    if (
      !(tool instanceof AnnotationPropertyEntryTool) &&
      !(tool instanceof ToggleBoolPropertyTool)
    ) {
      continue;
    }
    const property = getProperty(layer, tool.propertyIdentifier);
    if (!isCompatiblePropertyTool(tool, property)) {
      layer.toolBinder.set(key, undefined);
    }
  }
}

function getSelectedAnnotationProperty(
  layer: AnnotationUserLayer,
  propertyIdentifier: string,
) {
  const context = layer.getSelectedAnnotationContext();
  if (context === undefined) return;
  const { annotationLayerState, annotationId } = context;
  const { source } = annotationLayerState;
  const propertyIndex = source.properties.value.findIndex(
    (property) => property.identifier === propertyIdentifier,
  );
  if (propertyIndex === -1) return;
  return {
    source,
    propertyIndex,
    reference: source.getReference(annotationId),
  };
}

function updateSelectedAnnotationProperty(
  layer: AnnotationUserLayer,
  propertyIdentifier: string,
  computeValue: (currentValue: number) => number,
) {
  const context = getSelectedAnnotationProperty(layer, propertyIdentifier);
  if (context === undefined) return;
  const { source, propertyIndex, reference } = context;
  try {
    const annotation = reference.value;
    if (annotation == null) return;
    const properties = annotation.properties.slice();
    properties[propertyIndex] = computeValue(properties[propertyIndex]);
    source.update(reference, { ...annotation, properties });
    source.commit(reference);
  } finally {
    reference.dispose();
  }
}

function getSelectedAnnotationPropertyValue(
  layer: AnnotationUserLayer,
  propertyIdentifier: string,
): number | undefined {
  const context = getSelectedAnnotationProperty(layer, propertyIdentifier);
  if (context === undefined) return;
  const { propertyIndex, reference } = context;
  try {
    const value = reference.value?.properties[propertyIndex];
    return typeof value === "number" ? value : undefined;
  } finally {
    reference.dispose();
  }
}

export function keyForEnumOptionIndex(index: number): string | undefined {
  if (index < 9) return String(index + 1);
  if (index === 9) return "0";
  return undefined;
}

export function getEnumPropertyBindingConfigurationKey(optionCount: number) {
  return optionCount > 10 ? "numeric" : `direct:${optionCount}`;
}

export function boundKeyEventIdentifier(
  layer: AnnotationUserLayer,
  toolId: string,
): string | undefined {
  const key = layer.toolBinder.jsonToKey.get(JSON.stringify(toolId));
  return key === undefined ? undefined : `key${key.toLowerCase()}`;
}

type EntryKeyBinder = (
  eventKey: string,
  action: string,
  handler: (event: ActionEvent<Event>) => void,
) => void;

interface NumericEntryOptions {
  isFloat: () => boolean;
  allowNegative: () => boolean;
  range: () => [number, number];
  currentValue: () => number | undefined;
  commit: (value: number) => void;
}

export class NumericEntryBuffer {
  private buffer = "";

  constructor(private readonly options: NumericEntryOptions) {}

  reset() {
    this.buffer = "";
  }

  private parse(): number | undefined {
    if (this.buffer === "" || this.buffer === "-" || this.buffer === ".") {
      return undefined;
    }
    const value = this.options.isFloat()
      ? Number.parseFloat(this.buffer)
      : Number.parseInt(this.buffer, 10);
    return Number.isFinite(value) ? value : undefined;
  }

  private get outOfRange(): boolean {
    const value = this.parse();
    if (value === undefined) return false;
    const [min, max] = this.options.range();
    return value < min || value > max;
  }

  bindKeys(
    addBinding: EntryKeyBinder,
    requestRefresh: () => void,
    activation: ToolActivation,
  ) {
    const append = (character: string) => (event: ActionEvent<Event>) => {
      event.stopPropagation();
      if (character === "-" && this.buffer.length > 0) return;
      if (character === "." && this.buffer.includes(".")) return;
      this.buffer += character;
      requestRefresh();
    };
    for (let digit = 0; digit <= 9; ++digit) {
      addBinding(
        `digit${digit}`,
        `annotation-number-${digit}`,
        append(String(digit)),
      );
    }
    if (this.options.isFloat()) {
      addBinding("period", "annotation-number-decimal", append("."));
    }
    if (this.options.allowNegative()) {
      addBinding("minus", "annotation-number-minus", append("-"));
    }
    addBinding("backspace", "annotation-number-backspace", (event) => {
      event.stopPropagation();
      this.buffer = this.buffer.slice(0, -1);
      requestRefresh();
    });
    addBinding("enter", "annotation-number-commit", (event) => {
      event.stopPropagation();
      const value = this.parse();
      if (value === undefined || this.outOfRange) return;
      this.options.commit(value);
      this.buffer = "";
      requestRefresh();
    });
    addBinding("escape", "annotation-number-exit", (event) => {
      event.stopPropagation();
      activation.cancel();
    });
  }

  render(container: HTMLElement) {
    const box = document.createElement("div");
    box.classList.add("neuroglancer-annotation-entry-tool-number");
    box.textContent =
      this.buffer !== ""
        ? this.buffer
        : `${this.options.currentValue() ?? "—"}`;
    if (this.outOfRange) {
      box.classList.add("neuroglancer-annotation-entry-tool-number-invalid");
    }
    container.appendChild(box);
  }
}

export abstract class AnnotationPropertyEntryTool extends LayerTool<AnnotationUserLayer> {
  constructor(
    public propertyIdentifier: string,
    layer: AnnotationUserLayer,
  ) {
    super(layer, true);
  }

  protected get property(): AnnotationPropertySpec | undefined {
    return getProperty(this.layer, this.propertyIdentifier);
  }

  protected get currentValue(): number | undefined {
    return getSelectedAnnotationPropertyValue(
      this.layer,
      this.propertyIdentifier,
    );
  }

  protected abstract readonly modeVerb: string;

  protected configureValueBindings(
    _addBinding: EntryKeyBinder,
    _requestRefresh: () => void,
    _activation: ToolActivation<this>,
  ): void {}

  protected renderValue(
    _valueContainer: HTMLElement,
    _entrySlot: HTMLElement,
  ): void {}

  protected onAnnotationChanged(): void {}

  protected navHintSuffix(): string {
    return "";
  }

  protected bindingConfigurationKey(): string {
    return this.property?.type ?? "";
  }

  protected navKeyInfo() {
    const prevKey = boundKeyEventIdentifier(
      this.layer,
      SELECT_PREVIOUS_ANNOTATION_TOOL_ID,
    );
    const nextKey = boundKeyEventIdentifier(
      this.layer,
      SELECT_NEXT_ANNOTATION_TOOL_ID,
    );
    const labels: string[] = [];
    if (prevKey !== undefined)
      labels.push(`${prevKey.slice(3).toUpperCase()} prev`);
    if (nextKey !== undefined)
      labels.push(`${nextKey.slice(3).toUpperCase()} next`);
    const hint =
      labels.length > 0
        ? `${labels.join(" · ")} annotation`
        : "bind the prev/next annotation tools to navigate here";
    return { prevKey, nextKey, hint };
  }

  activate(activation: ToolActivation<this>) {
    const { layer, propertyIdentifier } = this;
    const { header, body } = makeToolActivationStatusMessageWithHeader(
      activation,
      { showBindings: false },
    );
    const valueContainer = document.createElement("div");
    valueContainer.classList.add("neuroglancer-annotation-entry-tool-values");
    body.appendChild(valueContainer);
    const navLine = document.createElement("div");
    navLine.classList.add("neuroglancer-annotation-entry-tool-nav-line");
    const entrySlot = document.createElement("span");
    navLine.appendChild(entrySlot);
    const navText = document.createElement("span");
    navText.classList.add("neuroglancer-annotation-entry-tool-nav");
    navLine.appendChild(navText);
    body.appendChild(navLine);

    const refresh = () => {
      const property = this.property;
      header.textContent =
        property === undefined
          ? `Property "${propertyIdentifier}" unavailable`
          : `${this.modeVerb} ${propertyIdentifier}`;
      this.renderValue(valueContainer, entrySlot);
    };
    const debouncedRefresh = activation.registerCancellable(
      animationFrameDebounce(refresh),
    );
    const bindingConfigurationKey = this.bindingConfigurationKey();
    const bindings: { [key: string]: string } = {};
    const handlers: Array<[string, (event: ActionEvent<Event>) => void]> = [];
    const addBinding: EntryKeyBinder = (eventKey, action, handler) => {
      bindings[eventKey] = action;
      handlers.push([action, handler]);
    };

    this.configureValueBindings(addBinding, debouncedRefresh, activation);
    const { prevKey, nextKey, hint } = this.navKeyInfo();
    const navigate = (offset: number) => (event: ActionEvent<Event>) => {
      event.stopPropagation();
      layer.shiftSelectedIndexBy(offset);
    };
    if (prevKey !== undefined) {
      addBinding(prevKey, "annotation-entry-prev", navigate(-1));
    }
    if (nextKey !== undefined) {
      addBinding(nextKey, "annotation-entry-next", navigate(1));
    }
    navText.textContent = hint + this.navHintSuffix();

    activation.bindInputEventMap(EventActionMap.fromObject(bindings));
    for (const [action, handler] of handlers) {
      activation.bindAction(action, handler);
    }
    activation.registerDisposer(
      layer.manager.root.selectionState.changed.add(() => {
        this.onAnnotationChanged();
        debouncedRefresh();
      }),
    );
    activation.registerDisposer(
      layer.localAnnotationProperties.changed.add(() => {
        if (this.bindingConfigurationKey() === bindingConfigurationKey) {
          debouncedRefresh();
          return;
        }
        // Input bindings are fixed per activation.
        activation.cancel();
      }),
    );
    this.onAnnotationChanged();
    refresh();
  }

  get description() {
    return `${this.modeVerb.toLowerCase()} ${this.propertyIdentifier}`;
  }

  protected appendChip(
    container: HTMLElement,
    key: string,
    label: string,
    active: boolean,
  ) {
    const chip = document.createElement("div");
    chip.classList.add("neuroglancer-annotation-entry-tool-chip");
    if (active) {
      chip.classList.add("neuroglancer-annotation-entry-tool-chip-active");
    }
    const keyElement = document.createElement("span");
    keyElement.classList.add("neuroglancer-annotation-entry-tool-chip-key");
    keyElement.textContent = key;
    const labelElement = document.createElement("span");
    labelElement.classList.add("neuroglancer-annotation-entry-tool-chip-label");
    labelElement.textContent = label;
    chip.appendChild(keyElement);
    chip.appendChild(labelElement);
    container.appendChild(chip);
  }
}

export class EnumPropertyEntryTool extends AnnotationPropertyEntryTool {
  protected readonly modeVerb = "Set";

  protected bindingConfigurationKey(): string {
    return getEnumPropertyBindingConfigurationKey(
      this.numericProperty?.enumValues?.length ?? 0,
    );
  }

  private readonly entry = new NumericEntryBuffer({
    isFloat: () => false,
    allowNegative: () => false,
    range: () => [1, this.numericProperty?.enumValues?.length ?? 0],
    currentValue: () => {
      const enumValues = this.numericProperty?.enumValues ?? [];
      const index =
        this.currentValue === undefined
          ? -1
          : enumValues.indexOf(this.currentValue);
      return index === -1 ? undefined : index + 1;
    },
    commit: (optionNumber) => {
      const value = this.numericProperty?.enumValues?.[optionNumber - 1];
      if (value === undefined) return;
      updateSelectedAnnotationProperty(
        this.layer,
        this.propertyIdentifier,
        () => value,
      );
    },
  });

  private get numericProperty(): AnnotationNumericPropertySpec | undefined {
    const property = this.property;
    return property !== undefined && isAnnotationNumericPropertySpec(property)
      ? property
      : undefined;
  }

  private get useNumberEntry(): boolean {
    return (this.numericProperty?.enumValues?.length ?? 0) > 10;
  }

  protected configureValueBindings(
    addBinding: EntryKeyBinder,
    requestRefresh: () => void,
    activation: ToolActivation<this>,
  ) {
    if (this.useNumberEntry) {
      this.entry.bindKeys(addBinding, requestRefresh, activation);
      return;
    }
    const enumValues = this.numericProperty?.enumValues ?? [];
    for (let index = 0; index < Math.min(enumValues.length, 10); ++index) {
      addBinding(
        `digit${keyForEnumOptionIndex(index)}`,
        `annotation-enum-option-${index}`,
        (event) => {
          event.stopPropagation();
          const value = this.numericProperty?.enumValues?.[index];
          if (value === undefined) return;
          updateSelectedAnnotationProperty(
            this.layer,
            this.propertyIdentifier,
            () => value,
          );
          requestRefresh();
        },
      );
    }
  }

  protected renderValue(valueContainer: HTMLElement, entrySlot: HTMLElement) {
    removeChildren(valueContainer);
    removeChildren(entrySlot);
    const property = this.numericProperty;
    const enumValues = property?.enumValues ?? [];
    const enumLabels = property?.enumLabels ?? [];
    const currentValue = this.currentValue;
    const useNumberEntry = this.useNumberEntry;
    // Ten options fit 1-9 and 0; larger enums use buffered 1-based entry.
    enumValues.forEach((value, index) => {
      this.appendChip(
        valueContainer,
        useNumberEntry
          ? String(index + 1)
          : (keyForEnumOptionIndex(index) ?? String(index + 1)),
        enumLabels[index] ?? String(value),
        value === currentValue,
      );
    });
    if (useNumberEntry) this.entry.render(entrySlot);
  }

  protected onAnnotationChanged() {
    this.entry.reset();
  }

  protected navHintSuffix() {
    return this.useNumberEntry ? "  ·  Enter to set · Esc to exit" : "";
  }

  toJSON() {
    return annotateEnumPropertyToolJson(this.propertyIdentifier);
  }
}

export class ToggleBoolPropertyTool extends LayerTool<AnnotationUserLayer> {
  constructor(
    public propertyIdentifier: string,
    layer: AnnotationUserLayer,
  ) {
    super(layer);
  }

  activate(activation: ToolActivation<this>) {
    updateSelectedAnnotationProperty(
      this.layer,
      this.propertyIdentifier,
      (currentValue) => (currentValue ? 0 : 1),
    );
    activation.cancel();
  }

  toJSON() {
    return toggleBoolPropertyToolJson(this.propertyIdentifier);
  }

  get description() {
    return `toggle ${this.propertyIdentifier}`;
  }
}

export class NumberPropertyEntryTool extends AnnotationPropertyEntryTool {
  protected readonly modeVerb = "Set";

  private get isFloat(): boolean {
    return this.property?.type === "float32";
  }

  private get dataType(): DataType | undefined {
    const type = this.property?.type;
    return type === undefined ? undefined : propertyTypeDataType[type];
  }

  private range(): [number, number] {
    const { dataType } = this;
    if (dataType === undefined) return [-Infinity, Infinity];
    if (dataType === DataType.FLOAT32) {
      return [-3.40282347e38, 3.40282347e38];
    }
    return defaultDataTypeRange[dataType] as [number, number];
  }

  private readonly entry = new NumericEntryBuffer({
    isFloat: () => this.isFloat,
    allowNegative: () => this.range()[0] < 0,
    range: () => this.range(),
    currentValue: () => this.currentValue,
    commit: (value) =>
      updateSelectedAnnotationProperty(
        this.layer,
        this.propertyIdentifier,
        () => (this.isFloat ? value : Math.round(value)),
      ),
  });

  protected configureValueBindings(
    addBinding: EntryKeyBinder,
    requestRefresh: () => void,
    activation: ToolActivation<this>,
  ) {
    this.entry.bindKeys(addBinding, requestRefresh, activation);
  }

  protected renderValue(valueContainer: HTMLElement, entrySlot: HTMLElement) {
    removeChildren(valueContainer);
    removeChildren(entrySlot);
    this.entry.render(entrySlot);
  }

  protected onAnnotationChanged() {
    this.entry.reset();
  }

  protected navHintSuffix() {
    return "  ·  Enter to set · Esc to exit";
  }

  toJSON() {
    return annotateNumberPropertyToolJson(this.propertyIdentifier);
  }
}
