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
 */

import svg_numbers from "ikonate/icons/hash.svg?raw";
import svg_palette from "ikonate/icons/drop.svg?raw";
import svg_check from "ikonate/icons/ok-circle.svg?raw";
import svg_clipboard from "ikonate/icons/clipboard.svg?raw";
import svg_bin from "ikonate/icons/bin.svg?raw";
import svg_download from "ikonate/icons/download.svg?raw";
import svg_format_size from "ikonate/icons/text.svg?raw";
import "#src/ui/annotations.css";
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
  isAnnotationTypeNumeric,
  parseAnnotationPropertySpecs,
  propertyTypeDataType,
} from "#src/annotation/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
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

type AnnotationType = AnnotationPropertySpec["type"];
type AnnotationUIType = AnnotationType | "bool";
const ANNOTATION_TYPES: AnnotationType[] = [
  "float32",
  "rgb",
  "rgba",
  "int8",
  "int16",
  "int32",
  "uint8",
  "uint16",
  "uint32",
];
const ANNOTATION_UI_TYPES: AnnotationUIType[] = ["bool", ...ANNOTATION_TYPES];

function ensureIsAnnotationType(type: string): asserts type is AnnotationType {
  if (!ANNOTATION_TYPES.includes(type as AnnotationType)) {
    throw new Error(`Invalid annotation type: ${type}`);
  }
}

interface InputConfig {
  type: string;
  value?: string;
  name: string;
  id: string;
  className?: string;
}

interface NumberConfig {
  min?: number;
  max?: number;
  step?: number;
}

export class AnnotationSchemaView extends Tab {
  get annotationStates() {
    return this.layer.annotationStates;
  }

  private schemaTable = document.createElement("div");
  private schemaTableAddButtonField = document.createElement("div");
  private schemaViewTextElement = document.createElement("p");
  private schemaPasteButton: HTMLElement;
  private tableToPropertyIndex: Array<number> = [];
  private schema: Readonly<AnnotationPropertySpec[]> = [];
  private isMutable: WatchableValueInterface<boolean>;

  constructor(
    public layer: Borrowed<UserLayerWithAnnotations>,
    public displayState: AnnotationDisplayState,
  ) {
    super();
    this.isMutable = new WatchableValue(
      this.annotationStates.states.some((state) => !state.source.readonly),
    );
    this.element.classList.add("neuroglancer-annotation-schema-view");
    this.schemaTable.className = "neuroglancer-annotation-schema-grid";
    this.makeUI();

    this.element.appendChild(this.schemaTable);

    this.updateOnMutableChange();
    this.updateView();

    this.registerDisposer(
      this.annotationStates.changed.add(() => {
        this.updateView();
      }),
    );
    this.registerDisposer(
      this.isMutable.changed.add(() => {
        this.updateOnMutableChange();
      }),
    );
  }

  private updateOnMutableChange = () => {
    this.updateAnnotationText();
    this.updatePasteVisibility();
  };

  // TODO maybe let's move this into a tooltip, I don't think it looks great just at the top?
  private updateAnnotationText() {
    const setOrViewText = this.isMutable.value ? "Set" : "View read-only";
    this.schemaViewTextElement.textContent = `${setOrViewText} annotation property (metadata) schema for this layer which applies to all annotations in this layer.`;
  }

  private updatePasteVisibility() {
    this.schemaPasteButton.style.display = this.isMutable.value ? "" : "none";
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

    this.createSchemaTableHeader();
    this.populateSchemaTable();
  }

  private createTableCell = (
    content: string | HTMLElement,
    className: string = "_",
  ): HTMLDivElement => {
    const cell = document.createElement("div");
    cell.classList.add("neuroglancer-annotation-schema-cell", className);

    if (typeof content === "string") {
      cell.textContent = content;
    } else {
      cell.appendChild(content);
    }

    return cell;
  };

  private createSchemaTableHeader() {
    let tableHeaders = ["Name", "Type", "Default value", ""];
    if (this.isMutable.value) {
      tableHeaders = [...tableHeaders];
    }

    // Initialize Table
    const addButtonField = document.createElement("div");
    addButtonField.className =
      "neuroglancer-annotation-schema-add-button-field";

    // Create Header Row
    const headerRow = document.createElement("div");
    headerRow.classList.add("neuroglancer-annotation-schema-header-row");
    tableHeaders.forEach((text) => {
      headerRow.appendChild(this.createTableCell(text));
    });
    this.schemaTable.appendChild(headerRow);
  }

  private createInputElement(
    config: InputConfig,
    numberConfig?: NumberConfig,
  ): HTMLInputElement {
    const input = document.createElement("input");
    // TODO (Aigul) - not sure if we need any specific styling for readonly
    const readonly = !this.isMutable.value;
    input.dataset.readonly = String(readonly);
    input.disabled = readonly;
    if (this.isMutable.value && config.type === "number") {
      if (numberConfig?.min !== undefined) input.min = String(numberConfig.min);
      if (numberConfig?.max !== undefined) input.max = String(numberConfig.max);
      if (numberConfig?.step !== undefined)
        input.step = String(numberConfig.step);
      // TODO (SKM) might want to allow adjust via mouse wheel
      // this.registerEventListener(input, "wheel", (event: WheelEvent) => {
    }
    input.type = config.type;
    input.value = config.value || "";
    input.name = `${this.layer.managedLayer.name}-schema-${config.name}`;
    input.id = `${this.layer.managedLayer.name}-schema-${config.id}`;
    if (config.className) input.classList.add(config.className);
    return input;
  }

  private createNameCell(identifier: string, index: number): HTMLDivElement {
    const nameInput = this.createInputElement({
      type: "text",
      value: identifier,
      name: `name-${index}`,
      id: `name-${index}`,
      className: "schema-name-input",
    });
    const cell = this.createTableCell(nameInput);
    if (!this.isMutable.value) return cell;
    // TODO (Sean) maybe need to call removeEventListener
    // when the table is updated
    nameInput.addEventListener("change", () => {
      const rawValue = nameInput.value;
      // TODO (Sean) there needs to be a signal for the selected state
      // to now show the new name
      const oldProperty = this.getPropertyByName(identifier);
      let sanitizedValue = rawValue.replace(/\s+/g, "_");
      if (oldProperty === undefined) {
        console.warn(`Property with name ${identifier} not found.`);
        return;
      }
      if (sanitizedValue === "") {
        sanitizedValue = identifier;
      } else {
        sanitizedValue = this.ensureUniqueName(sanitizedValue);
      }
      this.updateProperty(oldProperty, {
        ...oldProperty,
        identifier: sanitizedValue,
      });
    });
    return cell;
  }

  private getDisplayNameForType(
    type: AnnotationUIType,
    enumLabels?: string[],
  ): string {
    if (this.isBooleanType(enumLabels) || type === "bool") return "Boolean";
    if (type === "rgb") return "RGB";
    if (type === "rgba") return "RGBA";
    if (isAnnotationTypeNumeric(type)) {
      const EnumText = this.isEnumType(enumLabels) ? " Enum" : "";
      return `${type} ${EnumText}`;
    }
    return type;
  }

  private ensureUniqueName(suggestedName: string) {
    const allProperties = this.schema;
    const initalName = suggestedName;
    let suffix = 0;
    while (
      allProperties.some((property) => property.identifier === suggestedName)
    ) {
      suggestedName = `${initalName}_${++suffix}`;
    }
    return suggestedName;
  }

  private getCategoryForType(type: AnnotationUIType, isEnum = false): string {
    if (type === "bool") return "General";
    if (type === "rgb" || type === "rgba") return "Color";
    if (isEnum && isAnnotationTypeNumeric(type)) return "Enum";
    if (!isEnum && isAnnotationTypeNumeric(type)) return "Numeric";
    return "Other";
  }

  private getIconForType(
    type: AnnotationUIType,
    enumValues?: string[],
  ): string {
    const isBoolean = this.isBooleanType(enumValues);
    if (isBoolean || type === "bool") return svg_check;
    if (this.isEnumType(enumValues)) return svg_format_size;
    if (isAnnotationTypeNumeric(type)) return svg_numbers;
    return svg_palette;
  }

  private isBooleanType(enumValues?: string[]): boolean {
    return (
      (enumValues?.includes("False") &&
        enumValues?.includes("True") &&
        enumValues.length === 2) ||
      false
    );
  }

  private isEnumType(enumValues?: string[]): boolean {
    return (enumValues && enumValues.length > 0) || false;
  }

  private createTypeTextElement(
    type: AnnotationType,
    enumLabels?: string[],
  ): HTMLSpanElement {
    const typeText = document.createElement("span");

    if (this.isBooleanType(enumLabels)) {
      typeText.textContent = "Boolean";
      return typeText;
    }
    const displayName = this.getDisplayNameForType(type);
    if (this.isEnumType(enumLabels)) {
      typeText.textContent = `${displayName} Enum`;
    } else {
      typeText.textContent = displayName;
    }

    return typeText;
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

  public createTypeCell(
    type: AnnotationType,
    enumLabels?: string[],
  ): HTMLDivElement {
    const typeText = this.createTypeTextElement(type, enumLabels);
    const iconWrapper = this.createIconWrapper(type, enumLabels);

    const typeCell = this.createTableCell(iconWrapper, "type");
    typeCell.appendChild(typeText);

    const isBoolean = this.isBooleanType(enumLabels);

    if (!isBoolean) {
      typeCell.style.cursor = "pointer";
      typeCell.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showTypeDropdown(typeCell, type, enumLabels);
      });
    }

    return typeCell;
  }

  private showTypeDropdown(
    anchorElement: HTMLElement,
    currentType: AnnotationType,
    enumLabels?: string[],
  ) {
    const availableOptions: AnnotationType[] = [];
    for (const type of ANNOTATION_TYPES) {
      if (canConvertTypes(currentType, type)) {
        availableOptions.push(type);
      }
    }

    const dropdown = this.createDropdownElement(
      availableOptions,
      currentType,
      enumLabels,
      anchorElement,
    );
    if (dropdown.children.length === 0) return;

    document.body.appendChild(dropdown);
    this.positionDropdown(dropdown, anchorElement);
    this.addDropdownDismissHandler(dropdown);
  }

  private createDropdownElement(
    availableOptions: AnnotationType[],
    currentType: string,
    enumLabels: string[] | undefined,
    anchorElement: HTMLElement,
  ): HTMLDivElement {
    const dropdown = document.createElement("div");
    dropdown.className = "neuroglancer-annotation-schema-dropdown";

    availableOptions.forEach((item) => {
      const option = document.createElement("div");
      option.className = "neuroglancer-annotation-schema-dropdown-option";

      const iconWrapper = this.createIconWrapper(item);
      const label = document.createElement("span");
      label.textContent = this.getDisplayNameForType(item);

      option.appendChild(iconWrapper);
      option.appendChild(label);

      option.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item !== currentType) {
          this.handleTypeChange(anchorElement, item, enumLabels);
        }
        dropdown.remove();
      });

      dropdown.appendChild(option);
    });

    return dropdown;
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

  private addDropdownDismissHandler(dropdown: HTMLDivElement) {
    const clickOutsideHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove();
        document.removeEventListener("click", clickOutsideHandler);
      }
    };
    document.addEventListener("click", clickOutsideHandler);
  }

  private handleTypeChange(
    cell: HTMLElement,
    newType: string,
    enumLabels?: string[],
  ) {
    const iconWrapper = cell.querySelector(
      ".neuroglancer-annotation-schema-cell-icon-wrapper",
    );
    const typeText = cell.querySelector(
      "span:not(.neuroglancer-annotation-schema-cell-icon-wrapper)",
    );

    if (!iconWrapper || !typeText) return;

    ensureIsAnnotationType(newType);
    const displayName = this.getDisplayNameForType(newType, enumLabels);
    iconWrapper.innerHTML = this.getIconForType(newType, enumLabels);

    if (this.isBooleanType(enumLabels)) {
      typeText.textContent = "Boolean";
    } else if (this.isEnumType(enumLabels)) {
      typeText.textContent = `${displayName} Enum`;
    } else {
      typeText.textContent = displayName;
    }
  }

  private createDefaultValueCell(
    identifier: string,
    type: AnnotationType | "bool",
    index: number,
  ): HTMLDivElement {
    console.log(type);
    const container = document.createElement("div");
    container.className =
      "neuroglancer-annotation-schema-default-value-cell-container";

    // SKM -- already did this, keeping for reference in case we need to revisit
    // I would instead get this switch statement to just create the element
    // and give us that element
    // we will have to add an event listener to that element
    // which is tricky to do in the current implementation
    // This needs a bit of thought to do it best.
    // I think our best strategy is not to switch directly on the type
    // but to switch on the type of the input we want to create
    // So this would involve a mapping of types to input types

    // Something like this:
    // const inputType = typeToInputTypeMap[type] || "text";
    // and then we would create the input element based on that
    // at the end, we'd have a list of the input elements after coming out of the switch
    // then we could call something like
    // if (this.isMutable.value) {
    //   inputElements.forEach(element => addEventListener("change", (event) => {
    //    this.updateProperty(property, { ...property, defaultValue: element.value });
    // except for RBGa because it has two inputs
    // Then for enums this also gets handled a bit differently
    // because we are not passing a defaultValue, but rather a list of enum options

    let inputs: HTMLInputElement[] = [];
    let changeFunction: (event: Event) => void;
    const oldProperty = this.getPropertyByName(identifier);
    if (oldProperty === undefined) {
      console.warn(`Property with name ${identifier} not found.`);
      return this.createTableCell(container, "default-value");
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
            name: `alpha-${index}`,
            id: `alpha-${index}`,
            value: String(alpha),
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
      const oldProperty = this.getPropertyByName(
        identifier,
      ) as AnnotationNumericPropertySpec;
      const { enumValues, enumLabels } = oldProperty;
      if (enumValues === undefined || enumLabels === undefined) {
        const dataType = propertyTypeDataType[type as AnnotationType];
        const step = dataType === DataType.FLOAT32 ? 0.01 : 1;
        const bounds = defaultDataTypeRange[dataType!];

        const numberInput = this.createInputElement(
          {
            type: "number",
            name: `number-${index}`,
            id: `number-${index}`,
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
          enumRow.className = "enum-entry";

          // TODO ideally this should stop you from adding the same enum value
          // or the same label
          const nameInput = this.createInputElement({
            type: "text",
            name: `enum-name-${enumIndex}`,
            id: `enum-name-${enumIndex}`,
            className: "neuroglancer-annotation-schema-default-input",
            value: label,
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
            name: `enum-value-${enumIndex}`,
            id: `enum-value-${enumIndex}`,
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

          enumRow.appendChild(nameInput);
          enumRow.appendChild(valueInput);
          enumRow.appendChild(deleteIcon);
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
      // TODO We should refactor isMutable to instead be the name "readonly"
      if (this.isMutable.value) {
        input.addEventListener("change", changeFunction);
      }
    });
    return this.createTableCell(container);
  }

  private mapUITypeToAnnotationType(uiType: AnnotationUIType): AnnotationType {
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
        types.forEach((type) => {
          let previousHeader = null;
          const newHeader = this.getCategoryForType(type);
          if (previousHeader !== newHeader) {
            const headerEl = document.createElement("div");
            headerEl.className =
              "neuroglancer-annotation-schema-dropdown-header";
            headerEl.textContent = newHeader;
            dropdown?.appendChild(headerEl);
            previousHeader = newHeader;
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
            const name = this.ensureUniqueName(
              displayName.replace(/\s+/g, "_"),
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
      populateDropDown(ANNOTATION_UI_TYPES, true);
      // Now do it again for the numeric types
      populateDropDown(
        ANNOTATION_TYPES.filter((t) => isAnnotationTypeNumeric(t)),
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

  private populateSchemaTable() {
    // TODO (sean or aigul) - remaking this all the time is not very efficient
    // we could compare the current schema with the new one
    // and only update the rows that have changed
    const { schema, isMutable } = this;
    // Remove everything from the table except the header
    removeChildren(this.schemaTable);
    this.createSchemaTableHeader();

    schema.forEach((rowData, index) => {
      const row = document.createElement("div");
      row.classList.add("neuroglancer-annotation-schema-row");

      const enumLabels =
        "enumLabels" in rowData ? rowData.enumLabels : undefined;
      row.appendChild(this.createNameCell(rowData.identifier, index));
      row.appendChild(this.createTypeCell(rowData.type, enumLabels));
      row.appendChild(
        this.createDefaultValueCell(rowData.identifier, rowData.type, index),
      );

      // Delete Cell
      if (isMutable.value) {
        const deleteIcon = document.createElement("span");
        deleteIcon.innerHTML = svg_bin;
        deleteIcon.title = "Delete annotation property";
        deleteIcon.style.cursor = "pointer";
        deleteIcon.addEventListener("click", () => {
          const propertyIdentifer = rowData.identifier;
          this.removeProperty(propertyIdentifer);
        });

        const deleteCell = this.createTableCell(
          deleteIcon,
          "neuroglancer-annotation-schema-delete-cell",
        );
        row.appendChild(deleteCell);
      }

      this.schemaTable.appendChild(row);
      this.tableToPropertyIndex.push(index);
    });

    if (!isMutable.value) return;

    this.createAnnotationSchemaDropdown();
  }

  private get mutableSources() {
    const states = this.layer.annotationStates.states.filter(
      (state) => !state.source.readonly && "addProperty" in state.source,
    );
    return states.map((state) => state.source as LocalAnnotationSource);
  }

  private addProperty(property: AnnotationPropertySpec) {
    this.mutableSources.forEach((s) => {
      s.addProperty(property);
    });
    this.annotationStates.changed.dispatch();
  }

  private removeProperty(propertyIdentifer: string) {
    this.mutableSources.forEach((s) => {
      s.removeProperty(propertyIdentifer);
    });
    this.annotationStates.changed.dispatch();
  }

  private updateProperty<T extends AnnotationPropertySpec>(
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
    saveBlobToFile(blob, "schema.json");
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
    let isMutable = false;
    for (const state of this.annotationStates.states) {
      if (!state.source.readonly) isMutable = true;
      if (state.chunkTransform.value.error !== undefined) continue;
      const properties = state.source.properties.value;
      for (const property of properties) {
        schema.push(property);
      }
    }
    return { schema, isMutable };
  }

  private getPropertyByName(name: string): AnnotationPropertySpec | undefined {
    for (const state of this.annotationStates.states) {
      const property = state.source.properties.value.find(
        (p) => p.identifier === name,
      );
      if (property) return property;
    }
    return undefined;
  }

  private updateView() {
    const { schema, isMutable } = this.extractSchema();
    this.schema = schema;
    this.isMutable.value = isMutable;
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
