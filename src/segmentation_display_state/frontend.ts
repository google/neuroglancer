/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { LayerChunkProgressInfo } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { ChunkRenderLayerFrontend } from "#src/chunk_manager/frontend.js";
import type { LayerSelectedValues } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { PickIDManager } from "#src/object_picking.js";
import type { WatchableRenderLayerTransform } from "#src/render_coordinate_transform.js";
import type { RenderScaleHistogram } from "#src/render_scale_statistics.js";
import type { RenderLayer } from "#src/renderlayer.js";
import type { SegmentColorHash } from "#src/segment_color.js";
import { getCssColor } from "#src/segment_color.js";
import type { VisibleSegmentsState } from "#src/segmentation_display_state/base.js";
import {
  forEachVisibleSegment,
  onTemporaryVisibleSegmentsStateChanged,
  onVisibleSegmentsStateChanged,
  VISIBLE_SEGMENTS_STATE_PROPERTIES,
} from "#src/segmentation_display_state/base.js";
import type {
  InlineSegmentNumericalProperty,
  InlineSegmentProperty,
  PreprocessedSegmentPropertyMap,
} from "#src/segmentation_display_state/property_map.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { TrackableAlphaValue } from "#src/trackable_alpha.js";
import type {
  TrackableValue,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import { observeWatchable, registerNestedSync } from "#src/trackable_value.js";
import { isWithinSelectionPanel } from "#src/ui/selection_details.js";
import type { Uint64Map } from "#src/uint64_map.js";
import { wrapSigned32BitIntegerToUint64 } from "#src/util/bigint.js";
import { setClipboard } from "#src/util/clipboard.js";
import { useWhiteBackground } from "#src/util/color.js";
import { RefCounted } from "#src/util/disposable.js";
import { measureElementClone } from "#src/util/dom.js";
import type { vec3 } from "#src/util/geom.js";
import { kOneVec, vec4 } from "#src/util/geom.js";
import { parseUint64 } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import { withSharedVisibility } from "#src/visibility_priority/frontend.js";
import { makeCopyButton } from "#src/widget/copy_button.js";
import { makeEyeButton } from "#src/widget/eye_button.js";
import { makeFilterButton } from "#src/widget/filter_button.js";
import { makeStarButton } from "#src/widget/star_button.js";

export class Uint64MapEntry {
  constructor(
    public key: bigint,
    public value?: bigint,
    public label?: string | undefined,
  ) {}
  toString() {
    const { key, value, label } = this;
    let baseString: string;
    if (value === undefined) {
      baseString = `${key}`;
    } else {
      baseString = `${key}→${value}`;
    }
    if (label === undefined) return baseString;
    return `${baseString} ${label}`;
  }
}

export class SegmentSelectionState extends RefCounted {
  selectedSegment = 0n;
  baseSelectedSegment = 0n;
  hasSelectedSegment = false;
  changed = new NullarySignal();

  get value() {
    return this.hasSelectedSegment ? this.selectedSegment : undefined;
  }

  get baseValue() {
    return this.hasSelectedSegment ? this.baseSelectedSegment : undefined;
  }

  set(
    value: number | Uint64MapEntry | bigint | null | undefined,
    hideSegmentZero = false,
  ) {
    const { selectedSegment, baseSelectedSegment } = this;
    let newId = 0n;
    let newBaseId = 0n;
    let hasSelectedSegment: boolean;
    if (value == null) {
      hasSelectedSegment = false;
    } else if (typeof value === "number") {
      newId = newBaseId = wrapSigned32BitIntegerToUint64(value);
      hasSelectedSegment = true;
    } else if (value instanceof Uint64MapEntry) {
      const valueMapped = value.value || value.key;
      newId = valueMapped;
      newBaseId = value.key;
      hasSelectedSegment = true;
    } else if (typeof value === "bigint") {
      newId = newBaseId = value;
      hasSelectedSegment = true;
    } else {
      hasSelectedSegment = false;
    }
    if (hideSegmentZero && newId === 0n) {
      hasSelectedSegment = false;
    }
    if (!hasSelectedSegment) {
      if (this.hasSelectedSegment) {
        this.hasSelectedSegment = false;
        this.changed.dispatch();
      }
    } else if (
      hasSelectedSegment &&
      (!this.hasSelectedSegment ||
        selectedSegment !== newId ||
        baseSelectedSegment !== newBaseId)
    ) {
      this.selectedSegment = newId;
      this.baseSelectedSegment = newBaseId;
      this.hasSelectedSegment = true;
      this.changed.dispatch();
    }
  }

  isSelected(value: bigint) {
    return this.hasSelectedSegment && value === this.selectedSegment;
  }

  bindTo(
    layerSelectedValues: LayerSelectedValues,
    userLayer: SegmentationUserLayer,
  ) {
    this.registerDisposer(
      layerSelectedValues.changed.add(() => {
        const state = layerSelectedValues.get(userLayer);
        let value: any = undefined;
        if (state !== undefined) {
          value = state.value;
        }
        this.set(
          value,
          userLayer.displayState.segmentationGroupState.value.hideSegmentZero
            .value,
        );
      }),
    );
  }
}

export interface SegmentationGroupState extends VisibleSegmentsState {
  /**
   * Maximum length of base-10 representation of id seen.
   */
  maxIdLength: WatchableValueInterface<number>;
  segmentPropertyMap: WatchableValueInterface<
    PreprocessedSegmentPropertyMap | undefined
  >;
}

export interface SegmentationColorGroupState {
  segmentColorHash: SegmentColorHash;
  segmentStatedColors: Uint64Map;
  tempSegmentStatedColors2d: Uint64Map;
  segmentDefaultColor: WatchableValueInterface<vec3 | undefined>;
  tempSegmentDefaultColor2d: WatchableValueInterface<vec3 | vec4 | undefined>;
}

export interface SegmentationDisplayState {
  segmentSelectionState: SegmentSelectionState;
  saturation: TrackableAlphaValue;
  hoverHighlight: WatchableValueInterface<boolean>;
  baseSegmentColoring: WatchableValueInterface<boolean>;
  baseSegmentHighlighting: WatchableValueInterface<boolean>;
  segmentationGroupState: WatchableValueInterface<SegmentationGroupState>;
  segmentationColorGroupState: WatchableValueInterface<SegmentationColorGroupState>;

  selectSegment: (id: bigint, pin: boolean | "toggle") => void;
  filterBySegmentLabel: (id: bigint) => void;
  moveToSegment: (id: bigint) => void;

  // Indirect properties
  hideSegmentZero: WatchableValueInterface<boolean>;
  segmentColorHash: WatchableValueInterface<number>;
  segmentStatedColors: WatchableValueInterface<Uint64Map>;
  tempSegmentStatedColors2d: WatchableValueInterface<Uint64Map>;
  useTempSegmentStatedColors2d: WatchableValueInterface<boolean>;
  segmentDefaultColor: WatchableValueInterface<vec3 | undefined>;
  tempSegmentDefaultColor2d: WatchableValueInterface<vec3 | vec4 | undefined>;
  highlightColor: WatchableValueInterface<vec4 | undefined>;
}

export function resetTemporaryVisibleSegmentsState(
  state: VisibleSegmentsState,
) {
  state.useTemporarySegmentEquivalences.value = false;
  state.useTemporaryVisibleSegments.value = false;
  state.temporaryVisibleSegments.clear();
  state.temporarySegmentEquivalences.clear();
}

/// Converts a segment id to a Uint64MapEntry or uint64 (if Uint64MapEntry would add no additional
/// information).
export function maybeAugmentSegmentId(
  displayState: SegmentationDisplayState | undefined | null,
  value: number | bigint | string,
): bigint | Uint64MapEntry {
  let id: bigint;
  let mappedValue: bigint;
  let mapped: bigint | undefined;
  if (typeof value === "number") {
    id = wrapSigned32BitIntegerToUint64(value);
  } else if (typeof value === "string") {
    id = parseUint64(value);
  } else {
    id = value;
  }
  if (displayState == null) return id;
  const {
    segmentEquivalences,
    segmentPropertyMap: { value: segmentPropertyMap },
  } = displayState.segmentationGroupState.value;
  if (segmentEquivalences.size !== 0) {
    mappedValue = segmentEquivalences.get(id);
    if (mappedValue === id) {
      mapped = undefined;
    } else {
      mapped = mappedValue;
    }
  } else {
    mappedValue = id;
  }
  const label = segmentPropertyMap?.getSegmentLabel(mappedValue);
  if (label === undefined && mapped === undefined) {
    return id;
  }
  return new Uint64MapEntry(id, mapped, label);
}

/// Converts a plain segment id to a Uint64MapEntry.
export function augmentSegmentId(
  displayState: SegmentationDisplayState | undefined | null,
  value: number | bigint | Uint64MapEntry,
): Uint64MapEntry {
  if (value instanceof Uint64MapEntry) return value;
  const newValue = maybeAugmentSegmentId(displayState, value);
  if (typeof newValue === "bigint") {
    return new Uint64MapEntry(newValue);
  }
  return newValue;
}

export function updateIdStringWidth(
  idStringWidth: WatchableValueInterface<number>,
  idString: string,
) {
  const { length } = idString;
  if (idStringWidth.value < length) {
    idStringWidth.value = length;
  }
}

export function bindSegmentListWidth(
  displayState: SegmentationDisplayState,
  element: HTMLElement,
) {
  return observeWatchable(
    (width) =>
      element.style.setProperty(
        "--neuroglancer-segment-list-width",
        `${width}ch`,
      ),
    displayState.segmentationGroupState.value.maxIdLength,
  );
}

const segmentWidgetTemplate = (() => {
  const template = document.createElement("div");
  template.classList.add("neuroglancer-segment-list-entry");
  const stickyContainer = document.createElement("div");
  stickyContainer.classList.add("neuroglancer-segment-list-entry-sticky");
  template.appendChild(stickyContainer);
  const copyButton = makeCopyButton({
    title: "Copy segment ID",
  });
  copyButton.classList.add("neuroglancer-segment-list-entry-copy");
  const copyContainer = document.createElement("div");
  copyContainer.classList.add("neuroglancer-segment-list-entry-copy-container");
  const copyIndex = copyContainer.childElementCount;
  copyContainer.appendChild(copyButton);
  const copyContainerIndex = stickyContainer.childElementCount;
  stickyContainer.appendChild(copyContainer);
  const visibleIndex = stickyContainer.childElementCount;
  const visibleIcon = makeEyeButton({
    title: "Toggle segment visibility",
  });
  visibleIcon.classList.add("neuroglancer-segment-list-entry-visible-checkbox");
  stickyContainer.appendChild(visibleIcon);
  const idContainer = document.createElement("div");
  idContainer.classList.add("neuroglancer-segment-list-entry-id-container");
  const idContainerIndex = stickyContainer.childElementCount;
  stickyContainer.appendChild(idContainer);
  const idElement = document.createElement("div");
  idElement.classList.add("neuroglancer-segment-list-entry-id");
  const idIndex = idContainer.childElementCount;
  idContainer.appendChild(idElement);
  const starButton = makeStarButton({
    title: "Star segment",
  });
  starButton.classList.add("neuroglancer-segment-list-entry-star");
  const starIndex = stickyContainer.childElementCount;
  stickyContainer.appendChild(starButton);

  const nameElement = document.createElement("span");
  nameElement.classList.add("neuroglancer-segment-list-entry-name");
  const labelIndex = template.childElementCount;
  template.appendChild(nameElement);
  const filterElement = makeFilterButton({
    title: "Filter by label",
  });
  filterElement.classList.add("neuroglancer-segment-list-entry-filter");
  const filterIndex = template.childElementCount;
  template.appendChild(filterElement);
  return {
    template,
    copyContainerIndex,
    copyIndex,
    visibleIndex,
    idContainerIndex,
    idIndex,
    labelIndex,
    filterIndex,
    starIndex,
    unmappedIdIndex: -1,
    unmappedCopyIndex: -1,
  };
})();

const segmentWidgetTemplateWithUnmapped = (() => {
  const t = segmentWidgetTemplate;
  const template = t.template.cloneNode(/*deep=*/ true) as HTMLDivElement;
  const stickyContainer = template.children[0] as HTMLElement;
  const idContainer = stickyContainer.children[
    t.idContainerIndex
  ] as HTMLElement;
  const unmappedIdIndex = idContainer.childElementCount;
  const unmappedIdElement = idContainer.children[t.idIndex].cloneNode(
    /*deep=*/ true,
  ) as HTMLElement;
  unmappedIdElement.classList.add(
    "neuroglancer-segment-list-entry-unmapped-id",
  );
  idContainer.appendChild(unmappedIdElement);
  const copyContainer = stickyContainer.children[
    t.copyContainerIndex
  ] as HTMLElement;
  const unmappedCopyIndex = copyContainer.childElementCount;
  copyContainer.appendChild(
    copyContainer.children[t.copyIndex].cloneNode(/*deep=*/ true),
  );
  return { ...t, template, unmappedIdIndex, unmappedCopyIndex };
})();

export type SegmentWidgetTemplate = typeof segmentWidgetTemplate;

interface SegmentWidgetWithExtraColumnsTemplate extends SegmentWidgetTemplate {
  numericalPropertyIndices: number[];
}

export function segmentWidgetTemplateWithExtraColumns(
  numExtraColumns: number,
): SegmentWidgetWithExtraColumnsTemplate {
  const origTemplate = segmentWidgetTemplate;
  const templateElement = origTemplate.template.cloneNode(
    /*deep=*/ true,
  ) as HTMLDivElement;
  const numericalPropertyIndices: number[] = [];
  for (let i = 0; i < numExtraColumns; ++i) {
    numericalPropertyIndices.push(templateElement.childElementCount);
    const child = document.createElement("div");
    child.classList.add("neuroglancer-segment-list-entry-extra-property");
    child.style.width = `max(var(--neuroglancer-column-${i}-width), var(--neuroglancer-column-${i}-label-width))`;
    templateElement.appendChild(child);
  }
  return {
    ...origTemplate,
    template: templateElement,
    numericalPropertyIndices,
  };
}

const cachedRegisterSegmentWidgetEventHandlers = new WeakMap<
  SegmentationDisplayState,
  (element: HTMLElement, template: SegmentWidgetTemplate) => void
>();

function makeRegisterSegmentWidgetEventHandlers(
  displayState: SegmentationDisplayState,
) {
  const onMouseEnter = (event: Event) => {
    const entryElement = event.currentTarget as HTMLElement;
    const idString = entryElement.dataset.id!;
    const id = BigInt(idString);
    displayState.segmentSelectionState.set(id);
    if (!isWithinSelectionPanel(entryElement)) {
      displayState.selectSegment(id, false);
    }
  };

  const selectHandler = (event: Event) => {
    const entryElement = event.currentTarget as HTMLElement;
    const idString = entryElement.dataset.id!;
    const id = BigInt(idString);
    displayState.selectSegment(
      id,
      isWithinSelectionPanel(entryElement) ? "toggle" : true,
    );
  };

  const onMouseLeave = () => {
    displayState.segmentSelectionState.set(null);
  };

  const getEntryElement = (event: Event): HTMLElement => {
    return (event.currentTarget as HTMLElement).closest(
      ".neuroglancer-segment-list-entry",
    ) as HTMLElement;
  };

  const copyHandler = (event: Event) => {
    const entryElement = getEntryElement(event);
    setClipboard(entryElement.dataset.id!);
    event.stopPropagation();
  };

  const unmappedCopyHandler = (event: Event) => {
    const entryElement = getEntryElement(event);
    setClipboard(entryElement.dataset.unmappedId!);
    event.stopPropagation();
  };

  const visibleCheckboxHandler = (event: Event) => {
    const entryElement = getEntryElement(event);
    const idString = entryElement.dataset.id!;
    const id = BigInt(idString);
    const { selectedSegments, visibleSegments } =
      displayState.segmentationGroupState.value;
    const shouldBeVisible = !visibleSegments.has(id);
    if (shouldBeVisible) {
      selectedSegments.add(id);
    }
    visibleSegments.set(id, shouldBeVisible);
    event.stopPropagation();
    event.preventDefault();
  };

  const filterHandler = (event: Event) => {
    const entryElement = getEntryElement(event);
    const idString = entryElement.dataset.id!;
    const id = BigInt(idString);
    displayState.filterBySegmentLabel(id);
    event.stopPropagation();
  };

  const onMousedown = (event: MouseEvent) => {
    if (
      event.button !== 2 ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const entryElement = event.currentTarget as HTMLElement;
    const idString = entryElement.dataset.id!;
    const id = BigInt(idString);
    displayState.moveToSegment(id);
  };

  return (element: HTMLElement, template: SegmentWidgetTemplate) => {
    const { children } = element;
    const stickyChildren = children[0].children;
    element.addEventListener("mousedown", onMousedown);
    const copyContainer = stickyChildren[
      template.copyContainerIndex
    ] as HTMLElement;
    if (template.unmappedCopyIndex !== -1) {
      copyContainer.children[template.unmappedCopyIndex].addEventListener(
        "click",
        unmappedCopyHandler,
      );
    }
    copyContainer.children[template.copyIndex].addEventListener(
      "click",
      copyHandler,
    );
    element.addEventListener("mouseenter", onMouseEnter);
    element.addEventListener("mouseleave", onMouseLeave);
    stickyChildren[template.visibleIndex].addEventListener(
      "click",
      visibleCheckboxHandler,
    );
    children[template.filterIndex].addEventListener("click", filterHandler);
    element.addEventListener("action:select-position", selectHandler);

    const starButton = stickyChildren[template.starIndex] as HTMLElement;
    starButton.addEventListener("click", (event: MouseEvent) => {
      const entryElement = getEntryElement(event);
      const idString = entryElement.dataset.id!;
      const id = BigInt(idString);
      const { selectedSegments } = displayState.segmentationGroupState.value;
      selectedSegments.set(id, !selectedSegments.has(id));
    });
  };
}

export class SegmentWidgetFactory<Template extends SegmentWidgetTemplate> {
  private registerEventHandlers:
    | undefined
    | ((element: HTMLElement, template: SegmentWidgetTemplate) => void);
  constructor(
    public displayState: SegmentationDisplayState | undefined,
    protected template: Template,
  ) {
    if (displayState !== undefined) {
      let r = cachedRegisterSegmentWidgetEventHandlers.get(displayState);
      if (r === undefined) {
        r = makeRegisterSegmentWidgetEventHandlers(displayState);
        cachedRegisterSegmentWidgetEventHandlers.set(displayState, r);
      }
      this.registerEventHandlers = r;
    }
  }

  static make(
    displayState: SegmentationDisplayState | undefined,
    includeUnmapped: boolean,
  ) {
    return new SegmentWidgetFactory(
      displayState,
      includeUnmapped
        ? segmentWidgetTemplateWithUnmapped
        : segmentWidgetTemplate,
    );
  }

  get(rawId: bigint | number): HTMLDivElement {
    const { displayState } = this;
    return this.getWithNormalizedId(augmentSegmentId(displayState, rawId));
  }

  getWithNormalizedId(normalizedId: Uint64MapEntry): HTMLDivElement {
    const { displayState } = this;
    const { template } = this;
    const container = template.template.cloneNode(
      /*deep=*/ true,
    ) as HTMLDivElement;
    const id = normalizedId.key;
    const mapped = normalizedId.value ?? id;
    const mappedIdString = mapped.toString();
    container.dataset.id = mappedIdString;
    const { children } = container;
    const stickyChildren = children[0].children;
    const idContainer = stickyChildren[
      template.idContainerIndex
    ] as HTMLElement;
    idContainer.children[template.idIndex].textContent = mappedIdString;
    const { unmappedIdIndex } = template;
    if (displayState !== undefined) {
      this.registerEventHandlers!(container, template);
    } else {
      (stickyChildren[template.visibleIndex] as HTMLElement).style.display =
        "none";
    }
    if (unmappedIdIndex !== -1) {
      const unmappedIdElement = idContainer.children[
        unmappedIdIndex
      ] as HTMLElement;
      if (id !== mapped) {
        const unmappedIdString = id.toString();
        container.dataset.unmappedId = unmappedIdString;
        unmappedIdElement.textContent = unmappedIdString;
        if (displayState !== undefined) {
          updateIdStringWidth(
            displayState.segmentationGroupState.value.maxIdLength,
            unmappedIdString,
          );
        }
      } else {
        unmappedIdElement.style.display = "none";
        const copyContainer = stickyChildren[
          template.copyContainerIndex
        ] as HTMLElement;
        (
          copyContainer.children[template.unmappedCopyIndex] as HTMLElement
        ).style.display = "none";
      }
    }
    children[template.labelIndex].textContent = normalizedId.label ?? "";
    if (displayState !== undefined) {
      this.updateWithId(container, mapped);
      updateIdStringWidth(
        displayState.segmentationGroupState.value.maxIdLength,
        mappedIdString,
      );
    }
    return container;
  }

  update(container: HTMLElement) {
    const idString = container.dataset.id;
    if (idString === undefined) return;
    const id = BigInt(idString);
    this.updateWithId(container, id);
  }

  private updateWithId(container: HTMLElement, mapped: bigint) {
    const { children } = container;
    const stickyChildren = children[0].children;
    const { template } = this;
    const { displayState } = this;
    const { segmentSelectionState } = displayState!;
    const { visibleSegments } = displayState!.segmentationGroupState.value;
    (
      stickyChildren[template.visibleIndex] as HTMLInputElement
    ).classList.toggle("neuroglancer-visible", visibleSegments.has(mapped));
    container.dataset.selected = (
      segmentSelectionState.hasSelectedSegment &&
      segmentSelectionState.selectedSegment === mapped
    ).toString();
    const { selectedSegments } = displayState!.segmentationGroupState.value;
    (stickyChildren[template.starIndex] as HTMLInputElement).classList.toggle(
      "neuroglancer-starred",
      selectedSegments.has(mapped),
    );
    const idContainer = stickyChildren[
      template.idContainerIndex
    ] as HTMLElement;
    setSegmentIdElementStyle(
      idContainer.children[template.idIndex] as HTMLElement,
      getBaseObjectColor(this.displayState, mapped) as vec3,
    );
    const { unmappedIdIndex } = template;
    if (unmappedIdIndex !== -1) {
      let unmappedIdString: string | undefined;
      let color: vec3;
      if (
        displayState!.baseSegmentColoring.value &&
        (unmappedIdString = container.dataset.unmappedId) !== undefined
      ) {
        const unmappedId = BigInt(unmappedIdString);
        color = getBaseObjectColor(this.displayState, unmappedId) as vec3;
      } else {
        color = kOneVec;
      }
      setSegmentIdElementStyle(
        idContainer.children[unmappedIdIndex] as HTMLElement,
        color,
      );
    }
  }
}

function setSegmentIdElementStyle(element: HTMLElement, color: vec3) {
  element.style.backgroundColor = getCssColor(color);
  element.style.color = useWhiteBackground(color) ? "white" : "black";
}

export class SegmentWidgetWithExtraColumnsFactory extends SegmentWidgetFactory<SegmentWidgetWithExtraColumnsTemplate> {
  segmentPropertyMap: PreprocessedSegmentPropertyMap | undefined;
  numericalProperties: InlineSegmentNumericalProperty[];
  numericalPropertyWidths: number[];
  parentElement: HTMLElement;
  constructor(
    displayState: SegmentationDisplayState,
    parentElement: HTMLElement,
    includeProperty: (property: InlineSegmentProperty) => boolean,
  ) {
    const segmentPropertyMap =
      displayState.segmentationGroupState.value.segmentPropertyMap.value;
    const numericalProperties = (
      segmentPropertyMap?.numericalProperties ?? []
    ).filter(includeProperty);
    const template = segmentWidgetTemplateWithExtraColumns(
      numericalProperties.length,
    );
    super(displayState, template);
    this.parentElement = parentElement;
    this.segmentPropertyMap = segmentPropertyMap;
    this.numericalProperties = numericalProperties;
    const numericalPropertyWidths = (this.numericalPropertyWidths = new Array(
      this.numericalProperties.length,
    ));
    numericalPropertyWidths.fill(0);
  }

  getWithNormalizedId(normalizedId: Uint64MapEntry): HTMLDivElement {
    const container = super.getWithNormalizedId(normalizedId);
    const { numericalProperties } = this;
    const { numericalPropertyIndices } = this.template;
    if (numericalPropertyIndices.length > 0) {
      const index =
        this.segmentPropertyMap?.getSegmentInlineIndex(
          normalizedId.value ?? normalizedId.key,
        ) ?? -1;
      if (index !== -1) {
        const { numericalPropertyWidths } = this;
        for (let i = 0, n = numericalPropertyIndices.length; i < n; ++i) {
          const value = numericalProperties[i].values[index];
          if (!Number.isNaN(value)) {
            const s = value.toString();
            const w = s.length;
            if (w > numericalPropertyWidths[i]) {
              numericalPropertyWidths[i] = w;
              this.parentElement.style.setProperty(
                `--neuroglancer-column-${i}-width`,
                `${w}ch`,
              );
            }
            container.children[numericalPropertyIndices[i]].textContent = s;
          }
        }
      }
    }
    return container;
  }

  private makeHeaderLabel(
    id: string,
    widthProperty: string,
    parent: HTMLElement,
  ) {
    const label = document.createElement("span");
    label.textContent = id;
    label.classList.add("neuroglancer-segment-list-header-label");
    label.classList.add("neuroglancer-segment-list-header-label");
    if (id === "label") {
      parent.style.textAlign = "left";
    }
    const sortIcon = document.createElement("span");
    sortIcon.classList.add("neuroglancer-segment-list-header-label-sort");
    label.appendChild(sortIcon);
    sortIcon.textContent = "▲";
    const width = measureElementClone(label).width;
    this.parentElement.style.setProperty(widthProperty, `${width}px`);
    parent.appendChild(label);
    return { id, label, sortIcon };
  }

  getHeader() {
    const { template } = this;
    const container = template.template.cloneNode(
      /*deep=*/ true,
    ) as HTMLDivElement;
    const { children } = container;
    const stickyChildren = children[0].children;
    const copyContainer = stickyChildren[
      template.copyContainerIndex
    ] as HTMLElement;
    copyContainer.style.visibility = "hidden";
    (stickyChildren[template.visibleIndex] as HTMLElement).style.visibility =
      "hidden";
    (children[template.filterIndex] as HTMLElement).style.visibility = "hidden";
    const idContainer = stickyChildren[
      template.idContainerIndex
    ] as HTMLElement;
    const propertyLabels = [
      this.makeHeaderLabel(
        "id",
        "--neuroglancer-id-column-label-width",
        idContainer.children[template.idIndex] as HTMLElement,
      ),
      this.makeHeaderLabel(
        "label",
        "--neuroglancer-label-column-label-width",
        children[template.labelIndex] as HTMLElement,
      ),
    ];
    const { numericalProperties } = this;
    const { numericalPropertyIndices } = this.template;
    for (let i = 0, n = numericalPropertyIndices.length; i < n; ++i) {
      const property = numericalProperties[i];
      const headerLabel = this.makeHeaderLabel(
        property.id,
        `--neuroglancer-column-${i}-label-width`,
        container.children[numericalPropertyIndices[i]] as HTMLElement,
      );
      const { description } = property;
      if (description) {
        headerLabel.label.title = description;
      }
      propertyLabels.push(headerLabel);
    }
    return { container, propertyLabels };
  }
}

export function makeSegmentWidget(
  displayState: SegmentationDisplayState | undefined | null,
  normalizedId: Uint64MapEntry,
) {
  const factory = SegmentWidgetFactory.make(
    displayState ?? undefined,
    /*includeUnmapped=*/ true,
  );
  return factory.getWithNormalizedId(normalizedId);
}

export interface SegmentationDisplayStateWithAlpha
  extends SegmentationDisplayState {
  objectAlpha: TrackableAlphaValue;
}

export interface SegmentationDisplayState3D
  extends SegmentationDisplayStateWithAlpha {
  transform: WatchableRenderLayerTransform;
  renderScaleHistogram: RenderScaleHistogram;
  renderScaleTarget: TrackableValue<number>;
  // Specifies whether to write to the pick buffer when rendering with transparency.  This prevents
  // any object behind the transparent object from being picked.  When not rendering with
  // transparency, the pick buffer is always written (since there is no downside).
  transparentPickEnabled: WatchableValueInterface<boolean>;
}

export function registerCallbackWhenSegmentationDisplayStateChanged(
  displayState: SegmentationDisplayState,
  context: RefCounted,
  callback: () => void,
) {
  context.registerDisposer(
    registerNestedSync((c, groupState) => {
      onVisibleSegmentsStateChanged(c, groupState, callback);
    }, displayState.segmentationGroupState),
  );
  context.registerDisposer(
    registerNestedSync((c, colorGroupState) => {
      c.registerDisposer(
        colorGroupState.segmentColorHash.changed.add(callback),
      );
      c.registerDisposer(
        colorGroupState.segmentDefaultColor.changed.add(callback),
      );
    }, displayState.segmentationColorGroupState),
  );
  context.registerDisposer(displayState.saturation.changed.add(callback));
  context.registerDisposer(
    displayState.segmentSelectionState.changed.add(callback),
  );
  context.registerDisposer(
    displayState.baseSegmentColoring.changed.add(callback),
  );
  context.registerDisposer(displayState.hoverHighlight.changed.add(callback));
}

export function registerRedrawWhenSegmentationDisplayStateChanged(
  displayState: SegmentationDisplayState,
  renderLayer: { redrawNeeded: NullarySignal } & RefCounted,
) {
  const callback = renderLayer.redrawNeeded.dispatch;
  registerCallbackWhenSegmentationDisplayStateChanged(
    displayState,
    renderLayer,
    callback,
  );
  renderLayer.registerDisposer(
    registerNestedSync((c, groupState) => {
      onTemporaryVisibleSegmentsStateChanged(c, groupState, callback);
    }, displayState.segmentationGroupState),
  );
}

export function registerRedrawWhenSegmentationDisplayStateWithAlphaChanged(
  displayState: SegmentationDisplayStateWithAlpha,
  renderLayer: { redrawNeeded: NullarySignal } & RefCounted,
) {
  registerRedrawWhenSegmentationDisplayStateChanged(displayState, renderLayer);
  renderLayer.registerDisposer(
    displayState.objectAlpha.changed.add(renderLayer.redrawNeeded.dispatch),
  );
}

export function registerRedrawWhenSegmentationDisplayState3DChanged(
  displayState: SegmentationDisplayState3D,
  renderLayer: { redrawNeeded: NullarySignal } & RefCounted,
) {
  registerRedrawWhenSegmentationDisplayStateWithAlphaChanged(
    displayState,
    renderLayer,
  );
  renderLayer.registerDisposer(
    displayState.transform.changed.add(renderLayer.redrawNeeded.dispatch),
  );
  renderLayer.registerDisposer(
    displayState.renderScaleTarget.changed.add(
      renderLayer.redrawNeeded.dispatch,
    ),
  );
  renderLayer.registerDisposer(
    displayState.transparentPickEnabled.changed.add(
      renderLayer.redrawNeeded.dispatch,
    ),
  );
}

/**
 * Temporary values used by getObjectColor.
 */
const tempColor = vec4.create();

export function getBaseObjectColor(
  displayState: SegmentationDisplayState | undefined | null,
  objectId: bigint,
  color: Float32Array = tempColor,
) {
  if (displayState == null) {
    color.fill(1);
    return color;
  }
  const colorGroupState = displayState.segmentationColorGroupState.value;
  const { segmentStatedColors } = colorGroupState;
  let statedColor: bigint | undefined;
  if (
    segmentStatedColors.size !== 0 &&
    (statedColor = colorGroupState.segmentStatedColors.get(objectId)) !==
      undefined
  ) {
    // If displayState maps the ID to a color, use it
    color[0] = Number(statedColor & 0x0000ffn) / 255.0;
    color[1] = (Number(statedColor & 0x00ff00n) >>> 8) / 255.0;
    color[2] = (Number(statedColor & 0xff0000n) >>> 16) / 255.0;
    return color;
  }
  const segmentDefaultColor = colorGroupState.segmentDefaultColor.value;
  if (segmentDefaultColor !== undefined) {
    color[0] = segmentDefaultColor[0];
    color[1] = segmentDefaultColor[1];
    color[2] = segmentDefaultColor[2];
    return color;
  }
  colorGroupState.segmentColorHash.compute(color, objectId);
  return color;
}

/**
 * Returns the alpha-premultiplied color to use.
 */
export function getObjectColor(
  displayState: SegmentationDisplayState,
  objectId: bigint,
  alpha = 1,
) {
  const color = tempColor;
  color[3] = alpha;
  getBaseObjectColor(displayState, objectId, color);
  let saturation = displayState.saturation.value;

  // Only apply highlight if segment is visible and hover highlight is enabled
  if (
    displayState.hoverHighlight.value &&
    displayState.segmentSelectionState.isSelected(objectId) &&
    displayState.segmentationGroupState.value.visibleSegments.has(objectId)
  ) {
    if (saturation > 0.5) {
      saturation = saturation -= 0.5;
    } else {
      saturation += 0.5;
    }
  }

  for (let i = 0; i < 3; ++i) {
    color[i] = color[i] * saturation + (1 - saturation);
  }

  color[0] *= alpha;
  color[1] *= alpha;
  color[2] *= alpha;
  return color;
}

export function sendVisibleSegmentsState(
  state: VisibleSegmentsState,
  options: any = {},
) {
  for (const property of VISIBLE_SEGMENTS_STATE_PROPERTIES) {
    options[property] = state[property].rpcId;
  }
  return options;
}

const Base = withSharedVisibility(ChunkRenderLayerFrontend);
export class SegmentationLayerSharedObject extends Base {
  constructor(
    public chunkManager: ChunkManager,
    public displayState: SegmentationDisplayState3D,
    chunkRenderLayer: LayerChunkProgressInfo,
  ) {
    super(chunkRenderLayer);
    const segmentationGroupState = displayState.segmentationGroupState.value;
    // Ensure that these properties remain valid as long as the layer does.
    for (const property of VISIBLE_SEGMENTS_STATE_PROPERTIES) {
      this.registerDisposer(segmentationGroupState[property].addRef());
    }
  }

  initializeCounterpartWithChunkManager(options: any) {
    const { displayState } = this;
    options.chunkManager = this.chunkManager.rpcId;
    sendVisibleSegmentsState(
      displayState.segmentationGroupState.value,
      options,
    );
    options.transform = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(
        this.chunkManager.rpc!,
        this.displayState.transform,
      ),
    ).rpcId;
    options.renderScaleTarget = this.registerDisposer(
      SharedWatchableValue.makeFromExisting(
        this.chunkManager.rpc!,
        this.displayState.renderScaleTarget,
      ),
    ).rpcId;
    super.initializeCounterpart(this.chunkManager.rpc!, options);
  }
}

export function forEachVisibleSegmentToDraw(
  displayState: SegmentationDisplayState3D,
  renderLayer: RenderLayer,
  emitColor: boolean,
  pickIDs: PickIDManager | undefined,
  callback: (
    objectId: bigint,
    color: vec4 | undefined,
    pickIndex: number | undefined,
    rootObjectId: bigint,
  ) => void,
) {
  const alpha = Math.min(1, displayState.objectAlpha.value);
  const baseSegmentColoring = displayState.baseSegmentColoring.value;
  forEachVisibleSegment(
    displayState.segmentationGroupState.value,
    (objectId, rootObjectId) => {
      const pickIndex = pickIDs?.registerUint64(renderLayer, objectId);
      const color = emitColor
        ? getObjectColor(
            displayState,
            baseSegmentColoring ? objectId : rootObjectId,
            alpha,
          )
        : undefined;
      callback(objectId, color, pickIndex, rootObjectId);
    },
  );
}
