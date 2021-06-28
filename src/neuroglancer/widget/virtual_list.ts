/**
 * @license
 * Copyright 2019 Google Inc.
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

import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {ArraySpliceOp, spliceArray} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent, updateChildren} from 'neuroglancer/util/dom';
import {Signal} from 'neuroglancer/util/signal';

// Must be a multiple of 2.
const defaultNumItemsToRender = 10;
const overRenderFraction = 0.5;

export class VirtualListState {
  /**
   * Index of list element that serves as an anchor for positioning the rendered elements relative
   * to the scroll container.
   */
  anchorIndex: number = 0;

  /**
   * Offset of start of anchor item in pixels from the top of the visible content.  May be negative
   * to indicate that the anchor item starts before the visible viewport.
   */
  anchorClientOffset: number = 0;

  splice(splices: readonly Readonly<ArraySpliceOp>[]) {
    let {anchorIndex} = this;
    let offset = 0;
    for (const splice of splices) {
      offset += splice.retainCount;
      if (anchorIndex < offset) break;
      const {deleteCount} = splice;
      if (anchorIndex < offset + deleteCount) {
        anchorIndex = offset;
        break;
      }
      const {insertCount} = splice;
      anchorIndex = anchorIndex - deleteCount + insertCount;
      offset += insertCount - insertCount;
    }
    this.anchorIndex = anchorIndex;
  }
}

export interface VirtualListSource {
  length: number;
  render(index: number): HTMLElement;
  changed?: Signal<(splices: ArraySpliceOp[]) => void>|undefined;
  renderChanged?: Signal|undefined;
}

class RenderParameters {
  startIndex: number = 0;
  endIndex: number = 0;
  anchorIndex: number = 0;
  anchorOffset: number = 0;
  scrollOffset: number = 0;
}

class SizeEstimates {
  /**
   * If height of item `i` has already been determined, it is set in `itemSize[i]`.  Otherwise,
   * `itemSize[i]` is `undefined`.
   */
  itemSize: number[] = [];

  /**
   * Sum of non-`undefined` values in `itemSize`.
   */
  totalKnownSize: number = 0;

  /**
   * Number of non-`undefined` values in `itemSize`.
   */
  numItemsInTotalKnownSize: number = 0;

  get averageSize() {
    return this.totalKnownSize / this.numItemsInTotalKnownSize;
  }

  getEstimatedSize(index: number) {
    return this.itemSize[index] ??this.averageSize;
  }

  getEstimatedTotalSize() {
    return this.totalKnownSize / this.numItemsInTotalKnownSize * this.itemSize.length;
  }

  getEstimatedOffset(index: number, hintIndex: number = 0, hintOffset = 0) {
    for (; hintIndex < index; ++hintIndex) {
      hintOffset += this.getEstimatedSize(hintIndex);
    }
    for (; hintIndex > index; --hintIndex) {
      hintOffset -= this.getEstimatedSize(hintIndex - 1);
    }
    return hintOffset;
  }

  getRangeSize(begin: number, end: number) {
    let size = 0;
    const {itemSize, averageSize} = this;
    for (let i = begin; i < end; ++i) {
      size += itemSize[i] ?? averageSize;
    }
    return size;
  }

  splice(splices: readonly Readonly<ArraySpliceOp>[]) {
    let {itemSize} = this;
    itemSize = this.itemSize = spliceArray(itemSize, splices);
    this.totalKnownSize = itemSize.reduce((a, b) => a + b, 0);
    this.numItemsInTotalKnownSize = itemSize.reduce(a => a + 1, 0);
  }
}

function updateRenderParameters(
    newParams: RenderParameters, prevParams: RenderParameters, numItems: number,
    viewportHeight: number, sizes: SizeEstimates, state: VirtualListState) {
  let {anchorIndex, anchorClientOffset} = state;
  let anchorOffset = sizes.getEstimatedOffset(anchorIndex);

  let renderStartIndex: number;
  let renderEndIndex: number;
  let renderAnchorOffset: number;
  let renderScrollOffset: number;
  let renderAnchorIndex: number;

  if (viewportHeight === 0 || sizes.totalKnownSize === 0) {
    // Guess
    renderStartIndex = Math.max(0, anchorIndex - defaultNumItemsToRender / 2);
    renderEndIndex = Math.min(numItems, renderStartIndex + defaultNumItemsToRender);
    renderAnchorIndex = anchorIndex;
    renderAnchorOffset = 0;
    renderScrollOffset = anchorClientOffset;
  } else {
    const totalSize = sizes.getEstimatedTotalSize();
    const maxScrollOffset = Math.max(0, totalSize - viewportHeight);

    // Restrict anchorOffset and anchorClientOffset to be valid.
    renderScrollOffset = anchorOffset - anchorClientOffset;
    renderScrollOffset = Math.max(0, Math.min(maxScrollOffset, renderScrollOffset));

    const minStartOffset = renderScrollOffset - 2 * overRenderFraction * viewportHeight;
    const maxStartOffset = renderScrollOffset - overRenderFraction * viewportHeight;
    const minEndOffset = renderScrollOffset + viewportHeight + overRenderFraction * viewportHeight;
    const maxEndOffset = anchorOffset - anchorClientOffset + viewportHeight +
        2 * overRenderFraction * viewportHeight;

    // Update renderStartIndex
    renderStartIndex = Math.min(numItems, prevParams.startIndex);
    let renderStartOffset = sizes.getEstimatedOffset(renderStartIndex, anchorIndex, anchorOffset);
    if (renderStartOffset < minStartOffset) {
      for (; renderStartIndex + 1 < numItems; ++renderStartIndex) {
        const itemSize = sizes.getEstimatedSize(renderStartIndex);
        if (renderStartOffset + itemSize >= maxStartOffset) break;
        renderStartOffset += itemSize;
      }
    }
    if (renderStartOffset >= maxStartOffset) {
      for (; renderStartOffset > minStartOffset && renderStartIndex > 0; --renderStartIndex) {
        const itemSize = sizes.getEstimatedSize(renderStartIndex - 1);
        renderStartOffset -= itemSize;
      }
    }

    // Update renderEndIndex
    renderEndIndex = Math.min(numItems, prevParams.endIndex);
    let renderEndOffset = sizes.getEstimatedOffset(renderEndIndex, anchorIndex, anchorOffset);
    if (renderEndOffset < minEndOffset) {
      for (; renderEndOffset <= maxEndOffset && renderEndIndex + 1 <= numItems; ++renderEndIndex) {
        const itemSize = sizes.getEstimatedSize(renderEndIndex);
        renderEndOffset += itemSize;
      }
    } else if (renderEndOffset >= maxEndOffset) {
      for (; renderEndIndex > renderStartIndex; --renderEndIndex) {
        const itemSize = sizes.getEstimatedSize(renderEndIndex - 1);
        if (renderEndOffset - itemSize < minEndOffset) break;
        renderEndOffset -= itemSize;
      }
    }

    // Update renderAnchorIndex and renderAnchorPixel
    renderAnchorIndex = anchorIndex;
    renderAnchorOffset = anchorOffset;
    for (; renderAnchorIndex < renderStartIndex; ++renderAnchorIndex) {
      const itemSize = sizes.getEstimatedSize(renderAnchorIndex);
      renderAnchorOffset += itemSize;
    }
    for (; renderAnchorIndex > renderEndIndex; --renderAnchorIndex) {
      const itemSize = sizes.getEstimatedSize(renderAnchorIndex - 1);
      renderAnchorOffset -= itemSize;
    }
  }
  newParams.startIndex = renderStartIndex;
  newParams.endIndex = renderEndIndex;
  newParams.anchorIndex = renderAnchorIndex;
  newParams.anchorOffset = renderAnchorOffset;
  newParams.scrollOffset = renderScrollOffset;
}

function normalizeRenderParams(p: RenderParameters, sizes: SizeEstimates) {
  const anchorOffset = sizes.getEstimatedOffset(p.anchorIndex);
  const oldAnchorOffset = p.anchorOffset;
  p.anchorOffset = anchorOffset;
  p.scrollOffset += (anchorOffset - oldAnchorOffset);
}

function rerenderNeeded(newParams: RenderParameters, prevParams: RenderParameters) {
  return newParams.startIndex < prevParams.startIndex || newParams.endIndex > prevParams.endIndex;
}

export class VirtualList extends RefCounted {
  // Outer scrollable element
  element = document.createElement('div');
  // Inner element (not scrollable) that contains `header` and `body`.
  scrollContent = document.createElement('div');
  header = document.createElement('div');
  // Contains `topItems` and `bottomItems` as children.
  body = document.createElement('div');
  private topItems = document.createElement('div');
  private bottomItems = document.createElement('div');
  private renderedItems: HTMLElement[] = [];
  private renderGeneration = -1;
  private listGeneration = -1;
  private newRenderedItems: HTMLElement[] = [];

  state = new VirtualListState();

  private renderParams = new RenderParameters();
  private newRenderParams = new RenderParameters();

  private sizes = new SizeEstimates();
  private source: VirtualListSource;
  private debouncedUpdateView =
      this.registerCancellable(animationFrameDebounce(() => this.updateView()));
  private resizeObserver = new ResizeObserver(() => this.updateView());

  constructor(options: {source: VirtualListSource, selectedIndex?: number, horizontalScroll?: boolean}) {
    super();
    const {selectedIndex} = options;
    if (selectedIndex !== undefined) {
      this.state.anchorIndex = selectedIndex;
      this.state.anchorClientOffset = 0;
    }
    const source = this.source = options.source;
    this.sizes.itemSize.length = source.length;
    const {element, header, body, scrollContent, topItems, bottomItems} = this;
    this.resizeObserver.observe(element);
    this.registerDisposer(() => this.resizeObserver.disconnect());
    element.appendChild(scrollContent);
    // The default scroll anchoring behavior of browsers interacts poorly with this virtual list
    // mechanism and is unnecessary.
    element.style.overflowAnchor = 'none';
    scrollContent.appendChild(header);
    scrollContent.appendChild(body);
    header.style.position = 'sticky';
    header.style.zIndex = '1';
    header.style.top = '0';
    if (options.horizontalScroll) {
      scrollContent.style.width = 'min-content';
      scrollContent.style.minWidth = '100%';
      header.style.width = 'min-content';
      header.style.minWidth = '100%';
      bottomItems.style.width = 'min-content';
      bottomItems.style.minWidth = '100%';
    } else {
      scrollContent.style.width = '100%';
      header.style.width = '100%';
      bottomItems.style.width = '100%';
    }
    body.appendChild(topItems);
    body.appendChild(bottomItems);
    topItems.style.width = 'min-content';
    topItems.style.position = 'relative';
    topItems.style.height = '0';
    topItems.style.minWidth = '100%';
    bottomItems.style.height = '0';
    bottomItems.style.position = 'relative';
    element.addEventListener('scroll', () => {
      const scrollOffset = element.scrollTop;
      this.state.anchorClientOffset = this.renderParams.anchorOffset - scrollOffset;
      this.renderParams.scrollOffset = scrollOffset;
      this.debouncedUpdateView();
    });
    if (source.changed !== undefined) {
      this.registerDisposer(source.changed.add(splices => {
        this.sizes.splice(splices);
        this.state.splice(splices);
        this.renderedItems.length = 0;
        this.debouncedUpdateView();
      }));
    }
    if (source.renderChanged !== undefined) {
      this.registerDisposer(source.renderChanged.add(this.debouncedUpdateView));
    }
  }

  private updateView() {
    const {element} = this;
    if (element.offsetHeight === 0) {
      // Element not visible
      return;
    }
    const viewportHeight = element.clientHeight - this.header.offsetHeight;

    const {source, state, sizes} = this;
    const numItems = source.length;

    const {body, topItems, bottomItems} = this;
    const {changed, renderChanged} = source;
    let renderParams: RenderParameters;
    while (true) {
      renderParams = this.newRenderParams;
      const prevRenderParams = this.renderParams;
      updateRenderParameters(
          renderParams, prevRenderParams, numItems, viewportHeight, sizes, state);
      let forceRender: boolean;
      if ((renderChanged !== undefined && renderChanged.count !== this.renderGeneration) ||
          (changed !== undefined && changed.count !== this.listGeneration)) {
        this.renderGeneration = renderChanged === undefined ? -1 : renderChanged.count;
        this.listGeneration = changed === undefined ? -1 : changed.count;
        forceRender = true;
        this.renderedItems.length = 0;
      } else {
        forceRender = false;
      }
      if (!forceRender && !rerenderNeeded(renderParams, prevRenderParams)) {
        prevRenderParams.scrollOffset = renderParams.scrollOffset;
        renderParams = prevRenderParams;
        break;
      }
      this.renderParams = renderParams;
      this.newRenderParams = prevRenderParams;

      const prevRenderedItems = this.renderedItems;
      const renderedItems = this.newRenderedItems;
      renderedItems.length = 0;
      this.renderedItems = renderedItems;
      this.newRenderedItems = prevRenderedItems;

      const {source} = this;
      const {render} = source;
      const {startIndex: curStartIndex, endIndex: curEndIndex, anchorIndex} = renderParams;
      function* getChildren(start: number, end: number) {
        for (let i = start; i < end; ++i) {
          let item = prevRenderedItems[i];
          if (item === undefined) {
            item = render.call(source, i);
          }
          renderedItems[i] = item;
          yield item;
        }
      }
      updateChildren(topItems, getChildren(curStartIndex, anchorIndex));
      updateChildren(bottomItems, getChildren(anchorIndex, curEndIndex));

      // Update item size estimates.
      for (let i = curStartIndex; i < curEndIndex; ++i) {
        const element = renderedItems[i];
        const bounds = element.getBoundingClientRect();
        const newSize = bounds.height;
        const existingSize = sizes.itemSize[i];
        if (existingSize !== undefined) {
          sizes.totalKnownSize -= existingSize;
          --sizes.numItemsInTotalKnownSize;
        }
        sizes.itemSize[i] = newSize;
        sizes.totalKnownSize += newSize;
        ++sizes.numItemsInTotalKnownSize;
      }
    }
    normalizeRenderParams(renderParams, sizes);
    state.anchorIndex = renderParams.anchorIndex;
    state.anchorClientOffset = renderParams.anchorOffset - renderParams.scrollOffset;
    const topSize = sizes.getRangeSize(renderParams.startIndex, renderParams.anchorIndex);
    const totalHeight = sizes.getEstimatedTotalSize();
    body.style.height = `${totalHeight}px`;
    topItems.style.top = `${renderParams.anchorOffset - topSize}px`;
    bottomItems.style.top = `${renderParams.anchorOffset}px`;
    element.scrollTop = renderParams.scrollOffset;
  }

  getItemElement(index: number): HTMLElement|undefined {
    return this.renderedItems[index];
  }

  forEachRenderedItem(callback: (element: HTMLElement, index: number) => void) {
    const {startIndex, endIndex} = this.renderParams;
    const {renderedItems} = this;
    for (let i = startIndex; i < endIndex; ++i) {
      const item = renderedItems[i];
      if (item === undefined) continue;
      callback(item, i);
    }
  }

  scrollToTop() {
    this.state.anchorIndex = 0;
    this.state.anchorClientOffset = 0;
    this.debouncedUpdateView();
  }

  scrollItemIntoView(index: number) {
    const itemStartOffset = this.sizes.getEstimatedOffset(index);
    const itemEndOffset = itemStartOffset + this.sizes.getEstimatedSize(index);
    const startOffset = this.element.scrollTop;
    if (itemStartOffset < startOffset) {
      this.state.anchorIndex = index;
      this.state.anchorClientOffset = 0;
    } else if (
        itemStartOffset > startOffset && itemEndOffset > startOffset + this.element.offsetHeight) {
      this.state.anchorIndex = index + 1;
      this.state.anchorClientOffset = this.element.offsetHeight;
    } else {
      return;
    }
    this.debouncedUpdateView();
  }

  disposed() {
    removeFromParent(this.element);
  }
}
