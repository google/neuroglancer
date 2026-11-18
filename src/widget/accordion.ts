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

import svg_chevron_down from "ikonate/icons/chevron-down.svg?raw";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import { RefCounted } from "#src/util/disposable.js";
import { emptyToUndefined } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import "#src/widget/accordion.css";
import { Tab } from "#src/widget/tab_view.js";

export interface AccordionOptions {
  sections: AccordionSectionOptions[];
}

interface AccordionSectionOptions {
  jsonKey: string;
  displayName: string;
  defaultExpanded?: boolean;
  isDefaultKey?: boolean;
}

interface AccordionSection {
  name: string;
  jsonKey: string;
  container: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  chevron: HTMLElement;
}

export class AccordionSectionState extends RefCounted {
  isExpanded: TrackableBoolean;

  constructor(
    public jsonKey: string,
    defaultExpanded: boolean,
    onChangeCallback: () => void,
  ) {
    super();
    this.isExpanded = new TrackableBoolean(defaultExpanded, defaultExpanded);
    this.registerDisposer(this.isExpanded.changed.add(onChangeCallback));
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
    const { jsonKey, defaultExpanded } = sectionOptions;
    let sectionState = this.getSectionState(jsonKey);
    if (sectionState === undefined) {
      sectionState = this.registerDisposer(
        new AccordionSectionState(
          jsonKey,
          defaultExpanded ?? false,
          this.specificationChanged.dispatch,
        ),
      );
      this.sectionStates.push(sectionState);
    }
    return sectionState;
  }

  getSectionState(jsonKey: string): AccordionSectionState | undefined {
    return this.sectionStates.find((s) => s.jsonKey === jsonKey);
  }

  setSectionExpanded(jsonKey: string, expand?: boolean): void {
    const section = this.getSectionState(jsonKey);
    if (section !== undefined) {
      section.isExpanded.value = expand ?? !section.isExpanded.value;
    }
  }

  restoreState(obj: unknown) {
    if (obj === undefined || obj === null || typeof obj !== "object") {
      return;
    }
    for (const [jsonKey, isExpanded] of Object.entries(obj)) {
      if (typeof isExpanded !== "boolean") continue;
      this.setSectionExpanded(jsonKey, isExpanded);
    }
  }

  toJSON(): Record<string, boolean> | undefined {
    const json: Record<string, boolean> = {};
    for (const section of this.sectionStates) {
      const isExpanded = section.isExpanded.toJSON();
      if (isExpanded !== undefined) json[section.jsonKey] = isExpanded;
    }
    return emptyToUndefined(json);
  }
}

export class LayerAccordionStates extends RefCounted {
  readonly changed = new NullarySignal();
  private readonly states = new Map<string, AccordionState>();

  add(tabId: string, options: AccordionOptions): AccordionState {
    if (this.states.has(tabId)) {
      throw new Error(`Accordion for tab "${tabId}" is already defined.`);
    }
    const state = this.registerDisposer(new AccordionState(options));
    state.specificationChanged.add(this.changed.dispatch);
    this.states.set(tabId, state);
    return state;
  }

  restoreState(json: unknown): void {
    if (json === null || typeof json !== "object") return;
    for (const [tabId, sections] of Object.entries(json)) {
      this.states.get(tabId)?.restoreState(sections);
    }
  }

  toJSON(): Record<string, unknown> | undefined {
    const json: Record<string, unknown> = {};
    for (const [tabId, state] of this.states) {
      const sections = state.toJSON();
      if (sections !== undefined) json[tabId] = sections;
    }
    return emptyToUndefined(json);
  }
}

export class AccordionTab extends Tab {
  sections: AccordionSection[] = [];
  defaultKey: string | undefined;

  constructor(protected accordionState: AccordionState) {
    super();
    const options = accordionState.accordionOptions;
    this.element.classList.add("neuroglancer-accordion");
    this.registerDisposer(
      this.accordionState.specificationChanged.add(() =>
        this.updateSectionsExpanded(),
      ),
    );
    options.sections.forEach((option) => {
      this.createAccordionSection(option);
    });
    if (this.defaultKey === undefined && options.sections.length > 0) {
      this.defaultKey = options.sections[0].jsonKey;
    }
    this.updateSectionsExpanded();
  }

  private setSectionExpanded(jsonKey: string, expand?: boolean): void {
    this.accordionState.setSectionExpanded(jsonKey, expand);
  }

  private updateSectionsExpanded() {
    this.accordionState.sectionStates.forEach((state) => {
      const section = this.getSectionByKey(state.jsonKey);
      if (section === undefined) return;
      const { container, header, chevron } = section;
      const expand = state.isExpanded.value;
      container.dataset.expanded = String(expand);
      header.setAttribute("aria-expanded", String(expand));
      chevron.title = expand
        ? "Collapse accordion section"
        : "Expand accordion section";
    });
  }

  private createAccordionSection(
    option: AccordionSectionOptions,
  ): AccordionSection | undefined {
    const newSection: AccordionSection = {
      name: option.displayName,
      jsonKey: option.jsonKey,
      container: document.createElement("div"),
      header: document.createElement("div"),
      body: document.createElement("div"),
      chevron: document.createElement("span"),
    };
    this.sections.push(newSection);
    const { container, header, body, chevron } = newSection;
    container.classList.add("neuroglancer-accordion-item");
    body.classList.add("neuroglancer-accordion-body");
    header.classList.add("neuroglancer-accordion-header");
    container.appendChild(newSection.header);
    container.appendChild(newSection.body);
    this.element.appendChild(container);

    chevron.classList.add("neuroglancer-accordion-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = svg_chevron_down;
    const headerText = document.createElement("span");
    headerText.classList.add("neuroglancer-accordion-header-text");
    headerText.textContent = option.displayName;
    header.appendChild(chevron);
    header.appendChild(headerText);

    container.dataset.expanded = String(option.defaultExpanded ?? false);
    // Adding a child element automatically sets the hidden attribute to false
    // so this hides empty sections
    container.dataset.hidden = "true";

    if (option.isDefaultKey) {
      this.defaultKey = option.jsonKey;
    }

    this.registerEventListener(newSection.header, "click", () =>
      this.setSectionExpanded(option.jsonKey),
    );

    // Usually, the state is pre-propulated with all the relevant sections.
    // However, because appendChild is public and can be called with
    // a jsonKey that is not in the initial accordionOptions, we need to
    // add the section into the state if that happens
    // This state wouldn't get properly restored if that occurs,
    // but in case there is some unforeseen section added, at least
    // the controls to expand/collapse it will still work because of this
    this.accordionState.getOrCreateSectionState(option);
    return newSection;
  }

  private getSectionByKey(
    jsonKey: string | undefined,
  ): AccordionSection | undefined {
    return this.sections.find((e) => e.jsonKey === jsonKey);
  }

  private getSectionWithFallback(jsonKey?: string): AccordionSection {
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

  // Usually adding a child automatically shows the section
  // but skipShow can be used to avoid this behaviour
  appendChild(
    content: HTMLElement,
    jsonKey?: string,
    skipShow?: boolean,
  ): void {
    const section = this.getSectionWithFallback(jsonKey);
    section.body.appendChild(content);
    if (!skipShow) {
      this.showSection(section.jsonKey);
    }
  }

  /**
   * Set the visibility of the section with the given jsonKey.
   * This is different to expanding/collapsing the section.
   */
  setSectionHidden(jsonKey: string, hidden: boolean): void {
    const section = this.getSectionByKey(jsonKey);
    if (section !== undefined) {
      section.container.dataset.hidden = hidden ? "true" : "false";
    }
  }

  /**
   * Show the section with the given jsonKey.
   * This is different to expanding the section, it is only about visibility.
   */
  showSection(jsonKey: string): void {
    this.setSectionHidden(jsonKey, false);
  }

  /**
   * Hide the section with the given jsonKey.
   * This is different to collapsing the section, it is only about visibility.
   */
  hideSection(jsonKey: string): void {
    this.setSectionHidden(jsonKey, true);
  }
}
