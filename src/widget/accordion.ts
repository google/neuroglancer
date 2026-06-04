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
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import "#src/widget/accordion.css";
import { Tab } from "#src/widget/tab_view.js";

declare let NEUROGLANCER_USE_ACCORDIONS: boolean | undefined;
declare let NEUROGLANCER_ACCORDION_DEFAULT_EXPANDED: boolean | undefined;

export interface AccordionOptions {
  accordionJsonKey: string;
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

function getGlobalAccordionDefaultExpanded(): boolean {
  return typeof NEUROGLANCER_ACCORDION_DEFAULT_EXPANDED !== "undefined"
    ? NEUROGLANCER_ACCORDION_DEFAULT_EXPANDED
    : false;
}

function getGlobalUseAccordions(): boolean {
  return typeof NEUROGLANCER_USE_ACCORDIONS !== "undefined"
    ? NEUROGLANCER_USE_ACCORDIONS
    : true;
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
    const { jsonKey, defaultExpanded } = sectionOptions;
    let sectionState = this.getSectionState(jsonKey);
    if (sectionState === undefined) {
      sectionState = this.registerDisposer(
        new AccordionSectionState(
          jsonKey,
          defaultExpanded ?? getGlobalAccordionDefaultExpanded(),
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

  toJSON() {
    const sectionsData = this.sectionStates
      .map((section) => section.toJSON())
      .filter((data) => data !== undefined);

    return sectionsData.length === 0
      ? undefined
      : Object.assign({}, ...sectionsData);
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
    if (!getGlobalUseAccordions()) {
      this.setAccordionHeadersHidden(true);
    }
  }

  private setSectionExpanded(jsonKey: string, expand?: boolean): void {
    this.accordionState.setSectionExpanded(jsonKey, expand);
  }

  private updateSectionsExpanded() {
    const accordionsDisabled = !getGlobalUseAccordions();
    this.accordionState.sectionStates.forEach((state) => {
      const section = this.getSectionByKey(state.jsonKey);
      if (section === undefined) return;
      const { container, header, chevron } = section;
      const expand = accordionsDisabled || state.isExpanded.value;
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
    chevron.classList.add("neuroglancer-icon");
    chevron.innerHTML = svg_chevron_down;
    const headerText = document.createElement("span");
    headerText.classList.add("neuroglancer-accordion-header-text");
    headerText.textContent = option.displayName;
    header.appendChild(headerText);
    header.appendChild(chevron);

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

    const useAccordions =
      typeof NEUROGLANCER_USE_ACCORDIONS !== "undefined"
        ? NEUROGLANCER_USE_ACCORDIONS
        : true;
    if (!useAccordions) {
      container.classList.add("neuroglancer-accordion-no-border");
    }

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

  setAccordionHeadersHidden(hidden: boolean): void {
    this.sections.forEach((section) => {
      section.header.style.display = hidden ? "none" : "";
    });
  }
}
