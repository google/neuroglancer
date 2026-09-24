/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test, vi } from "vitest";
import { WatchableValue } from "#src/trackable_value.js";
import { Tab, TabView } from "#src/widget/tab_view.js";

interface TestTabDescriptor {
  id: string;
  label: string;
  hidden: boolean;
  parent?: string;
}

function makeTabFactory(created: Map<string, Tab[]>) {
  return (id: string) => {
    const tab = new Tab();
    tab.element.dataset.tabId = id;
    if (id === "annotations") {
      tab.embeddedTabHost = document.createElement("div");
      tab.element.appendChild(tab.embeddedTabHost);
    }
    const instances = created.get(id) ?? [];
    instances.push(tab);
    created.set(id, instances);
    return tab;
  };
}

describe("TabView embedded child tabs", () => {
  test("renders a colocated child in its parent host", () => {
    const selected = new WatchableValue<string | undefined>("annotationFilter");
    const tabs = new WatchableValue<TestTabDescriptor[]>([
      { id: "annotations", label: "Annotations", hidden: false },
      {
        id: "annotationFilter",
        label: "Filter",
        hidden: false,
        parent: "annotations",
      },
    ]);
    const created = new Map<string, Tab[]>();
    const handleTabElement = vi.fn();
    const view = new TabView({
      makeTab: makeTabFactory(created),
      selectedTab: selected,
      tabs,
      handleTabElement,
    });

    expect(
      [...view.tabBar.querySelectorAll(".neuroglancer-tab-label")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["Annotations"]);
    expect(
      view.element.querySelector(".neuroglancer-embedded-tab-label")
        ?.textContent,
    ).toBe("Filter");
    expect(view.element.querySelector('[data-tab-id="annotationFilter"]')).toBe(
      created.get("annotationFilter")?.[0].element,
    );
    expect(handleTabElement).toHaveBeenCalledWith(
      "annotationFilter",
      expect.any(HTMLElement),
    );

    const parentDisposed = vi.spyOn(created.get("annotations")![0], "disposed");
    const childDisposed = vi.spyOn(
      created.get("annotationFilter")![0],
      "disposed",
    );

    tabs.value = [{ id: "annotations", label: "Annotations", hidden: false }];
    selected.value = "annotations";
    view.flush();

    expect(view.element.querySelector(".neuroglancer-embedded-tab")).toBeNull();
    expect(parentDisposed).toHaveBeenCalledOnce();
    expect(childDisposed).toHaveBeenCalledOnce();

    view.dispose();
    expect(parentDisposed).toHaveBeenCalledOnce();
    expect(childDisposed).toHaveBeenCalledOnce();
  });

  test("renders a child as an ordinary tab when its parent is absent", () => {
    const selected = new WatchableValue<string | undefined>("annotationFilter");
    const tabs = new WatchableValue<TestTabDescriptor[]>([
      {
        id: "annotationFilter",
        label: "Filter",
        hidden: false,
        parent: "annotations",
      },
    ]);
    const created = new Map<string, Tab[]>();
    const view = new TabView({
      makeTab: makeTabFactory(created),
      selectedTab: selected,
      tabs,
    });

    expect(view.tabBar.textContent).toBe("Filter");
    expect(view.element.querySelector(".neuroglancer-embedded-tab")).toBeNull();
    expect(view.element.querySelector('[data-tab-id="annotationFilter"]')).toBe(
      created.get("annotationFilter")?.[0].element,
    );
    view.dispose();
  });

  test("rebuilds tabs when a detached child is re-embedded", () => {
    const selected = new WatchableValue<string | undefined>("annotationFilter");
    const tabs = new WatchableValue<TestTabDescriptor[]>([
      {
        id: "annotationFilter",
        label: "Filter",
        hidden: false,
        parent: "annotations",
      },
    ]);
    const created = new Map<string, Tab[]>();
    const view = new TabView({
      makeTab: makeTabFactory(created),
      selectedTab: selected,
      tabs,
    });
    const detachedChildDisposed = vi.spyOn(
      created.get("annotationFilter")![0],
      "disposed",
    );

    tabs.value = [
      { id: "annotations", label: "Annotations", hidden: false },
      {
        id: "annotationFilter",
        label: "Filter",
        hidden: false,
        parent: "annotations",
      },
    ];
    view.flush();

    expect(view.tabBar.textContent).toBe("Annotations");
    expect(
      view.element.querySelector(".neuroglancer-embedded-tab-label")
        ?.textContent,
    ).toBe("Filter");
    expect(created.get("annotationFilter")).toHaveLength(2);
    expect(detachedChildDisposed).toHaveBeenCalledOnce();
    view.dispose();
  });
});
