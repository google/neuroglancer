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
  AnnotationPropertySpec,
  LocalAnnotationSource,
} from "#src/annotation/index.js";
import { annotationPropertySpecsToJson } from "#src/annotation/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import { stableStringify } from "#src/util/json.js";
import { makeAddButton } from "#src/widget/add_button.js";
import { makeCopyButton } from "#src/widget/copy_button.js";
import { makeIcon } from "#src/widget/icon.js";
import { Tab } from "#src/widget/tab_view.js";
import { getRandomHexString } from "#src/util/random.js";
import { saveBlobToFile } from "#src/util/file_download.js";
import { StatusMessage } from "#src/status.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";
import { DataType } from "#src/util/data_type.js";
import { UserLayerWithAnnotations } from "#src/ui/annotations.js";

const DROPDOWN_OPTIONS = [
  { header: "General", items: ["float32", "Boolean"] },
  { header: "Enum", items: ["uint8", "uint16"] },
  { header: "Colour", items: ["RGB", "RGBa"] },
  { header: "Integer", items: ["int8", "int16", "int32"] },
];

const SECTION_ICONS: Record<string, string> = {
  Enum: svg_format_size,
  Colour: svg_palette,
  Integer: svg_numbers,
};

const ITEM_ICONS: Record<string, string> = {
  float32: svg_numbers,
  Boolean: svg_check,
};

export class AnnotationSchemaView extends Tab {
  get annotationStates() {
    return this.layer.annotationStates;
  }

  private schemaTable = document.createElement("div");
  // TODO (Aigul) the schema text container can be only in the DOM
  // doesn't need to be a part of the class as an instance attribute
  private schemaTextContainer = document.createElement("div");
  private schemaActionButtons = document.createElement("div");
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
    this.schemaTextContainer.className =
      "neuroglancer-annotation-schema-text-container";
    this.schemaActionButtons.className =
      "neuroglancer-annotation-schema-action-buttons";
    this.schemaTable.className = "neuroglancer-annotation-schema-grid";
    this.element.appendChild(this.schemaTextContainer);
    this.element.appendChild(this.schemaTable);
    this.makeUI();

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
    // TODO (Sean) I think this is not needed but double check
    // this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
  }

  private updateOnMutableChange = () => {
    this.updateAnnotationText();
    this.updatePasteVisibility();
  };

  private updateAnnotationText() {
    const setOrViewText = this.isMutable.value ? "Set" : "View read-only";
    this.schemaViewTextElement.textContent = `${setOrViewText} annotation property (metadata) schema for this layer which applies to all annotations in this layer.`;
  }

  private updatePasteVisibility() {
    this.schemaPasteButton.style.display = this.isMutable.value ? "" : "none";
  }

  private makeUI() {
    // TODO (Aigul) - extract this styling to CSS
    this.schemaViewTextElement.style.marginTop = "0";
    this.schemaViewTextElement.style.marginBottom = "0.25rem";
    this.schemaViewTextElement.style.padding = "0.25rem";
    this.schemaTextContainer.appendChild(this.schemaViewTextElement);
    this.schemaTextContainer.appendChild(this.schemaActionButtons);

    const downloadButton = makeIcon({
      title: "Download schema",
      svg: svg_download,
      onClick: () => this.downloadSchema(),
    });
    this.schemaActionButtons.appendChild(downloadButton);

    const copyButton = makeCopyButton({
      title: "Copy schema to clipboard",
      onClick: () => this.copySchemaToClipboard(),
    });
    this.schemaActionButtons.appendChild(copyButton);

    this.schemaPasteButton = makeIcon({
      title: "Paste schema from clipboard",
      svg: svg_clipboard,
      onClick: () => this.pasteSchemaFromClipboard(),
    });
    this.schemaActionButtons.appendChild(this.schemaPasteButton);

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
    let tableHeaders = ["Name", "Type", "Default value"];
    if (this.isMutable.value) {
      tableHeaders = [...tableHeaders, ""];
    }

    // Initialize Table
    const addButtonField = document.createElement("div");
    addButtonField.className =
      "neuroglancer-annotation-schema-add-button-field";

    // Create Header Row
    const headerRow = document.createElement("div");
    // TODO (Aigul) - header-row could be a little more specific
    // e.g. neuroglancer-annotation-schema-header-row
    headerRow.classList.add("neuroglancer-annotation-schema-row", "header-row");
    tableHeaders.forEach((text) => {
      headerRow.appendChild(this.createTableCell(text));
    });
    this.schemaTable.appendChild(headerRow);
  }

  // TODO (aigul) give the config an interface
  private createInputElement(
    config: {
      type: string;
      value?: string;
      name: string;
      id: string;
      className?: string;
    },
    numberConfig?: {
      min?: number;
      max?: number;
      step?: number;
    },
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
    // TODO (Aigul)- do we need "name" as a className?
    // If so, it should be more specific
    const cell = this.createTableCell(nameInput, "name");
    if (!this.isMutable.value) return cell;
    // TODO (Sean) maybe need to call removeEventListener
    // when the table is updated
    nameInput.addEventListener("change", () => {
      const rawValue = nameInput.value;
      // TODO (Sean) there needs to be a signal for the selected state
      // to now show the new name
      let sanitizedValue = rawValue.replace(/\s+/g, "_");
      const oldProperty = this.getPropertyByName(identifier);
      if (oldProperty === undefined) {
        console.warn(`Property with name ${identifier} not found.`);
        return;
      }
      if (sanitizedValue === "") {
        sanitizedValue = identifier;
      } else {
        const allProperties = this.schema;
        const initalName = sanitizedValue;
        let suffix = 0;
        while (
          allProperties.some(
            (property) => property.identifier === sanitizedValue,
          )
        ) {
          sanitizedValue = `${initalName}_${++suffix}`;
        }
      }
      this.updateProperty(oldProperty, {
        ...oldProperty,
        identifier: sanitizedValue,
      });
    });
    return cell;
  }

  private getTypeIcon(type: string): string {
    return (
      ITEM_ICONS[type] ||
      SECTION_ICONS[
        Object.keys(SECTION_ICONS).find((section) =>
          DROPDOWN_OPTIONS.find((d) => d.header === section)?.items.includes(
            type,
          ),
        ) || ""
      ] ||
      svg_format_size
    );
  }

  private createTypeCell(type: string, index: number): HTMLDivElement {
    const typeText = document.createElement("span");
    typeText.textContent = type;

    const iconWrapper = document.createElement("span");
    // TODO (Aigul) - include neuroglancer here
    // e.g. neuroglancer-annotation-schema-cell-icon-wrapper
    iconWrapper.classList.add("schema-cell-icon-wrapper");
    iconWrapper.innerHTML = this.getTypeIcon(type);

    const typeCell = this.createTableCell(iconWrapper, "type");
    typeCell.appendChild(typeText);
    typeCell.appendChild(typeText);
    // TODO (Aigul) could this link to the dropdown that shows when adding
    // a new property?
    // typeCell.addEventListener("click", (event) => {});
    return typeCell;
  }

  // TODO (SKM or Aigul -- use the actual default value from the schema to set the value here)
  private createDefaultValueCell(
    identifier: string,
    type: string,
    index: number,
  ): HTMLDivElement {
    const container = document.createElement("div");
    // TODO (Aigul) - extract into CSS
    container.style.width = "100%";
    container.style.display = "flex";

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
    if (type.startsWith("RGB")) {
      const colorInput = this.createInputElement({
        type: "color",
        name: `color-${index}`,
        id: `color-${index}`,
      });
      inputs.push(colorInput);
      changeFunction = (event: Event) => {
        const newColor = (event.target as HTMLInputElement).value;
        // TODO (SKM) - default only supports number right now, need to fix
        this.updateProperty(oldProperty, {
          ...oldProperty,
          default: newColor,
        });
      };
      if (type === "RGBa") {
        const alphaInput = this.createInputElement(
          {
            type: "number",
            name: `alpha-${index}`,
            id: `alpha-${index}`,
            value: "1.0",
            className: "schema-default-input",
          },
          { min: 0, max: 1, step: 0.01 },
        );
        inputs.push(alphaInput);
        changeFunction = (event: Event) => {
          const newColor = (event.target as HTMLInputElement).value;
          const newAlpha = alphaInput.value;
          // TODO (SKM) - default only supports number right now, need to fix
          this.updateProperty(oldProperty, {
            ...oldProperty,
            default: newColor + newAlpha,
          });
        };
      }
    } else if (
      type.startsWith("int") ||
      type.startsWith("uint") ||
      type === "float32"
    ) {
      const typeStringToDataType: Record<string, DataType> = {
        uint8: DataType.UINT8,
        uint16: DataType.UINT16,
        uint32: DataType.UINT32,
        int8: DataType.INT8,
        int16: DataType.INT16,
        int32: DataType.INT32,
        float32: DataType.FLOAT32,
      };
      const dataType = typeStringToDataType[type];
      const step = dataType === DataType.FLOAT32 ? 0.01 : 1;
      const bounds = defaultDataTypeRange[dataType];
      // TODO (Aigul) more specific className
      const numberInput = this.createInputElement(
        {
          type: "number",
          name: `number-${index}`,
          id: `number-${index}`,
          value: "0",
          className: "schema-default-input",
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
        });
      };
    } else if (type === "Boolean") {
      const booleanInput = this.createInputElement({
        type: "checkbox",
        name: `boolean-${index}`,
        id: `boolean-${index}`,
      });
      inputs.push(booleanInput);
      changeFunction = (event: Event) => {
        const newValue = (event.target as HTMLInputElement).checked;
        this.updateProperty(oldProperty, {
          ...oldProperty,
          default: Number(newValue),
        });
      };
    } else if (type.includes("Enum")) {
      const enumContainer = document.createElement("div");
      enumContainer.className = "enum-container";
      const addEnumEntry = () => {
        const enumRow = document.createElement("div");
        enumRow.className = "enum-entry";

        // TODO: append real keybinding element
        const keyLabel = document.createElement("div");
        keyLabel.classList.add("neuroglancer-tool-palette-tool-container");

        const nameInput = this.createInputElement({
          type: "text",
          name: `enum-name-${index}`,
          id: `enum-name-${index}`,
          className: "schema-default-input",
        });

        const valueInput = this.createInputElement({
          type: "number",
          value: "0",
          name: `enum-value-${index}`,
          id: `enum-value-${index}`,
          className: "schema-default-input",
        });

        enumRow.appendChild(keyLabel);
        enumRow.appendChild(nameInput);
        enumRow.appendChild(valueInput);
        enumContainer.insertBefore(enumRow, addEnumButton);
      };

      const addEnumButton = makeAddButton({
        title: "Add enum option",
        onClick: addEnumEntry,
      });
      enumContainer.appendChild(addEnumButton);

      // Add initial enum entry
      addEnumEntry();

      // TODO (SKM) - handle the change event
      container.appendChild(enumContainer);
    }
    // TODO (SKM) - again may need to unregister the event listeners
    inputs.forEach((input) => {
      container.appendChild(input);
      if (this.isMutable.value) {
        input.addEventListener("change", changeFunction);
      }
    });
    return this.createTableCell(container);
  }

  private populateSchemaTable() {
    const { schema, isMutable } = this;
    // Remove everything from the table except the header
    removeChildren(this.schemaTable);
    this.createSchemaTableHeader();

    schema.forEach((rowData, index) => {
      const row = document.createElement("div");
      row.classList.add("neuroglancer-annotation-schema-row");

      row.appendChild(this.createNameCell(rowData.identifier, index));
      row.appendChild(this.createTypeCell(rowData.type, index));
      row.appendChild(
        this.createDefaultValueCell(rowData.identifier, rowData.type, index),
      );

      // Delete Cell
      if (isMutable.value) {
        const deleteIcon = document.createElement("span");
        deleteIcon.innerHTML = svg_bin;
        deleteIcon.title = "Delete row";
        deleteIcon.style.cursor = "pointer";
        deleteIcon.addEventListener("click", () => {
          const propertyIdentifer = rowData.identifier;
          this.removeProperty(propertyIdentifer);
        });

        // TODO (Aigul) more specific className
        const deleteCell = this.createTableCell(deleteIcon, "delete-cell");
        row.appendChild(deleteCell);
      }

      this.schemaTable.appendChild(row);
      this.tableToPropertyIndex.push(index);
    });

    // TODO (Aigul) can you please factor this out into a function
    // that creates the add button and dropdown
    // it also needs to be visible only if mutable --
    // see how this was done for the paste button for example
    // Add Property Button
    if (!isMutable.value) return;
    let dropdown: HTMLDivElement | null = null;

    const handleAddPropertyClick = () => {
      if (dropdown) {
        dropdown.remove();
        dropdown = null;
        return;
      }

      dropdown = document.createElement("div");
      dropdown.className = "neuroglancer-annotation-schema-dropdown";

      DROPDOWN_OPTIONS.forEach((section) => {
        const headerEl = document.createElement("div");
        headerEl.className = "neuroglancer-annotation-schema-dropdown-header";
        headerEl.textContent = section.header;
        dropdown?.appendChild(headerEl);

        section.items.forEach((item) => {
          const option = document.createElement("div");
          option.className = "neuroglancer-annotation-schema-dropdown-option";

          const iconWrapper = document.createElement("span");
          iconWrapper.classList.add("schema-cell-icon-wrapper");
          iconWrapper.innerHTML =
            ITEM_ICONS[item] || SECTION_ICONS[section.header] || "";

          const text = document.createElement("span");
          text.textContent = item;

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
            console.log("Selected:", item);
            // TODO extract into a function and properly handle the defaults
            // + the naming system (`type+nextIncrement`)
            this.addProperty({
              type: item,
              identifier: `property_${getRandomHexString(2)}`,
              default: item === "Boolean" ? false : 0,
              description: "",
            } as AnnotationPropertySpec);
            dropdown?.remove();
            dropdown = null;
          });

          dropdown?.appendChild(option);
        });
      });

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

  private updateProperty(
    oldProperty: AnnotationPropertySpec,
    newProperty: AnnotationPropertySpec,
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
        finalSchema.push(
          state.map((property) => {
            const entries = Object.entries(property).filter(
              ([, value]) => value !== undefined,
            );
            return Object.fromEntries(entries);
          }),
        );
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
        const parsedSchema = JSON.parse(text);
        const states = this.annotationStates.states;
        states.forEach((state) => {
          const source = state.source as LocalAnnotationSource;
          for (const property of parsedSchema) {
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
