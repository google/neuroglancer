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

import svg_bin from "ikonate/icons/bin.svg?raw";
import svg_clipboard from "ikonate/icons/clipboard.svg?raw";
import svg_download from "ikonate/icons/download.svg?raw";
import svg_palette from "ikonate/icons/drop.svg?raw";
import svg_edit from "ikonate/icons/edit.svg?raw";
import svg_numbers from "ikonate/icons/hash.svg?raw";
import svg_check from "ikonate/icons/ok-circle.svg?raw";
import svg_format_size from "ikonate/icons/text.svg?raw";
import "#src/ui/annotation_schema_tab.css";
import type { AnnotationDisplayState } from "#src/annotation/annotation_layer_state.js";
import type {
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
import { FramedDialog } from "#src/overlay.js";
import { StatusMessage } from "#src/status.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type {
  AnnotationColorKey,
  AnnotationPropertyType,
} from "#src/ui/annotation_properties.js";
import {
  ANNOTATION_TYPES,
  makeBoolCheckbox,
  makeDescriptionIcon,
  makeEditableColorProperty,
  makeReadonlyColorProperty,
} from "#src/ui/annotation_properties.js";
import type { UserLayerWithAnnotations } from "#src/ui/annotations.js";
import { isBooleanType, isEnumType } from "#src/ui/annotation_properties.js";
import {
  createBoundedNumberInputElement,
  NumberDisplayConfig,
} from "#src/ui/bounded_number_input.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { arraysEqual } from "#src/util/array.js";
import { setClipboard } from "#src/util/clipboard.js";
import {
  packColor,
  serializeColor,
  unpackRGB,
  unpackRGBA,
} from "#src/util/color.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted, type Borrowed } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import { saveBlobToFile } from "#src/util/file_download.js";
import { vec3, vec4 } from "#src/util/geom.js";
import { stableStringify } from "#src/util/json.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";
import { numberToStringFixed } from "#src/util/number_to_string.js";
import { NullarySignal } from "#src/util/signal.js";
import { makeAddButton } from "#src/widget/add_button.js";
import { makeCopyButton } from "#src/widget/copy_button.js";
import { makeIcon } from "#src/widget/icon.js";
import { Tab } from "#src/widget/tab_view.js";

const ANNOTATION_UI_TYPES: AnnotationUIType[] = ["bool", ...ANNOTATION_TYPES];
type AnnotationUIType = AnnotationPropertyType | "bool";

interface InputConfig extends NumberDisplayConfig {
  type: "number" | "text" | "checkbox";
  useTextarea?: boolean;
}

class AnnotationDescriptionEditDialog extends FramedDialog {
  constructor(parent: AnnotationUIProperty) {
    super(
      "Edit Description",
      "Discard changes",
      "neuroglancer-annotation-description-editor",
    );

    const textInputElement = document.createElement("textarea");
    textInputElement.classList.add(
      "neuroglancer-annotation-description-editor-text-input",
    );
    textInputElement.rows = 5;
    textInputElement.placeholder = "Add a description for this property...";
    textInputElement.textContent = parent.spec.description || "";
    this.body.appendChild(textInputElement);

    const saveButton = document.createElement("button");
    saveButton.classList.add(
      "neuroglancer-annotation-description-editor-save-button",
    );
    saveButton.textContent = "Save & close";
    saveButton.addEventListener("click", () => {
      const newDescription = textInputElement.value.trim();
      if (newDescription !== parent.spec.description && newDescription !== "") {
        parent.updateProperty(parent.spec, { description: newDescription });
      }
      this.close();
    });
    this.footer.appendChild(saveButton);
  }
}

class AnnotationUIProperty extends RefCounted {
  public element: HTMLDivElement = document.createElement("div");
  private defaultValueCell: HTMLDivElement | null = null;
  private defaultValueElements: (HTMLInputElement | HTMLTextAreaElement)[] = [];
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
  public updateTableRowSize(hasEnums: boolean) {
    if (this.defaultValueCell === null) return;
    this.defaultValueCell.dataset.enums = String(hasEnums);
  }
  private removeProperty(indentifier: string) {
    this.parentView.removeProperty(indentifier);
  }
  private renameProperty(oldIdentifier: string, newIdentifier: string) {
    const oldProperty = this.getPropertyByIdentifier(oldIdentifier);
    if (oldProperty === undefined) {
      console.warn(`Property with name ${oldIdentifier} not found.`);
      return;
    }
    this.updateProperty(oldProperty, { identifier: newIdentifier });
  }
  private getPropertyByIdentifier(
    identifier: string,
  ): AnnotationPropertySpec | undefined {
    return this.parentView.getPropertyByIdentifier(identifier);
  }
  public updateProperty(
    oldProperty: AnnotationPropertySpec,
    newProperty: Partial<AnnotationPropertySpec>,
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
  public updateDefaultValue(defaultValue: number) {
    // For numeric types, we can set the default value directly
    const type = this.spec.type;
    if (isAnnotationTypeNumeric(type)) {
      this.defaultValueElements[0].value = numberToStringFixed(defaultValue, 4);
    }
    // For color types, we need to unpack the color and set the RGB values
    else if (type.startsWith("rgb")) {
      const rgbColor = unpackRGB(defaultValue);
      this.defaultValueElements[0].value = serializeColor(rgbColor);
      if (type === "rgba") {
        const alpha = unpackRGBA(defaultValue)[3];
        this.defaultValueElements[1].value = numberToStringFixed(alpha, 2);
      }
    }
    this.spec.default = defaultValue;
  }
  public updateEnumValues(enumValues: number[]) {
    const inputs = this.defaultValueElements;
    for (let i = 0; i < enumValues.length; i++) {
      const input = inputs[i];
      input.value = numberToStringFixed(enumValues[i], 4);
    }
  }
  makeUI() {
    const { element, spec, readonly } = this;
    const enumLabels = "enumLabels" in spec ? spec.enumLabels : undefined;
    element.appendChild(this.createNameCell(spec.identifier, spec.description));
    const type = isBooleanType(enumLabels) ? "bool" : spec.type;
    element.appendChild(this.createTypeCell(spec.identifier, type, enumLabels));
    element.appendChild(this.createDefaultValueCell(spec.identifier, type));

    if (!readonly) {
      // Add a little icon to the right of the input that lets you change the description
      const descriptionEditIcon = makeIcon({
        svg: svg_edit,
        title: "Change description",
      });
      this.registerEventListener(descriptionEditIcon, "click", () => {
        new AnnotationDescriptionEditDialog(this);
      });
      const descriptionCell = this.createTableCell(
        descriptionEditIcon,
        "neuroglancer-annotation-schema-description-cell",
      );
      element.appendChild(descriptionCell);
      const deleteIcon = document.createElement("span");
      deleteIcon.innerHTML = svg_bin;
      deleteIcon.title = "Delete annotation property";
      deleteIcon.style.cursor = "pointer";
      this.registerEventListener(deleteIcon, "click", () => {
        const propertyIdentifier = spec.identifier;
        this.removeProperty(propertyIdentifier);
      });

      const deleteCell = this.createTableCell(
        deleteIcon,
        "neuroglancer-annotation-schema-delete-cell",
      );
      element.appendChild(deleteCell);
    }
  }

  private createNameCell(
    identifier: string,
    description?: string,
  ): HTMLDivElement {
    const nameInput = this.createInputElement(identifier, {
      type: "text",
      className: "neuroglancer-annotation-schema-name-input",
    });
    nameInput.name = `neuroglancer-annotation-schema-name-input-${identifier}`;
    nameInput.dataset.readonly = String(this.readonly);

    const cell = this.createTableCell(document.createElement("div"), "");

    if (description) {
      const iconWrapper = makeDescriptionIcon(description);
      cell.appendChild(iconWrapper);
    }
    cell.appendChild(nameInput);

    if (this.readonly) return cell;

    this.registerEventListener(nameInput, "change", (event: Event) => {
      if (!event.target) return;
      const rawValue = (event.target as HTMLInputElement).value;
      // Replace dash and spaces with underscores
      let sanitizedValue = rawValue.replace(/-/g, "_");
      sanitizedValue = rawValue.replace(/\s+/g, "_");
      sanitizedValue = sanitizedValue.toLowerCase();
      // Remove any non-alphanumeric characters except underscores
      sanitizedValue = sanitizedValue.replace(/[^a-z0-9_]/g, "");
      if (sanitizedValue === "") {
        sanitizedValue = identifier;
        (event.target as HTMLInputElement).value = identifier; // Revert input value
      } else {
        sanitizedValue = this.ensureUniquePropertyIdentifier(sanitizedValue);
        this.renameProperty(identifier, sanitizedValue);
      }
    });

    return cell;
  }

  private createTypeCell(
    identifier: string,
    type: AnnotationUIType,
    enumLabels?: string[],
  ): HTMLDivElement {
    const typeText = this.createTypeTextElement(type, enumLabels);
    const iconWrapper = this.createIconWrapper(type, enumLabels);
    const typeCell = this.createTableCell(
      iconWrapper,
      "neuroglancer-annotation-schema-type-cell",
    );
    typeCell.appendChild(typeText);

    const readonly = this.readonly || type === "bool";
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

  private suggestEnumValue = (
    inputValues: number[],
    bounds: [number, number],
    startingValue = 0,
    direction: "up" | "down" = "up",
  ) => {
    let suggestedEnumValue = startingValue;
    let wrapped = false;
    while (inputValues.includes(suggestedEnumValue)) {
      const increment = direction === "up" ? 1 : -1;
      suggestedEnumValue += increment;
      if (suggestedEnumValue > bounds[1]) {
        if (wrapped) {
          throw new Error("No more unique values available in the enum.");
        }
        suggestedEnumValue = bounds[0]; // Wrap around to the lower bound if we exceed the upper bound
        wrapped = true;
      }
    }
    return suggestedEnumValue;
  };

  private createDefaultValueCell(
    identifier: string,
    type: AnnotationUIType,
  ): HTMLDivElement {
    const container = document.createElement("div");
    container.className =
      "neuroglancer-annotation-schema-default-value-cell-container";

    const inputs: (HTMLInputElement | HTMLTextAreaElement)[] = [];
    let changeFunction: (event: Event) => void;
    let isEnum = false;
    const oldProperty = this.getPropertyByIdentifier(identifier);
    if (oldProperty === undefined) {
      console.warn(`Property with name ${identifier} not found.`);
      return this.createTableCell(
        container,
        "neuruoglancer-annotation-schema-default-value-cell",
      );
    }
    if (type.startsWith("rgb")) {
      // Color types
      if (this.readonly) {
        const colorPreview = makeReadonlyColorProperty(
          oldProperty.default,
          type as AnnotationColorKey,
        );
        container.appendChild(colorPreview);
      } else {
        const colorProperty = makeEditableColorProperty(
          oldProperty.default,
          type as AnnotationColorKey,
        );
        inputs.push(colorProperty.color.element);

        if (type === "rgb") {
          changeFunction = () => {
            const newColor = colorProperty.color.getRGB();
            this.updateProperty(oldProperty, { default: packColor(newColor) });
          };
        } else {
          inputs.push(colorProperty.alpha!);
          changeFunction = () => {
            const newColor = colorProperty.color.getRGB();
            const newAlpha = colorProperty.alpha!.valueAsNumber;
            const colorVec = vec4.fromValues(
              newColor[0],
              newColor[1],
              newColor[2],
              newAlpha,
            );
            this.updateProperty(oldProperty, { default: packColor(colorVec) });
          };
        }
      }
    } else if (type === "bool") {
      // Enums with only True/False values
      const checkbox = makeBoolCheckbox(oldProperty.default === 1);
      checkbox.classList.add(
        "neuroglancer-annotation-schema-default-value-input",
      );
      checkbox.name = `neuroglancer-annotation-schema-default-value-input-${type}`;
      checkbox.name = `neuroglancer-annotation-schema-default-value-input-${type}`;
      inputs.push(checkbox);
      changeFunction = (event: Event) => {
        const newValue = (event.target as HTMLInputElement).checked;
        this.updateProperty(oldProperty, { default: newValue ? 1 : 0 });
      };
    } else if (
      "enumLabels" in oldProperty &&
      isEnumType(oldProperty.enumLabels)
    ) {
      // Enums of any type
      const { enumValues, enumLabels } = oldProperty;
      const enumContainer = document.createElement("div");
      enumContainer.className = "neuroglancer-annotation-schema-enum-container";
      let addEnumButton: HTMLElement | null = null;
      isEnum = true;
      if (!this.readonly) {
        const dataType = propertyTypeDataType[type as AnnotationPropertyType];
        const bounds = defaultDataTypeRange[dataType!] as [number, number];
        addEnumButton = makeAddButton({
          title: "Add new enum option",
          onClick: () => {
            const currentProperty = this.getPropertyByIdentifier(
              identifier,
            ) as AnnotationNumericPropertySpec;
            const currentEnumValues = currentProperty.enumValues!;
            const suggestedEnumValue = this.suggestEnumValue(
              currentEnumValues,
              bounds,
            );
            const newEnumValues = [...currentEnumValues!, suggestedEnumValue];
            this.updateProperty(currentProperty, {
              enumValues: newEnumValues,
              enumLabels: [
                ...currentProperty.enumLabels!,
                `${suggestedEnumValue} (label)`,
              ],
              default: newEnumValues[0], // Set default to the first enum value
            } as AnnotationNumericPropertySpec);
          },
        });
        enumContainer.appendChild(addEnumButton);
      }

      // For each enum entry, create a row with name, and value
      const addEnumEntry = (
        value: number,
        label: string,
        enumIndex: number,
      ) => {
        const enumRow = document.createElement("div");
        enumRow.className = "neuroglancer-annotation-schema-enum-entry";

        const nameInput = this.createInputElement(label, {
          type: "text",
          className: "neuroglancer-annotation-schema-default-value-input",
          useTextarea: true,
        });
        nameInput.name = `neuroglancer-annotation-schema-enum-input-text-${enumIndex}`;
        nameInput.classList.add(
          "neuroglancer-annotation-schema-enum-entry-textarea",
        );
        if (!this.readonly) {
          nameInput.addEventListener("change", (event) => {
            const newLabel = (event.target as HTMLInputElement).value;
            this.updateProperty(oldProperty, {
              enumLabels: oldProperty.enumLabels!.map((l, i) =>
                i === enumIndex ? newLabel : l,
              ),
            });
          });
        }

        const annotationType = this.parentView.mapUITypeToAnnotationType(type);
        const valueInput = this.createInputElement(value, {
          type: "number",
          className: "neuroglancer-annotation-schema-default-value-input",
          dataType: propertyTypeDataType[annotationType],
        });
        valueInput.name = `neuroglancer-annotation-schema-enum-input-value-${enumIndex}`;
        if (!this.readonly) {
          const dataType = propertyTypeDataType[annotationType];
          const bounds = defaultDataTypeRange[dataType!] as [number, number];
          let lastValue = value;
          valueInput.addEventListener("change", (event) => {
            const inputValue = (event.target as HTMLInputElement).value;
            let newValue =
              type === "float32"
                ? parseFloat(inputValue)
                : parseInt(inputValue, 10);
            const direction = newValue > lastValue ? "up" : "down";
            const currentProperty = this.getPropertyByIdentifier(
              identifier,
            ) as AnnotationNumericPropertySpec;
            const currentEnumValues = currentProperty.enumValues!;
            newValue = this.suggestEnumValue(
              currentEnumValues,
              bounds,
              newValue,
              direction,
            );
            lastValue = newValue;
            (event.target as HTMLInputElement).value = numberToStringFixed(
              newValue,
              4,
            );
            this.updateProperty(currentProperty, {
              enumValues: currentEnumValues.map((v, i) =>
                i === enumIndex ? newValue : v,
              ),
            });
          });
        }

        enumRow.appendChild(nameInput);
        enumRow.appendChild(valueInput);
        inputs.push(valueInput);

        if (!this.readonly) {
          const deleteIcon = document.createElement("span");
          deleteIcon.className = "neuroglancer-annotation-schema-delete-icon";
          deleteIcon.innerHTML = svg_bin;
          deleteIcon.title = "Delete enum row";
          deleteIcon.style.cursor = "pointer";
          const currentProperty = this.getPropertyByIdentifier(
            identifier,
          ) as AnnotationNumericPropertySpec;
          deleteIcon.addEventListener("click", () => {
            const newEnumValues = currentProperty.enumValues!.filter(
              (_, i) => i !== enumIndex,
            );
            const newEnumLabels = currentProperty.enumLabels!.filter(
              (_, i) => i !== enumIndex,
            );

            this.updateProperty(currentProperty, {
              enumValues: newEnumValues,
              enumLabels: newEnumLabels,
            });
          });
          enumRow.appendChild(deleteIcon);
          enumContainer.insertBefore(enumRow, addEnumButton);
        } else {
          enumContainer.appendChild(enumRow);
        }
      };
      for (let i = 0; i < enumValues!.length; i++) {
        addEnumEntry(enumValues![i], enumLabels![i], i);
      }

      container.appendChild(enumContainer);
    } else {
      // Regular numeric types
      const oldProperty = this.getPropertyByIdentifier(
        identifier,
      ) as AnnotationNumericPropertySpec;
      const dataType = propertyTypeDataType[type as AnnotationPropertyType];
      const numberInput = this.createInputElement(oldProperty.default, {
        type: "number",
        className: "neuroglancer-annotation-schema-default-value-input",
        dataType,
      });
      numberInput.name = `neuroglancer-annotation-schema-default-value-input-${type}`;
      inputs.push(numberInput);
      changeFunction = (event: Event) => {
        const newInputValue = (event.target as HTMLInputElement).value;
        const newValue =
          dataType === DataType.FLOAT32
            ? parseFloat(newInputValue)
            : parseInt(newInputValue, 10);
        this.updateProperty(oldProperty, { default: newValue });
      };
    }
    inputs.forEach((input) => {
      if (!isEnum) {
        container.appendChild(input);
        if (!this.readonly) {
          this.registerEventListener(input, "change", changeFunction);
        }
      }
    });
    this.defaultValueElements = inputs;
    const cell = this.createTableCell(
      container,
      "neuroglancer-annotation-schema-default-value-cell",
    );
    cell.dataset.enums = String(this.parentView.includesEnumProperties());
    this.defaultValueCell = cell;
    return cell;
  }

  private createInputElement(
    inputValue: number | string,
    config: InputConfig,
  ): HTMLInputElement | HTMLTextAreaElement {
    const readonly = this.readonly;

    if (config.type === "number") {
      return this.createNumberInput(inputValue as number, config, readonly);
    }

    if (config.type === "text") {
      return config.useTextarea
        ? this.createTextAreaElement(inputValue as string, config, readonly)
        : this.createTextInputElement(inputValue as string, config, readonly);
    }

    const input = document.createElement("input");
    input.type = config.type;
    this.setCommonInputAttributes(inputValue, input, config, readonly);
    return input;
  }

  private createNumberInput(
    inputValue: number,
    config: InputConfig,
    readonly: boolean,
  ): HTMLInputElement {
    const input = createBoundedNumberInputElement(inputValue, {
      className: config.className,
      numDecimals: config.numDecimals,
      readonly,
    });
    this.setCommonInputAttributes(inputValue, input, config, readonly);
    return input;
  }

  private createTextAreaElement(
    inputValue: string,
    config: InputConfig,
    readonly: boolean,
  ): HTMLTextAreaElement {
    const textarea = document.createElement("textarea");
    textarea.rows = 1;
    this.setCommonInputAttributes(inputValue, textarea, config, readonly);

    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        textarea.blur();
      }
    });

    const calculateRows = (): number => {
      const minRows = 1;
      const maxRows = 15;

      const originalRows = textarea.rows;
      textarea.rows = 1;
      const lineHeight =
        parseFloat(getComputedStyle(textarea).lineHeight) || 18;
      const rows = Math.ceil(textarea.scrollHeight / lineHeight);
      console.log(textarea.scrollHeight, lineHeight, rows, textarea.value);

      textarea.rows = originalRows;
      if (rows > maxRows) {
        textarea.style.overflowY = "auto";
      } else {
        textarea.style.overflowY = "hidden";
      }
      return Math.max(minRows, Math.min(maxRows, rows));
    };

    const updateTextareaRows = () => {
      textarea.rows = calculateRows();
    };
    const debouncedUpdateTextareaSize =
      animationFrameDebounce(updateTextareaRows);

    textarea.addEventListener("input", debouncedUpdateTextareaSize);
    const resizeObserver = new ResizeObserver(() => {
      debouncedUpdateTextareaSize();
    });
    resizeObserver.observe(textarea);
    debouncedUpdateTextareaSize();

    return textarea;
  }

  private createTextInputElement(
    inputValue: string,
    config: InputConfig,
    readonly: boolean,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    this.setCommonInputAttributes(inputValue, input, config, readonly);
    return input;
  }

  private setCommonInputAttributes(
    inputValue: number | string,
    element: HTMLInputElement | HTMLTextAreaElement,
    config: InputConfig,
    readonly: boolean,
  ): void {
    element.dataset.readonly = String(readonly);
    element.disabled = readonly;

    if (config.className) {
      element.classList.add(config.className);
    }

    if (
      typeof inputValue !== "number" ||
      element instanceof HTMLTextAreaElement
    ) {
      element.value = String(inputValue || "");
      element.autocomplete = "off";
      element.spellcheck = false;
    }
  }

  private createTypeTextElement(
    type: AnnotationUIType,
    enumLabels?: string[],
  ): HTMLSpanElement {
    const typeText = document.createElement("span");

    if (type === "bool") {
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
    currentType: AnnotationPropertyType,
    identifier: string,
  ) {
    const availableOptions: AnnotationPropertyType[] = [];
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

  private createDropdownElement(
    availableOptions: AnnotationPropertyType[],
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
    type: AnnotationUIType,
    enumLabels?: string[],
  ): HTMLSpanElement {
    const icon = makeIcon({
      svg: this.getIconForType(type, enumLabels),
      clickable: false,
    });
    icon.classList.add("neuroglancer-annotation-schema-type-icon");
    return icon;
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

  private handleTypeChange(
    newType: AnnotationPropertyType,
    identifier: string,
  ) {
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
  private defaultValueHeaderCell: HTMLDivElement | null = null;
  public annotationUIProperties: Map<string, AnnotationUIProperty> = new Map();
  public readonly: WatchableValueInterface<boolean>;
  public textWidthCanvas: HTMLCanvasElement | null = null;

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
    this.schemaViewTextElement.className =
      "neuroglancer-annotation-schema-main-text";
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

    const confirmPasteContainer = document.createElement("div");
    confirmPasteContainer.className =
      "neuroglancer-annotation-schema-confirm-paste-modal";
    const confirmPasteText = document.createElement("p");
    confirmPasteText.textContent =
      "Pasting a schema will overwrite the current schema. Are you sure you want to do this?";
    confirmPasteContainer.appendChild(confirmPasteText);

    const confirmPasteActionContainer = document.createElement("div");
    confirmPasteActionContainer.className =
      "neuroglancer-annotation-schema-confirm-paste-action";

    const confirmPasteButton = document.createElement("button");
    confirmPasteButton.textContent = "Confirm Paste";
    confirmPasteButton.className =
      "neuroglancer-annotation-schema-confirm-paste-button";
    confirmPasteButton.addEventListener("click", () => {
      this.pasteSchemaFromClipboard();
      confirmPasteContainer.style.display = "none";
      this.schemaPasteButton.classList.remove(
        "neuroglancer-annotation-schema-action-button-selected",
      );
    });
    confirmPasteActionContainer.appendChild(confirmPasteButton);
    const cancelPasteButton = document.createElement("button");
    cancelPasteButton.textContent = "Cancel";
    cancelPasteButton.className =
      "neuroglancer-annotation-schema-cancel-paste-button";
    cancelPasteButton.addEventListener("click", () => {
      confirmPasteContainer.style.display = "none";
      this.schemaPasteButton.classList.remove(
        "neuroglancer-annotation-schema-action-button-selected",
      );
    });
    confirmPasteActionContainer.appendChild(cancelPasteButton);
    confirmPasteContainer.style.display = "none"; // Initially hidden

    this.schemaPasteButton = makeIcon({
      title: "Paste schema from clipboard",
      svg: svg_clipboard,
      onClick: () => {
        // If there is any existing schema, then show a confirm first
        const hasExistingSchema = this.annotationUIProperties.size > 0;
        if (hasExistingSchema) {
          confirmPasteContainer.style.display = "flex";
          this.schemaPasteButton.classList.add(
            "neuroglancer-annotation-schema-action-button-selected",
          );
        } else this.pasteSchemaFromClipboard();
      },
    });
    confirmPasteContainer.appendChild(confirmPasteActionContainer);

    schemaActionButtons.appendChild(this.schemaPasteButton);
    schemaTextContainer.appendChild(confirmPasteContainer);

    this.element.appendChild(schemaTextContainer);
    this.element.appendChild(this.schemaTable);
    this.createSchemaTableHeader();
    this.schemaTable.appendChild(this.schemaTableBody);
    this.schemaTableBody.className =
      "neuroglancer-annotation-schema-table-body";
    this.createAnnotationSchemaDropdown();
  }

  private updateSchemaRepresentation(): boolean {
    // Check to see if the new IDs match the old keys
    const oldKeys = Array.from(this.annotationUIProperties.keys());
    const newKeys = this.schema.map((property) => property.identifier);
    // All the old keys that are not in the new keys need to be removed
    let needsUpdate = !arraysEqual(oldKeys, newKeys);
    for (const oldKey of oldKeys) {
      if (!newKeys.includes(oldKey)) {
        this.annotationUIProperties.delete(oldKey);
      }
    }
    for (const propertySchema of this.schema) {
      const annotationUIProperty = this.annotationUIProperties.get(
        propertySchema.identifier,
      );
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
          let allSameExceptDefault = true;
          const sameValues = comparedProperties.sameValues;
          for (const key in sameValues) {
            if (key === "default") continue; // Skip default value
            if (!sameValues[key as keyof typeof sameValues]) {
              allSameExceptDefault = false;
              break;
            }
          }
          if (
            (allSameExceptDefault && !sameValues.default) ||
            (sameValues.enumLength && !sameValues.enumValues)
          ) {
            // Only the default changed, just update that
            if (!sameValues.default) {
              annotationUIProperty.updateDefaultValue(propertySchema.default);
            }
            if (sameValues.enumLength && !sameValues.enumValues) {
              annotationUIProperty.updateEnumValues(
                (propertySchema as AnnotationNumericPropertySpec).enumValues!,
              );
            }
          } else {
            this.annotationUIProperties.set(
              propertySchema.identifier,
              new AnnotationUIProperty(propertySchema, this),
            );
            needsUpdate = true;
          }
        }
      }
    }
    return needsUpdate;
  }

  private populateSchemaTable() {
    const needUpdate = this.updateSchemaRepresentation();
    if (!needUpdate) return;
    removeChildren(this.schemaTableBody);
    const hasEnums = this.includesEnumProperties();
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
      annotationUIProperty.updateTableRowSize(hasEnums);
      this.schemaTableBody.appendChild(annotationUIProperty.element);
    });
  }

  private createSchemaTableHeader() {
    const tableHeaders = ["Name", "Type", "Default value"];
    const tableTitles = [
      "Hover a name to see the property description",
      "The type of the property",
      "For enums, these are the available options, first entry is the default value.",
    ];

    const addButtonField = document.createElement("div");
    addButtonField.className =
      "neuroglancer-annotation-schema-add-button-field";

    const headerRow = document.createElement("div");
    headerRow.classList.add("neuroglancer-annotation-schema-header-row");
    for (let i = 0; i < tableHeaders.length; ++i) {
      const text = tableHeaders[i];
      const title = tableTitles[i];
      const cell = this.createTableCell(text);
      if (text === "Default value") {
        cell.classList.add(
          "neuroglancer-annotation-schema-default-value-header",
        );
      }
      cell.title = title;
      this.defaultValueHeaderCell = cell;
      headerRow.appendChild(cell);
    }
    // Append a blank cell for the delete icon
    if (!this.readonly.value) {
      const descriptionHeader = this.createTableCell(
        "",
        "neuroglancer-annotation-schema-description-header",
      );
      const deleteHeader = this.createTableCell(
        "",
        "neuroglancer-annotation-schema-delete-header",
      );
      headerRow.appendChild(descriptionHeader);
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
      // Now do it again for the numeric types as enums
      populateDropDown(
        ANNOTATION_TYPES.filter((t) => isAnnotationTypeNumeric(t)),
        true,
      );

      document.body.appendChild(dropdown);
      const rect = addButton.getBoundingClientRect();
      const dropdownHeight = dropdown.offsetHeight;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;

      if (spaceBelow >= dropdownHeight || spaceBelow > spaceAbove) {
        // Enough space - position below
        dropdown.style.top = `${rect.bottom + window.scrollY}px`;
      } else {
        // Not enough space - position above
        dropdown.style.top = `${rect.top + window.scrollY - dropdownHeight - 10}px`;
      }

      dropdown.style.left = `${rect.left}px`;

      const handleOutsideClick = (e: MouseEvent) => {
        if (dropdown && !dropdown.contains(e.target as Node)) {
          dropdown.remove();
          dropdown = null;
          document.removeEventListener("mousedown", handleOutsideClick);
        }
      };
      document.addEventListener("mousedown", handleOutsideClick);
    };

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

  includesEnumProperties(): boolean {
    const schema = this.schema;
    return schema.some(
      (property) =>
        "enumValues" in property &&
        property.enumValues &&
        property.enumValues.length > 0,
    );
  }

  mapUITypeToAnnotationType(uiType: AnnotationUIType): AnnotationPropertyType {
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

  updateProperty(
    oldProperty: AnnotationPropertySpec,
    newPropertyValues: Partial<AnnotationPropertySpec>,
  ) {
    this.mutableSources.forEach((s) => {
      s.updateProperty(oldProperty, newPropertyValues);
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
    const success = setClipboard(this.jsonSchema);
    const copyMessage = success ? "copied" : "failed to copy";
    StatusMessage.showTemporaryMessage(
      `Annotation schema ${copyMessage} to clipboard`,
      /*duration=*/ 2000,
    );
  }

  private pasteSchemaFromClipboard() {
    navigator.clipboard.readText().then((text) => {
      try {
        const parsedSchema = parseAnnotationPropertySpecs(JSON.parse(text));
        const states = this.annotationStates.states;
        states.forEach((state) => {
          const source = state.source as LocalAnnotationSource;
          source.removeAllProperties();
          for (const property of parsedSchema) {
            console.debug("Adding property", property);
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
    const { schema, readonly } = this.extractSchema();
    this.schema = schema;
    this.readonly.value = readonly;
    const hasEnums = this.includesEnumProperties();
    if (this.defaultValueHeaderCell) {
      this.defaultValueHeaderCell.dataset.enums = String(hasEnums);
    }
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
