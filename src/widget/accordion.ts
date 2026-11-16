import svg_chevron_down from "ikonate/icons/chevron-down.svg?raw";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import "#src/widget/accordion.css";
import { Tab } from "#src/widget/tab_view.js";

export interface AccordionSectionOptions {
  jsonKey: string;
  displayName: string;
  defaultExpanded?: boolean;
  isDefaultKey?: boolean;
}

export interface AccordionOptions {
  accordionJsonKey: string;
  sections: AccordionSectionOptions[];
}

export interface AccordionSection {
  name: string;
  jsonKey: string;
  container: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  chevron: HTMLElement;
}

export class AccordionSectionState extends RefCounted {
  isExpanded: WatchableValueInterface<boolean>;

  constructor(
    public jsonKey: string,
    private defaultExpanded: boolean,
    onChangeCallback: () => void,
  ) {
    super();
    this.isExpanded = new TrackableBoolean(defaultExpanded, defaultExpanded);
    this.registerDisposer(this.isExpanded.changed.add(onChangeCallback));
  }

  toJSON() {
    if (this.isExpanded.value === this.defaultExpanded) return undefined;
    return { [this.jsonKey]: this.isExpanded.value };
  }
}

export class AccordionState extends RefCounted {
  sectionStates: AccordionSectionState[] = [];
  specificationChanged = new NullarySignal();

  constructor(public accordionOptions: AccordionOptions) {
    super();
    for (const sectionOptions of accordionOptions.sections) {
      this.getOrCreateSectionState(sectionOptions);
    }
  }

  getOrCreateSectionState(sectionOptions: AccordionSectionOptions) {
    const { jsonKey, defaultExpanded = false } = sectionOptions;
    let sectionState = this.getSectionState(jsonKey);
    if (sectionState === undefined) {
      sectionState = this.registerDisposer(
        new AccordionSectionState(
          jsonKey,
          defaultExpanded,
          this.specificationChanged.dispatch,
        ),
      );
      this.sectionStates.push(sectionState);
    }
    return sectionState;
  }

  getSectionState(jsonKey: string): AccordionSectionState | undefined {
    return this.sectionStates.find((state) => state.jsonKey === jsonKey);
  }

  setSectionExpanded(jsonKey: string, expanded?: boolean): void {
    const section = this.getSectionState(jsonKey);
    if (section !== undefined) {
      section.isExpanded.value = expanded ?? !section.isExpanded.value;
    }
  }

  restoreState(value: unknown) {
    if (value === undefined || value === null || typeof value !== "object") {
      return;
    }
    for (const [jsonKey, expanded] of Object.entries(value)) {
      if (typeof expanded !== "boolean") continue;
      this.setSectionExpanded(jsonKey, expanded);
    }
  }

  toJSON() {
    const sections = this.sectionStates
      .map((section) => section.toJSON())
      .filter((value) => value !== undefined);
    return sections.length === 0 ? undefined : Object.assign({}, ...sections);
  }
}

export class AccordionTab extends Tab {
  sections: AccordionSection[] = [];
  private defaultKey: string | undefined;

  constructor(protected accordionState: AccordionState) {
    super();
    this.element.classList.add("neuroglancer-accordion");
    this.registerDisposer(
      accordionState.specificationChanged.add(() =>
        this.updateSectionsExpanded(),
      ),
    );
    for (const option of accordionState.accordionOptions.sections) {
      this.createAccordionSection(option);
    }
    if (
      this.defaultKey === undefined &&
      accordionState.accordionOptions.sections.length !== 0
    ) {
      this.defaultKey = accordionState.accordionOptions.sections[0].jsonKey;
    }
    this.updateSectionsExpanded();
  }

  private updateSectionsExpanded() {
    for (const state of this.accordionState.sectionStates) {
      const section = this.getSectionByKey(state.jsonKey);
      if (section === undefined) continue;
      const expanded = state.isExpanded.value;
      section.container.dataset.expanded = String(expanded);
      section.header.setAttribute("aria-expanded", String(expanded));
      section.chevron.title = expanded
        ? "Collapse accordion section"
        : "Expand accordion section";
    }
  }

  private createAccordionSection(option: AccordionSectionOptions) {
    const section: AccordionSection = {
      name: option.displayName,
      jsonKey: option.jsonKey,
      container: document.createElement("div"),
      header: document.createElement("div"),
      body: document.createElement("div"),
      chevron: document.createElement("span"),
    };
    this.sections.push(section);
    const { container, header, body, chevron } = section;
    container.classList.add("neuroglancer-accordion-item");
    container.dataset.key = option.jsonKey;
    container.dataset.hidden = "true";
    header.classList.add("neuroglancer-accordion-header");
    header.tabIndex = 0;
    header.setAttribute("role", "button");
    body.classList.add("neuroglancer-accordion-body");
    container.append(header, body);
    this.element.appendChild(container);

    const headerText = document.createElement("span");
    headerText.classList.add("neuroglancer-accordion-header-text");
    headerText.textContent = option.displayName;
    chevron.classList.add(
      "neuroglancer-accordion-chevron",
      "neuroglancer-icon",
    );
    chevron.innerHTML = svg_chevron_down;
    header.append(headerText, chevron);

    if (option.isDefaultKey) this.defaultKey = option.jsonKey;
    const toggle = () => this.accordionState.setSectionExpanded(option.jsonKey);
    this.registerEventListener(header, "click", toggle);
    this.registerEventListener(header, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
    this.accordionState.getOrCreateSectionState(option);
  }

  private getSectionByKey(jsonKey: string | undefined) {
    return this.sections.find((section) => section.jsonKey === jsonKey);
  }

  private getSectionWithFallback(jsonKey?: string) {
    const section =
      this.getSectionByKey(jsonKey ?? this.defaultKey) ??
      this.getSectionByKey(this.defaultKey);
    if (section === undefined) {
      throw new Error(
        `Accordion section with key "${jsonKey ?? this.defaultKey}" not found.`,
      );
    }
    return section;
  }

  appendChild(content: HTMLElement, jsonKey?: string, skipShow = false): void {
    const section = this.getSectionWithFallback(jsonKey);
    section.body.appendChild(content);
    if (!skipShow) this.showSection(section.jsonKey);
  }

  setSectionHidden(jsonKey: string, hidden: boolean): void {
    const section = this.getSectionByKey(jsonKey);
    if (section !== undefined) {
      section.container.dataset.hidden = String(hidden);
    }
  }

  showSection(jsonKey: string): void {
    this.setSectionHidden(jsonKey, false);
  }

  hideSection(jsonKey: string): void {
    this.setSectionHidden(jsonKey, true);
  }
}
