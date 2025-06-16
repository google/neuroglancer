/**
 * @license
 * Copyright 2025 Google Inc.
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
 * @file User interface for viewing and editing the annotation schema.
 * See https://github.com/google/neuroglancer/blob/master/src/datasource/precomputed/annotations.md
 */

import svg_numbers from "ikonate/icons/hash.svg?raw";
import svg_palette from "ikonate/icons/drop.svg?raw";
import svg_check from "ikonate/icons/ok-circle.svg?raw";
import svg_clipboard from "ikonate/icons/clipboard.svg?raw";
import svg_bin from "ikonate/icons/bin.svg?raw";
import svg_download from "ikonate/icons/download.svg?raw";
import svg_format_size from "ikonate/icons/text.svg?raw";
import "#src/ui/annotation_schema_tab.css";
import { AnnotationDisplayState } from "#src/annotation/annotation_layer_state.js";
import type {
  AnnotationColorPropertySpec,
  AnnotationNumericPropertySpec,
  AnnotationPropertySpec,
  LocalAnnotationSource,
} from "#src/annotation/index.js";
import {
  annotationPropertySpecsToJson,
  canConvertTypes,
  compareAnnotationSpecProperties,
  isAnnotationTypeNumeric,
  parseAnnotationPropertySpecs,
  propertyTypeDataType,
} from "#src/annotation/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted, type Borrowed } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";
import { makeAddButton } from "#src/widget/add_button.js";
import { makeCopyButton } from "#src/widget/copy_button.js";
import { makeIcon } from "#src/widget/icon.js";
import { Tab } from "#src/widget/tab_view.js";
import { saveBlobToFile } from "#src/util/file_download.js";
import { StatusMessage } from "#src/status.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";
import { DataType } from "#src/util/data_type.js";
import { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { packColor, unpackRGB, unpackRGBA } from "#src/util/color.js";
import { vec3, vec4 } from "#src/util/geom.js";
import { ColorWidget } from "#src/widget/color.js";
import { removeChildren } from "#src/util/dom.js";
import { NullarySignal } from "#src/util/signal.js";
import { numberToStringFixed } from "#src/util/number_to_string.js";

const ANNOTATION_TYPES: AnnotationType[] = [
  "rgb",
  "rgba",
  "float32",
  "int8",
  "int16",
  "int32",
  "uint8",
  "uint16",
  "uint32",
];
const ANNOTATION_UI_TYPES: AnnotationUIType[] = ["bool", ...ANNOTATION_TYPES];

type AnnotationType = AnnotationPropertySpec["type"];
type AnnotationUIType = AnnotationType | "bool";

interface InputConfig {
  type: string;
  value?: number | string;
  className?: string;
}

interface NumberConfig {
  min?: number;
  max?: number;
  step?: number;
}

function isBooleanType(enumValues?: string[]): boolean {
  return (
    (enumValues?.includes("False") &&
      enumValues?.includes("True") &&
      enumValues.length === 2) ||
    false
  );
}
function isEnumType(enumValues?: string[]): boolean {
  return (enumValues && enumValues.length > 0) || false;
}

class AnnotationUIProperty extends RefCounted {
  public element: HTMLDivElement = document.createElement("div");
  private defaultValueElements: HTMLInputElement[] = [];
  private typeChangeDropdown: HTMLDivElement | null = null;
  private typeChanged = new NullarySignal();
  constructor(
    public spec: AnnotationPropertySpec,
    private parentView: AnnotationSchemaView,
  ) {
    super();
    this.spec = spec;
    this.element.classList.add("neuroglancer-annotation-schema-row");
    this.makeUI();
  }
  get readonly() {
    return this.parentView.readonly.value;
  }
  private removeProperty(indentifier: string) {
    this.parentView.annotationUIProperties.delete(indentifier);
    this.parentView.removeProperty(indentifier);
  }
  private renameProperty(oldIdentifier: string, newIdentifier: string) {
    const oldProperty = this.getPropertyByIdentifier(oldIdentifier);
    if (oldProperty === undefined) {
      console.warn(`Property with name ${oldIdentifier} not found.`);
      return;
    }
    this.updateProperty(oldProperty, {
      ...oldProperty,
      identifier: newIdentifier,
    });
  }
  private getPropertyByIdentifier(
    identifier: string,
  ): AnnotationPropertySpec | undefined {
    return this.parentView.getPropertyByIdentifier(identifier);
  }
  private updateProperty<T extends AnnotationPropertySpec>(
    oldProperty: T,
    newProperty: T,
  ) {
    this.parentView.updateProperty(oldProperty, newProperty);
  }
  private createTableCell(
    content: string | HTMLElement,
    className?: string,
  ): HTMLDivElement {
    return this.parentView.createTableCell(content, className);
  }
  private ensureUniquePropertyIdentifier(identifier: string) {
    return this.parentView.ensureUniquePropertyIdentifier(identifier);
  }
  private getDisplayNameForType(
    type: AnnotationUIType,
    enumLabels?: string[],
  ): string {
    return this.parentView.getDisplayNameForType(type, enumLabels);
  }
  private getIconForType(
    type: AnnotationUIType,
    enumLabels?: string[],
  ): string {
    return this.parentView.getIconForType(type, enumLabels);
  }
  public setNumericDefaultValueOnly(defaultValue: number) {
    // For numeric types, we can set the default value directly
    const type = this.spec.type;
    if (isAnnotationTypeNumeric(type)) {
      this.defaultValueElements[0].value = numberToStringFixed(defaultValue, 4);
    }
  }
  makeUI() {
    const { element, spec, readonly } = this;
    const enumLabels = "enumLabels" in spec ? spec.enumLabels : undefined;
    element.appendChild(this.createNameCell(spec.identifier));
    element.appendChild(
      this.createTypeCell(spec.type, spec.identifier, enumLabels),
    );
    element.appendChild(
      this.createDefaultValueCell(spec.identifier, spec.type),
    );

    // TODO skm needs to listen?
    // Delete Cell
    if (!readonly) {
      const deleteIcon = document.createElement("span");
      deleteIcon.innerHTML = svg_bin;
      deleteIcon.title = "Delete annotation property";
      deleteIcon.style.cursor = "pointer";
      deleteIcon.addEventListener("click", () => {
        const propertyIdentifer = spec.identifier;
        this.removeProperty(propertyIdentifer);
      });

      const deleteCell = this.createTableCell(
        deleteIcon,
        "neuroglancer-annotation-schema-delete-cell",
      );
      element.appendChild(deleteCell);
    }
  }

  private createNameCell(identifier: string): HTMLDivElement {
    const nameInput = this.createInputElement({
      type: "text",
      value: identifier,
      className: "neuroglancer-annotation-schema-name-input",
    });
    const cell = this.createTableCell(nameInput, "");
    nameInput.dataset.readonly = String(this.readonly);
    if (this.readonly) return cell;
    this.registerEventListener(nameInput, "change", (event: Event) => {
      // If the input is readonly, we don't want to do anything
      if (this.readonly) return;
      const rawValue = (event.target as HTMLInputElement).value;
      let sanitizedValue = rawValue.replace(/\s+/g, "_");
      if (sanitizedValue === "") {
        sanitizedValue = identifier;
      } else {
        sanitizedValue = this.ensureUniquePropertyIdentifier(sanitizedValue);
      }
      this.renameProperty(identifier, sanitizedValue);
    });
    return cell;
  }

  private createTypeCell(
    type: AnnotationType,
    identifier: string,
    enumLabels?: string[],
  ): HTMLDivElement {
    const typeText = this.createTypeTextElement(type, enumLabels);
    const iconWrapper = this.createIconWrapper(type, enumLabels);
    const typeCell = this.createTableCell(
      iconWrapper,
      "neuroglancer-annotation-schema-type-cell",
    );
    typeCell.appendChild(typeText);

    const isBoolean = isBooleanType(enumLabels);
    const readonly = this.readonly || isBoolean;
    typeCell.dataset.readonly = String(readonly);
    if (!readonly) {
      typeCell.title =
        "You can convert to a higher precision, but not back to lower precision.";
      this.registerEventListener(typeCell, "click", (e: MouseEvent) => {
        e.stopPropagation();
        this.showTypeChangeDropdown(typeCell, type, identifier);
      });
    }

    return typeCell;
  }

  private createDefaultValueCell(
    identifier: string,
    type: AnnotationType | "bool",
  ): HTMLDivElement {
    const container = document.createElement("div");
    container.className =
      "neuroglancer-annotation-schema-default-value-cell-container";

    let inputs: HTMLInputElement[] = [];
    let changeFunction: (event: Event) => void;
    const oldProperty = this.getPropertyByIdentifier(identifier);
    if (oldProperty === undefined) {
      console.warn(`Property with name ${identifier} not found.`);
      return this.createTableCell(
        container,
        "neuruoglancer-annotation-schema-default-value-cell",
      );
    }
    if (type.startsWith("rgb")) {
      const watchableColor = new WatchableValue(unpackRGB(oldProperty.default));
      const colorInput = new ColorWidget(watchableColor);
      colorInput.element.className =
        "neuroglancer-annotation-schema-color-input";
      inputs.push(colorInput.element);
      changeFunction = () => {
        const newColor = colorInput.getRGB();
        this.updateProperty(oldProperty, {
          ...oldProperty,
          default: packColor(newColor),
        } as AnnotationColorPropertySpec);
      };
      if (type === "rgba") {
        const alpha = unpackRGBA(oldProperty.default)[3];
        const alphaInput = this.createInputElement(
          {
            type: "number",
            value: alpha.toFixed(2),
            className: "neuroglancer-annotation-schema-default-input",
          },
          { min: 0, max: 1, step: 0.01 },
        );
        inputs.push(alphaInput);
        changeFunction = () => {
          const newColor = colorInput.getRGB();
          const newAlpha = parseFloat(alphaInput.value);
          const colorVec = vec4.fromValues(
            newColor[0],
            newColor[1],
            newColor[2],
            newAlpha,
          );
          console.log("newColor: ", newColor, packColor(colorVec));
          this.updateProperty(oldProperty, {
            ...oldProperty,
            default: packColor(colorVec),
          } as AnnotationColorPropertySpec);
        };
      }
    } else if (
      type.startsWith("int") ||
      type.startsWith("uint") ||
      type === "float32"
    ) {
      const oldProperty = this.getPropertyByIdentifier(
        identifier,
      ) as AnnotationNumericPropertySpec;
      const { enumValues, enumLabels } = oldProperty;
      if (enumValues === undefined || enumLabels === undefined) {
        const dataType = propertyTypeDataType[type as AnnotationType];
        const step = dataType === DataType.FLOAT32 ? 0.01 : 1;
        const bounds =
          dataType === DataType.FLOAT32
            ? [undefined, undefined]
            : defaultDataTypeRange[dataType!];

        const numberInput = this.createInputElement(
          {
            type: "number",
            value: String(oldProperty.default),
            className: "neuroglancer-annotation-schema-default-input",
          },
          {
            min: bounds[0] as number,
            max: bounds[1] as number,
            step: step,
          },
        );
        inputs.push(numberInput);
        changeFunction = (event: Event) => {
          const newValue = (event.target as HTMLInputElement).value;
          this.updateProperty(oldProperty, {
            ...oldProperty,
            default:
              dataType === DataType.FLOAT32
                ? parseFloat(newValue)
                : parseInt(newValue, 10),
          } as AnnotationNumericPropertySpec);
        };
      } else {
        const enumContainer = document.createElement("div");
        enumContainer.className = "enum-container";
        const addEnumButton = makeAddButton({
          title: "Add new enum option",
          onClick: () => {
            let suggestedEnumValue = 0;
            while (enumValues.includes(suggestedEnumValue))
              ++suggestedEnumValue;
            this.updateProperty(oldProperty, {
              ...oldProperty,
              enumValues: [...oldProperty.enumValues!, suggestedEnumValue],
              enumLabels: [
                ...oldProperty.enumLabels!,
                `${suggestedEnumValue} (label)`,
              ],
            } as AnnotationNumericPropertySpec);
          },
        });
        enumContainer.appendChild(addEnumButton);
        // For each enum entry, create a row with name, and value
        const addEnumEntry = (
          value: number,
          label: string,
          enumIndex: number,
        ) => {
          const enumRow = document.createElement("div");
          enumRow.className = "neuroglancer-annotation-schema-enum-entry";

          // TODO ideally this should stop you from adding the same enum value
          // or the same label
          const nameInput = this.createInputElement({
            type: "text",
            value: label,
            className: "neuroglancer-annotation-schema-default-input",
          });
          nameInput.addEventListener("change", (event) => {
            const newLabel = (event.target as HTMLInputElement).value;
            this.updateProperty(oldProperty, {
              ...oldProperty,
              enumLabels: oldProperty.enumLabels!.map((l, i) =>
                i === enumIndex ? newLabel : l,
              ),
            } as AnnotationNumericPropertySpec);
          });

          const valueInput = this.createInputElement({
            type: "number",
            value: String(value),
            className: "neuroglancer-annotation-schema-default-input",
          });
          valueInput.addEventListener("change", (event) => {
            const inputValue = (event.target as HTMLInputElement).value;
            const newValue =
              type === "float32"
                ? parseFloat(inputValue)
                : parseInt(inputValue, 10);
            this.updateProperty(oldProperty, {
              ...oldProperty,
              enumValues: oldProperty.enumValues!.map((v, i) =>
                i === enumIndex ? newValue : v,
              ),
            } as AnnotationNumericPropertySpec);
          });

          enumRow.appendChild(nameInput);
          enumRow.appendChild(valueInput);

          if (!this.readonly) {
            const deleteIcon = document.createElement("span");
            deleteIcon.className = "neuroglancer-annotation-schema-delete-icon";
            deleteIcon.innerHTML = svg_bin;
            deleteIcon.title = "Delete enum row";
            deleteIcon.style.cursor = "pointer";
            deleteIcon.addEventListener("click", () => {
              const newEnumValues = oldProperty.enumValues!.filter(
                (_, i) => i !== enumIndex,
              );
              const newEnumLabels = oldProperty.enumLabels!.filter(
                (_, i) => i !== enumIndex,
              );

              this.updateProperty(oldProperty, {
                ...oldProperty,
                enumValues: newEnumValues,
                enumLabels: newEnumLabels,
              } as AnnotationNumericPropertySpec);

              enumRow.remove();
            });
            enumRow.appendChild(deleteIcon);
          }
          enumContainer.insertBefore(enumRow, addEnumButton);
        };
        for (let i = 0; i < enumValues.length; i++) {
          addEnumEntry(enumValues[i], enumLabels[i], i);
        }

        container.appendChild(enumContainer);
      }
    }
    // TODO (SKM) - again may need to unregister the event listeners
    inputs.forEach((input) => {
      container.appendChild(input);
      if (!this.readonly) {
        this.registerEventListener(input, "change", changeFunction);
      }
    });
    this.defaultValueElements = inputs;
    const cell = this.createTableCell(
      container,
      "neuroglancer-annotation-schema-default-value-cell",
    );
    cell.dataset.enums = String(this.parentView.includesEnumProperties());
    return cell;
  }
  private createInputElement(
    config: InputConfig,
    numberConfig?: NumberConfig,
  ): HTMLInputElement {
    const input = document.createElement("input");
    const readonly = this.readonly;
    input.dataset.readonly = String(readonly);
    input.disabled = readonly;
    if (!this.readonly && config.type === "number") {
      if (numberConfig?.min !== undefined) input.min = String(numberConfig.min);
      if (numberConfig?.max !== undefined) input.max = String(numberConfig.max);
      if (numberConfig?.step !== undefined)
        input.step = String(numberConfig.step);
      this.registerEventListener(input, "wheel", (event: WheelEvent) => {
        const deltaY = event.deltaY;
        if (deltaY === 0) return; // No change
        const currentValue = parseFloat(input.value);
        const step = numberConfig?.step || 1;
        const newValue = deltaY < 0 ? currentValue + step : currentValue - step;
        // Ensure the new value is within bounds
        if (
          (numberConfig?.min === undefined || newValue >= numberConfig.min) &&
          (numberConfig?.max === undefined || newValue <= numberConfig.max)
        ) {
          input.value = String(newValue);
          // Trigger change event
          const changeEvent = new Event("change", { bubbles: true });
          input.dispatchEvent(changeEvent);
        }
      });
    }
    input.type = config.type;
    console.log("input type: ", config.type, "hi");
    if (typeof config.value === "number") {
      input.value = numberToStringFixed(config.value, 4); // For numbers, format to 2 decimal places
    } else {
      input.value = config.value || "";
    }
    input.autocomplete = "off";
    input.spellcheck = false;
    if (config.className) input.classList.add(config.className);
    return input;
  }
  private createTypeTextElement(
    type: AnnotationType,
    enumLabels?: string[],
  ): HTMLSpanElement {
    const typeText = document.createElement("span");

    if (isBooleanType(enumLabels)) {
      typeText.textContent = "Boolean";
      return typeText;
    }
    const displayName = this.getDisplayNameForType(type);
    if (isEnumType(enumLabels)) {
      typeText.textContent = `${displayName} Enum`;
    } else {
      typeText.textContent = displayName;
    }

    return typeText;
  }
  private showTypeChangeDropdown(
    anchorElement: HTMLElement,
    currentType: AnnotationType,
    identifier: string,
  ) {
    const availableOptions: AnnotationType[] = [];
    for (const type of ANNOTATION_TYPES) {
      if (canConvertTypes(currentType, type)) {
        availableOptions.push(type);
      }
    }

    if (!this.typeChangeDropdown) {
      this.createDropdownElement(availableOptions, identifier);
    }
    const dropdown = this.typeChangeDropdown!;

    document.body.appendChild(dropdown);
    this.positionDropdown(dropdown, anchorElement);
    const clickOutsideHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove();
        document.removeEventListener("click", clickOutsideHandler);
      }
    };
    document.addEventListener("click", clickOutsideHandler);
    this.registerDisposer(
      this.typeChanged.add(() =>
        document.removeEventListener("click", clickOutsideHandler),
      ),
    );
  }

  // TODO a bit unfortunate that we can open multiple of these
  private createDropdownElement(
    availableOptions: AnnotationType[],
    identifier: string,
  ) {
    const dropdown = document.createElement("div");
    dropdown.className = "neuroglancer-annotation-schema-dropdown";

    const header = document.createElement("div");
    header.className = "neuroglancer-annotation-schema-dropdown-header";
    header.textContent = "Change type (click to select)";
    dropdown.appendChild(header);

    availableOptions.forEach((newType) => {
      const option = document.createElement("div");
      option.className = "neuroglancer-annotation-schema-dropdown-option";

      const iconWrapper = this.createIconWrapper(newType);
      const label = document.createElement("span");
      label.textContent = this.getDisplayNameForType(newType);

      option.appendChild(iconWrapper);
      option.appendChild(label);

      this.registerEventListener(option, "click", (e: MouseEvent) => {
        e.stopPropagation();
        this.handleTypeChange(newType, identifier);
        dropdown.remove();
      });
      dropdown.appendChild(option);
    });
    this.typeChangeDropdown = dropdown;
  }
  private createIconWrapper(
    type: AnnotationType,
    enumLabels?: string[],
  ): HTMLSpanElement {
    const iconWrapper = document.createElement("span");
    iconWrapper.classList.add(
      "neuroglancer-annotation-schema-cell-icon-wrapper",
    );
    iconWrapper.innerHTML = this.getIconForType(type, enumLabels);
    return iconWrapper;
  }

  private positionDropdown(
    dropdown: HTMLDivElement,
    anchorElement: HTMLElement,
  ) {
    const rect = anchorElement.getBoundingClientRect();
    dropdown.style.position = "absolute";
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom}px`;
  }

  private handleTypeChange(newType: AnnotationType, identifier: string) {
    const oldProperty = this.getPropertyByIdentifier(identifier);
    if (oldProperty === undefined) {
      console.warn(`Property with name ${identifier} not found.`);
      return;
    }
    let defaultValue = oldProperty.default;
    if (oldProperty.type === "rgb" && newType === "rgba") {
      // Add alpha = 1 to the default value
      const oldColor = unpackRGB(oldProperty.default);
      const newColor = vec4.fromValues(
        oldColor[0],
        oldColor[1],
        oldColor[2],
        1,
      );
      defaultValue = packColor(newColor);
    }

    this.typeChanged.dispatch();
    this.updateProperty(oldProperty, {
      ...oldProperty,
      type: newType,
      default: defaultValue,
    });
  }
}

export class AnnotationSchemaView extends Tab {
  get annotationStates() {
    return this.layer.annotationStates;
  }

  private schemaTable = document.createElement("div");
  private schemaTableBody = document.createElement("div");
  private schemaTableAddButtonField = document.createElement("div");
  private schemaViewTextElement = document.createElement("p");
  private schemaPasteButton: HTMLElement;
  private schema: Readonly<AnnotationPropertySpec[]> = [];
  public annotationUIProperties: Map<string, AnnotationUIProperty> = new Map();
  public readonly: WatchableValueInterface<boolean>;

  constructor(
    public layer: Borrowed<UserLayerWithAnnotations>,
    public displayState: AnnotationDisplayState,
  ) {
    super();
    this.readonly = new WatchableValue(
      this.annotationStates.states.every((state) => state.source.readonly),
    );
    this.element.classList.add("neuroglancer-annotation-schema-view");
    this.schemaTable.className = "neuroglancer-annotation-schema-grid";
    this.makeUI();
    this.updateOnReadonlyChange();
    this.updateView();

    this.registerDisposer(
      this.annotationStates.changed.add(() => {
        this.updateView();
      }),
    );
    this.registerDisposer(
      this.readonly.changed.add(() => {
        this.updateOnReadonlyChange();
      }),
    );
  }

  private updateOnReadonlyChange = () => {
    this.updateAnnotationText();
    this.updateElementVisibility();
  };

  private updateAnnotationText() {
    const setOrViewText = this.readonly.value ? "View read-only" : "Set";
    this.schemaViewTextElement.textContent = `${setOrViewText} annotation property (metadata) schema for this layer which applies to all annotations in this layer.`;
  }

  private updateElementVisibility() {
    this.schemaPasteButton.style.display = this.readonly.value ? "none" : "";
    this.schemaTableAddButtonField.style.display = this.readonly.value
      ? "none"
      : "";
  }

  private makeUI() {
    const schemaTextContainer = document.createElement("div");
    const schemaActionButtons = document.createElement("div");
    schemaTextContainer.className =
      "neuroglancer-annotation-schema-text-container";
    schemaActionButtons.className =
      "neuroglancer-annotation-schema-action-buttons";
    schemaTextContainer.appendChild(this.schemaViewTextElement);
    schemaTextContainer.appendChild(schemaActionButtons);

    const downloadButton = makeIcon({
      title: "Download schema",
      svg: svg_download,
      onClick: () => this.downloadSchema(),
    });
    schemaActionButtons.appendChild(downloadButton);

    const copyButton = makeCopyButton({
      title: "Copy schema to clipboard",
      onClick: () => this.copySchemaToClipboard(),
    });
    schemaActionButtons.appendChild(copyButton);

    this.schemaPasteButton = makeIcon({
      title: "Paste schema from clipboard",
      svg: svg_clipboard,
      onClick: () => this.pasteSchemaFromClipboard(),
    });
    schemaActionButtons.appendChild(this.schemaPasteButton);

    this.element.appendChild(schemaTextContainer);
    this.element.appendChild(this.schemaTable);
    this.createSchemaTableHeader();
    this.schemaTable.appendChild(this.schemaTableBody);
    this.schemaTableBody.className =
      "neuroglancer-annotation-schema-table-body";
    this.createAnnotationSchemaDropdown();
  }

  private updateSchemaRepresentation() {
    // Check to see if the new IDs match the old keys
    const oldKeys = Array.from(this.annotationUIProperties.keys());
    const newKeys = this.schema.map((property) => property.identifier);
    // All the old keys that are not in the new keys need to be removed
    for (const oldKey of oldKeys) {
      if (!newKeys.includes(oldKey)) {
        this.annotationUIProperties.delete(oldKey);
      }
    }
    for (const propertySchema of this.schema) {
      const annotationUIProperty = this.annotationUIProperties.get(
        propertySchema.identifier,
      );
      // If the property is undefined, it means it is a new property
      if (annotationUIProperty === undefined) {
        // Create a new AnnotationUIProperty and add it to the map
        this.annotationUIProperties.set(
          propertySchema.identifier,
          new AnnotationUIProperty(propertySchema, this),
        );
      } else {
        // For existing properties, we need to check if the schema has changed
        const oldPropertySchema = annotationUIProperty.spec;
        const comparedProperties = compareAnnotationSpecProperties(
          oldPropertySchema,
          propertySchema,
        );
        // If the property is the same, we can skip updating it
        if (!comparedProperties.same) {
          // If only the default value changed, we can update that
          const isNumeric = isAnnotationTypeNumeric(propertySchema.type);
          if (isNumeric && comparedProperties.defaultValueChanged) {
            annotationUIProperty.setNumericDefaultValueOnly(
              propertySchema.default,
            );
          } else {
            // If the property has changed otherwise, we need to create a new one
            this.annotationUIProperties.set(
              propertySchema.identifier,
              new AnnotationUIProperty(propertySchema, this),
            );
          }
        }
      }
    }
  }

  private populateSchemaTable() {
    this.updateSchemaRepresentation();
    removeChildren(this.schemaTableBody);
    this.schema.forEach((property) => {
      const annotationUIProperty = this.annotationUIProperties.get(
        property.identifier,
      );
      if (annotationUIProperty === undefined) {
        console.warn(
          `Annotation UI Property for ${property.identifier} not found.`,
        );
        return;
      }
      this.schemaTableBody.appendChild(annotationUIProperty.element);
    });
  }

  private createSchemaTableHeader() {
    let tableHeaders = ["Name", "Type", "Default value"];

    const addButtonField = document.createElement("div");
    addButtonField.className =
      "neuroglancer-annotation-schema-add-button-field";

    const headerRow = document.createElement("div");
    headerRow.classList.add("neuroglancer-annotation-schema-header-row");
    tableHeaders.forEach((text) => {
      headerRow.appendChild(this.createTableCell(text));
    });
    // Append a blank cell for the delete icon
    if (!this.readonly.value) {
      const deleteHeader = this.createTableCell(
        "",
        "neuroglancer-annotation-schema-delete-header",
      );
      headerRow.appendChild(deleteHeader);
    }
    this.schemaTable.appendChild(headerRow);
  }

  private createAnnotationSchemaDropdown() {
    let dropdown: HTMLDivElement | null = null;

    const handleAddPropertyClick = () => {
      if (dropdown) {
        dropdown.remove();
        dropdown = null;
        return;
      }

      dropdown = document.createElement("div");
      dropdown.className = "neuroglancer-annotation-schema-dropdown";

      // The numeric types are all given the option to be "raw" or "enum"
      // So we handle the numeric types again at the end

      const populateDropDown = (types: AnnotationUIType[], isEnum = false) => {
        let previousHeaderText: string | null = null;
        types.forEach((type) => {
          const newHeaderText = isEnum ? "Enum" : this.getCategoryForType(type);
          if (previousHeaderText !== newHeaderText) {
            const header = document.createElement("div");
            header.className = "neuroglancer-annotation-schema-dropdown-header";
            header.textContent = newHeaderText;
            dropdown?.appendChild(header);
            previousHeaderText = newHeaderText;
          }

          const option = document.createElement("div");
          option.className = "neuroglancer-annotation-schema-dropdown-option";
          const iconWrapper = document.createElement("span");
          iconWrapper.classList.add(
            "neuroglancer-annotation-schema-cell-icon-wrapper",
          );
          iconWrapper.innerHTML = this.getIconForType(type);

          const text = document.createElement("span");
          const displayName = this.getDisplayNameForType(type);
          text.textContent = displayName;

          option.appendChild(iconWrapper);
          option.appendChild(text);

          option.addEventListener(
            "mouseover",
            () => (option.style.backgroundColor = "#333"),
          );
          option.addEventListener(
            "mouseout",
            () => (option.style.backgroundColor = ""),
          );
          option.addEventListener("click", () => {
            const name = this.ensureUniquePropertyIdentifier(
              type.replace(/\s+/g, "_"),
            );
            const newProperty = {
              type: this.mapUITypeToAnnotationType(type),
              identifier: name,
              default: this.defaultValuePerType(type),
              description: "",
              ...this.setupInitialEnumsIfNeeded(type, isEnum),
            } as AnnotationPropertySpec;
            this.addProperty(newProperty);
            dropdown?.remove();
            dropdown = null;
          });

          dropdown?.appendChild(option);
        });
      };
      populateDropDown(ANNOTATION_UI_TYPES, false);
      // Now do it again for the numeric types
      populateDropDown(
        ANNOTATION_TYPES.filter((t) => isAnnotationTypeNumeric(t)),
        true,
      );

      document.body.appendChild(dropdown);
      const rect = addButton.getBoundingClientRect();
      dropdown.style.left = `${rect.left}px`;
      dropdown.style.top = `${rect.bottom + window.scrollY}px`;

      const handleOutsideClick = (e: MouseEvent) => {
        if (dropdown && !dropdown.contains(e.target as Node)) {
          dropdown.remove();
          dropdown = null;
          document.removeEventListener("mousedown", handleOutsideClick);
        }
      };
      document.addEventListener("mousedown", handleOutsideClick);
    };

    // TODO: not efficient, but for now we do this every update
    this.schemaTableAddButtonField = document.createElement("div");
    this.schemaTableAddButtonField.className =
      "neuroglancer-annotation-schema-add-button-field";
    const addButton = makeAddButton({
      title: "Add property",
      onClick: handleAddPropertyClick,
    });

    this.schemaTableAddButtonField.appendChild(addButton);
    this.schemaTable.appendChild(this.schemaTableAddButtonField);
  }

  public createTableCell = (
    content: string | HTMLElement,
    className?: string,
  ): HTMLDivElement => {
    const cell = document.createElement("div");
    cell.classList.add("neuroglancer-annotation-schema-cell");
    if (className) {
      cell.classList.add(className);
    }

    if (typeof content === "string") {
      cell.textContent = content;
    } else {
      cell.appendChild(content);
    }

    return cell;
  };

  public getDisplayNameForType(
    type: AnnotationUIType,
    enumLabels?: string[],
  ): string {
    if (isBooleanType(enumLabels) || type === "bool") return "Boolean";
    if (type === "rgb") return "RGB";
    if (type === "rgba") return "RGBa";
    if (isAnnotationTypeNumeric(type)) {
      const EnumText = isEnumType(enumLabels) ? " Enum" : "";
      return `${type} ${EnumText}`;
    }
    return type;
  }

  ensureUniquePropertyIdentifier(suggestedIdentifier: string) {
    const allProperties = this.schema;
    const initalName = suggestedIdentifier;
    let uniqueIdenifier = suggestedIdentifier;
    let suffix = 0;
    while (
      allProperties.some((property) => property.identifier === uniqueIdenifier)
    ) {
      uniqueIdenifier = `${initalName}_${++suffix}`;
    }
    return uniqueIdenifier;
  }

  private getCategoryForType(type: AnnotationUIType, isEnum = false): string {
    if (type === "bool") return "General";
    if (type === "rgb" || type === "rgba") return "Color";
    if (isEnum && isAnnotationTypeNumeric(type)) return "Enum";
    if (!isEnum && isAnnotationTypeNumeric(type)) return "Numeric";
    return "Other";
  }

  getIconForType(type: AnnotationUIType, enumValues?: string[]): string {
    const isBoolean = isBooleanType(enumValues);
    if (isBoolean || type === "bool") return svg_check;
    if (isEnumType(enumValues)) return svg_format_size;
    if (isAnnotationTypeNumeric(type)) return svg_numbers;
    return svg_palette;
  }

  includesEnumProperties(): Boolean {
    const schema = this.schema;
    return schema.some(
      (property) =>
        "enumValues" in property &&
        property.enumValues &&
        property.enumValues.length > 0,
    );
  }

  mapUITypeToAnnotationType(uiType: AnnotationUIType): AnnotationType {
    if (uiType === "bool") return "uint8";
    return uiType;
  }

  private defaultValuePerType(uiType: AnnotationUIType): number {
    if (uiType === "bool") {
      return 1;
    }
    if (uiType === "rgb") {
      return packColor(vec3.fromValues(1, 1, 1));
    }
    if (uiType === "rgba") {
      return packColor(vec4.fromValues(1, 1, 1, 1));
    }
    return 0;
  }

  private setupInitialEnumsIfNeeded(type: AnnotationUIType, isEnum = false) {
    if (type === "bool") {
      return {
        enumValues: [0, 1],
        enumLabels: ["False", "True"],
      };
    }
    if (isEnum && isAnnotationTypeNumeric(type)) {
      return {
        enumValues: [0],
        enumLabels: ["Default"],
      };
    }
    return {};
  }

  private get mutableSources() {
    const states = this.layer.annotationStates.states.filter(
      (state) => !state.source.readonly && "addProperty" in state.source,
    );
    return states.map((state) => state.source as LocalAnnotationSource);
  }

  addProperty(property: AnnotationPropertySpec) {
    this.mutableSources.forEach((s) => {
      s.addProperty(property);
    });
    this.annotationStates.changed.dispatch();
  }

  removeProperty(propertyIdentifer: string) {
    this.mutableSources.forEach((s) => {
      s.removeProperty(propertyIdentifer);
    });
    this.annotationStates.changed.dispatch();
  }

  updateProperty<T extends AnnotationPropertySpec>(
    oldProperty: T,
    newProperty: T,
  ) {
    this.mutableSources.forEach((s) => {
      s.updateProperty(oldProperty, newProperty);
    });
    this.annotationStates.changed.dispatch();
  }

  private get jsonSchema() {
    const states = this.annotationStates.states;
    const jsonSchema = states.map((state) =>
      annotationPropertySpecsToJson(state.source.properties.value),
    );
    const finalSchema = [];
    // Remove all undefined values
    for (const state of jsonSchema) {
      if (state !== undefined) {
        const entries = state.map((property) => {
          const entries = Object.entries(property).filter(
            ([, value]) => value !== undefined,
          );
          return Object.fromEntries(entries);
        });
        finalSchema.push(...entries);
      }
    }
    return stableStringify(finalSchema);
  }

  private downloadSchema() {
    const blob = new Blob([this.jsonSchema], {
      type: "application/json",
    });
    const layerName = this.layer.managedLayer.name;
    saveBlobToFile(blob, `${layerName}_annotation_schema.json`);
  }

  private copySchemaToClipboard() {
    navigator.clipboard.writeText(this.jsonSchema).then(() => {
      StatusMessage.showTemporaryMessage(
        "Annotation schema copied to clipboard",
        /*duration=*/ 2000,
      );
    });
  }

  private pasteSchemaFromClipboard() {
    navigator.clipboard.readText().then((text) => {
      try {
        const parsedSchema = parseAnnotationPropertySpecs(JSON.parse(text));
        const states = this.annotationStates.states;
        states.forEach((state) => {
          const source = state.source as LocalAnnotationSource;
          for (const property of parsedSchema) {
            console.log("Adding property", property);
            source.addProperty(property);
          }
        });
        this.annotationStates.changed.dispatch();
        StatusMessage.showTemporaryMessage(
          "Annotation schema pasted from clipboard",
          /*duration=*/ 2000,
        );
      } catch (error) {
        console.error("Failed to parse schema from clipboard", error);
        StatusMessage.showTemporaryMessage(
          "Failed to parse schema from clipboard",
          /*duration=*/ 2000,
        );
      }
    });
  }

  // TODO should probably cache this
  private extractSchema() {
    const schema: Readonly<AnnotationPropertySpec>[] = [];
    let readonly = true;
    for (const state of this.annotationStates.states) {
      if (!state.source.readonly) readonly = false;
      if (state.chunkTransform.value.error !== undefined) continue;
      const properties = state.source.properties.value;
      for (const property of properties) {
        schema.push(property);
      }
    }
    return { schema, readonly };
  }

  public getPropertyByIdentifier(
    identifier: string,
  ): AnnotationPropertySpec | undefined {
    for (const state of this.annotationStates.states) {
      const property = state.source.properties.value.find(
        (p) => p.identifier === identifier,
      );
      if (property) return property;
    }
    return undefined;
  }

  private updateView() {
    // TODO somehow need to know if big update - key based?
    const { schema, readonly } = this.extractSchema();
    this.schema = schema;
    this.readonly.value = readonly;
    this.populateSchemaTable();
  }
}

export class AnnotationSchemaTab extends Tab {
  private schemaView: AnnotationSchemaView;
  constructor(public layer: Borrowed<UserLayerWithAnnotations>) {
    super();
    this.schemaView = this.registerDisposer(
      new AnnotationSchemaView(layer, layer.annotationDisplayState),
    );

    const { element } = this;
    element.classList.add("neuroglancer-annotations-schema-tab");
    element.appendChild(this.schemaView.element);
  }
}
