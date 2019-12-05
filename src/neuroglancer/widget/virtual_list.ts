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
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent, updateChildren} from 'neuroglancer/util/dom';
import ResizeObserver from 'resize-observer-polyfill';

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
   * Offset in pixels from the top
   */
  anchorClientOffset: number = 0;

  anchorOffset: number = 0;

  generation = -1;
}

interface ListItemRenderer {
  (index: number): HTMLElement;
}

interface VirtualListSource {
  length: number;
  render: ListItemRenderer;
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

  getEstimatedSize(index: number) {
    const size = this.itemSize[index];
    return size === undefined ? this.totalKnownSize / this.numItemsInTotalKnownSize : size;
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
}

function updateRenderParameters(
    newParams: RenderParameters, prevParams: RenderParameters, numItems: number,
    viewportHeight: number, sizes: SizeEstimates, state: VirtualListState) {
  const {anchorIndex, anchorClientOffset, anchorOffset} = state;

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
    renderAnchorOffset = anchorOffset;
    renderScrollOffset = anchorClientOffset;
  } else {
    const minStartOffset =
        anchorOffset - anchorClientOffset - 2 * overRenderFraction * viewportHeight;
    const maxStartOffset = anchorOffset - anchorClientOffset - overRenderFraction * viewportHeight;
    const minEndOffset =
        anchorOffset - anchorClientOffset + viewportHeight + overRenderFraction * viewportHeight;
    const maxEndOffset = anchorOffset - anchorClientOffset + viewportHeight +
        2 * overRenderFraction * viewportHeight;

    // Update renderStartIndex
    renderStartIndex = prevParams.startIndex;
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
    renderEndIndex = prevParams.endIndex;
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
    renderScrollOffset = anchorOffset - anchorClientOffset;
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
  element = document.createElement('div');
  private spacer = document.createElement('div');
  private topItems = document.createElement('div');
  private bottomItems = document.createElement('div');
  private renderedItems: HTMLElement[] = [];
  private newRenderedItems: HTMLElement[] = [];

  state = new VirtualListState();

  private renderParams = new RenderParameters();
  private newRenderParams = new RenderParameters();

  private sizes = new SizeEstimates();
  private source: VirtualListSource;
  private debouncedUpdateView =
      this.registerCancellable(animationFrameDebounce(() => this.updateView()));
  private resizeObserver = new ResizeObserver(() => this.updateView());

  constructor(options: {source: VirtualListSource, selectedIndex?: number}) {
    super();
    const {selectedIndex} = options;
    if (selectedIndex !== undefined) {
      this.state.anchorIndex = selectedIndex;
      this.state.anchorOffset = 0;
      this.state.anchorClientOffset = 0;
    }
    const source = this.source = options.source;
    this.sizes.itemSize.length = source.length;
    const {element, spacer, topItems, bottomItems} = this;
    this.resizeObserver.observe(element);
    this.registerDisposer(() => this.resizeObserver.disconnect());
    element.appendChild(spacer);
    element.appendChild(topItems);
    topItems.style.position = 'absolute';
    topItems.style.left = '0px';
    topItems.style.right = '0px';
    bottomItems.style.left = '0px';
    bottomItems.style.right = '0px';
    bottomItems.style.position = 'absolute';
    element.appendChild(bottomItems);
    element.addEventListener('scroll', () => {
      const scrollOffset = element.scrollTop;
      this.state.anchorClientOffset = this.renderParams.anchorOffset - scrollOffset;
      this.renderParams.scrollOffset = scrollOffset;
      this.debouncedUpdateView();
    });
  }

  private updateView() {
    const {element} = this;
    if (element.offsetParent === null) {
      // Element not visible.
      return;
    }
    const viewportHeight = element.offsetHeight;

    const {source, state, sizes} = this;
    const numItems = source.length;

    const {spacer, topItems, bottomItems} = this;
    let renderParams: RenderParameters;
    while (true) {
      renderParams = this.newRenderParams;
      const prevRenderParams = this.renderParams;
      updateRenderParameters(
          renderParams, prevRenderParams, numItems, viewportHeight, sizes, state);
      if (!rerenderNeeded(renderParams, prevRenderParams)) {
        prevRenderParams.scrollOffset = renderParams.scrollOffset;
        renderParams = prevRenderParams;
        break;
      }
      this.renderParams = renderParams;
      this.newRenderParams = prevRenderParams;

      const prevRenderedItems = this.renderedItems;
      const renderedItems = this.newRenderedItems;
      this.renderedItems = renderedItems;
      this.newRenderedItems = prevRenderedItems;

      const {render} = this.source;
      const {startIndex: prevStartIndex, endIndex: prevEndIndex} = prevRenderParams;
      const {startIndex: curStartIndex, endIndex: curEndIndex, anchorIndex} = renderParams;
      function* getChildren(start: number, end: number) {
        for (let i = start; i < end; ++i) {
          let item: HTMLElement;
          if (i >= prevStartIndex && i < prevEndIndex) {
            item = prevRenderedItems[i - prevStartIndex];
          } else {
            item = render(i);
          }
          renderedItems[i - curStartIndex] = item;
          yield item;
        }
      }
      updateChildren(topItems, getChildren(curStartIndex, anchorIndex));
      updateChildren(bottomItems, getChildren(anchorIndex, curEndIndex));

      // Update item size estimates.
      for (let i = curStartIndex; i < curEndIndex; ++i) {
        const element = renderedItems[i - curStartIndex];
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
    state.anchorOffset = renderParams.anchorOffset;
    state.anchorClientOffset = renderParams.anchorOffset - renderParams.scrollOffset;
    spacer.style.height = `${sizes.getEstimatedTotalSize()}px`;
    topItems.style.bottom = `calc(100% - ${renderParams.anchorOffset}px)`;
    bottomItems.style.top = `${renderParams.anchorOffset}px`;
    element.scrollTop = renderParams.scrollOffset;
  }

  getItemElement(index: number): HTMLElement|undefined {
    const {renderParams: {startIndex, endIndex}, renderedItems} = this;
    if (index >= startIndex && index < endIndex) {
      return renderedItems[index - startIndex];
    }
    return undefined;
  }

  scrollItemIntoView(index: number) {
    const itemStartOffset = this.sizes.getEstimatedOffset(index);
    const itemEndOffset = itemStartOffset + this.sizes.getEstimatedSize(index);
    const startOffset = this.element.scrollTop;
    if (itemStartOffset < startOffset) {
      this.state.anchorIndex = index;
      this.state.anchorOffset = itemStartOffset;
      this.state.anchorClientOffset = 0;
    } else if (
        itemStartOffset > startOffset && itemEndOffset > startOffset + this.element.offsetHeight) {
      this.state.anchorIndex = index + 1;
      this.state.anchorOffset = itemEndOffset;
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
