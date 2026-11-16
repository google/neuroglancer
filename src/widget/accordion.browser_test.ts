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
import { VirtualList } from "#src/widget/virtual_list.js";
import "#src/ui/annotations.css";
import "#src/widget/icon.css";

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

  it("preserves header padding and dividers with an outline disclosure icon", () => {
    const state = new AccordionState(makeAccordionOptions());
    const tab = new AccordionTab(state);
    tab.element.style.cssText = "width: 300px; font: 10pt sans-serif";
    const content = document.createElement("div");
    content.style.height = "40px";
    tab.appendChild(content, "second");
    document.body.appendChild(tab.element);

    try {
      const section = tab.sections[1];
      const icon = section.chevron.querySelector("svg")!;
      expect(getComputedStyle(section.header).padding).toBe("8px 2px");
      expect(getComputedStyle(section.container).borderBottomColor).toBe(
        "rgb(221, 221, 221)",
      );
      expect(
        section.container.getBoundingClientRect().height -
          content.getBoundingClientRect().height,
      ).toBeLessThanOrEqual(36);
      expect(getComputedStyle(icon).fill).toBe("none");
      expect(getComputedStyle(icon).stroke).not.toBe("none");
      expect(icon.getBoundingClientRect().width).toBe(14);
      expect(section.header.firstElementChild).toBe(section.chevron);
      expect(getComputedStyle(icon).transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
      section.header.click();
      expect(getComputedStyle(icon).transform).not.toBe(
        "matrix(1, 0, 0, 1, 0, 0)",
      );
    } finally {
      tab.dispose();
      state.dispose();
    }
  });

  it("keeps the annotation list bounded and scrollable", async () => {
    const state = new AccordionState(makeAccordionOptions());
    const tab = new AccordionTab(state);
    const panel = document.createElement("div");
    panel.className = "neuroglancer-tab-view";
    panel.style.cssText = "height: 500px; width: 300px; overflow: hidden";
    const stack = document.createElement("div");
    stack.className = "neuroglancer-stack-view";
    const annotationTab = document.createElement("div");
    annotationTab.className =
      "neuroglancer-tab-content neuroglancer-annotations-tab";
    tab.element.classList.add("neuroglancer-annotation-layer-view");
    const list = new VirtualList({
      source: {
        length: 100,
        render(index) {
          const row = document.createElement("div");
          row.textContent = `Annotation ${index}`;
          row.style.height = "20px";
          return row;
        },
      },
    });
    list.element.classList.add("neuroglancer-annotation-list");
    const controls = document.createElement("div");
    controls.textContent = "Annotation controls";
    tab.appendChild(controls, "second");
    tab.appendChild(list.element, "second");
    annotationTab.appendChild(tab.element);
    stack.appendChild(annotationTab);
    panel.appendChild(stack);
    document.body.appendChild(panel);

    try {
      await expect.poll(() => list.element.scrollHeight).toBe(2000);
      expect(list.element.clientHeight).toBeGreaterThan(0);
      expect(list.element.clientHeight).toBeLessThan(panel.clientHeight);
      list.element.scrollTop = list.element.scrollHeight;
      await expect
        .poll(() => list.element.textContent)
        .toContain("Annotation 99");

      tab.sections[1].header.click();
      expect(list.element.clientHeight).toBe(0);
      tab.sections[1].header.click();
      await expect.poll(() => list.element.clientHeight).toBeGreaterThan(0);
      expect(list.element.clientHeight).toBeLessThan(panel.clientHeight);
    } finally {
      list.dispose();
      tab.dispose();
      state.dispose();
      panel.remove();
    }
  });
});
