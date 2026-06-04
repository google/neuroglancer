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

import { describe, expect, it } from "vitest";
import {
  AccordionState,
  AccordionTab,
  type AccordionOptions,
} from "#src/widget/accordion.js";

function makeAccordionOptions(): AccordionOptions {
  return {
    accordionJsonKey: "test",
    sections: [
      {
        jsonKey: "first",
        displayName: "First",
        defaultExpanded: false,
        isDefaultKey: true,
      },
      {
        jsonKey: "second",
        displayName: "Second",
        defaultExpanded: true,
      },
    ],
  };
}

describe("accordion", () => {
  it("restores and serializes state", () => {
    const state = new AccordionState(makeAccordionOptions());

    expect(state.toJSON()).toBeUndefined();

    state.restoreState({ first: true, second: false });

    expect(state.getSectionState("first")?.isExpanded.value).toBe(true);
    expect(state.getSectionState("second")?.isExpanded.value).toBe(false);
    expect(state.toJSON()).toEqual({ first: true, second: false });
  });

  it("reflects initial expanded state in the DOM", () => {
    const tab = new AccordionTab(new AccordionState(makeAccordionOptions()));

    expect(tab.sections[0].container.dataset.expanded).toBe("false");
    expect(tab.sections[0].header.getAttribute("aria-expanded")).toBe("false");
    expect(tab.sections[1].container.dataset.expanded).toBe("true");
    expect(tab.sections[1].header.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles expanded state when header is clicked", () => {
    const state = new AccordionState(makeAccordionOptions());
    const tab = new AccordionTab(state);

    const section = tab.sections[0];
    expect(section.container.dataset.expanded).toBe("false");

    section.header.click();

    expect(state.getSectionState("first")?.isExpanded.value).toBe(true);
    expect(section.container.dataset.expanded).toBe("true");
    expect(section.header.getAttribute("aria-expanded")).toBe("true");
    expect(section.chevron.title).toBe("Collapse accordion section");
  });

  it("appends content to the requested section and shows it", () => {
    const tab = new AccordionTab(new AccordionState(makeAccordionOptions()));
    const child = document.createElement("div");
    child.textContent = "hello";

    tab.appendChild(child, "second");

    expect(tab.sections[1].body.contains(child)).toBe(true);
    expect(tab.sections[1].container.style.display).toBe("");

    // With no section specified, appends to default section
    tab.appendChild(child);
    expect(tab.sections[0].body.contains(child)).toBe(true);
  });
});
