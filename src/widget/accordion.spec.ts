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

  it("reflects and toggles expanded state in the DOM", () => {
    const state = new AccordionState(makeAccordionOptions());
    const tab = new AccordionTab(state);
    const section = tab.sections[0];

    expect(section.container.dataset.expanded).toBe("false");
    expect(section.header.getAttribute("aria-expanded")).toBe("false");
    section.header.click();

    expect(state.getSectionState("first")?.isExpanded.value).toBe(true);
    expect(section.container.dataset.expanded).toBe("true");
    expect(section.header.getAttribute("aria-expanded")).toBe("true");
  });

  it("appends content to the requested section and shows it", () => {
    const tab = new AccordionTab(new AccordionState(makeAccordionOptions()));
    const child = document.createElement("div");

    tab.appendChild(child, "second");

    expect(tab.sections[1].body.contains(child)).toBe(true);
    expect(tab.sections[1].container.dataset.hidden).toBe("false");
  });

  it("supports conditional section visibility", () => {
    const tab = new AccordionTab(new AccordionState(makeAccordionOptions()));
    const child = document.createElement("div");

    tab.appendChild(child, "first", true);
    expect(tab.sections[0].container.dataset.hidden).toBe("true");

    tab.showSection("first");
    expect(tab.sections[0].container.dataset.hidden).toBe("false");

    tab.hideSection("first");
    expect(tab.sections[0].container.dataset.hidden).toBe("true");
  });
});
