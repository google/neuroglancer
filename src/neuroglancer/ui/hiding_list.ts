/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import ResizeObserver from 'resize-observer-polyfill';

export class HidingList {
  private scrollArea: HTMLElement;
  private scrollbar: HTMLElement;
  private scrollbarFiller: HTMLElement;
  private sizeParent: HTMLElement;
  private elementYs: [HTMLElement, number][] = [];          // [element, its Y position] sorted by Y
  private elementIndices = new Map<HTMLElement, number>();  // {element: its index in elementYs}
  private totalHeight = 0;
  private loadedElements: HTMLElement[] = [];
  private resizeObserver: ResizeObserver;

  constructor(
      scrollArea: HTMLElement, scrollbar: HTMLElement, scrollbarFiller: HTMLElement,
      sizeParent: HTMLElement) {
    this.scrollArea = scrollArea;
    this.scrollbar = scrollbar;
    this.scrollbarFiller = scrollbarFiller;
    this.sizeParent = sizeParent;

    this.scrollArea.addEventListener('wheel', function(this: HidingList, event: WheelEvent) {
      this.scrollbar.scrollBy({top: event.deltaY, behavior: 'auto'});
    }.bind(this));

    this.scrollbar.addEventListener('scroll', function(this: HidingList) {
      this.updateScrollAreaPos();
    }.bind(this));

    const parentResizeObserver = new ResizeObserver(this.updateScrollAreaPos.bind(this));
    parentResizeObserver.observe(this.sizeParent);

    this.resizeObserver =
        new ResizeObserver(function(this: HidingList, entries: ResizeObserverEntry[]) {
          for (const entry of entries) {
            // On annotation resize, update all subsequent annotation Ys

            const element = <HTMLElement>entry.target;
            const elementIndex = this.elementIndices.get(element)!;
            const nextY = (elementIndex + 1 === this.elementYs.length) ?
                this.totalHeight :
                this.elementYs[elementIndex + 1][1];
            const oldHeight = nextY - this.elementYs[elementIndex][1];
            const newHeight = element.offsetHeight;
            const delta = newHeight - oldHeight;
            if (delta === 0 ||
                element.classList.contains('neuroglancer-annotation-hiding-list-hiddenitem')) {
              // Don't worry about elements that didn't change vertical size, or changed vertical
              // size because they were hidden
              continue;
            }

            this.shiftYsAfter(elementIndex + 1, delta);

            this.totalHeight += delta;
          }
          this.updateScrollbarHeight();
          this.updateScrollAreaPos();
        }.bind(this));
  }

  private updateScrollAreaPos() {
    for (const e of this.loadedElements) {
      this.hideElement(e);
    }
    this.loadedElements = [];

    const viewportTop = this.scrollbar.scrollTop;
    const firstOnscreenIndex = this.findIndex(viewportTop);
    const lastOnscreenIndex = this.findIndex(viewportTop + this.sizeParent.offsetHeight);
    for (let i = firstOnscreenIndex; i <= lastOnscreenIndex; i++) {
      const element = this.elementYs[i][0];
      this.unhideElement(element);
      this.loadedElements.push(element);
    }
    // Calculate offset so that the first element is partially offscreen, making it look like the
    // list is actually being scrolled
    const startY = this.elementYs[firstOnscreenIndex][1];
    const offset = startY - viewportTop;
    this.scrollArea.style.top = offset + 'px';
    this.scrollArea.style.right = (this.scrollbar.offsetWidth - this.scrollbar.clientWidth) + 'px';
  }

  private addElementHelper(element: HTMLElement) {
    this.scrollArea.appendChild(element);
    const elementHeight = element.offsetHeight;
    this.elementIndices.set(element, this.elementYs.length);
    this.elementYs.push([element, this.totalHeight]);
    this.totalHeight += elementHeight;
    this.hideElement(element);
    this.resizeObserver.observe(element);
  }

  addElements(elements: HTMLElement[]) {
    // Append many at once for better performance, this should be used instead of addElement
    // whenever possible
    for (const element of elements) {
      this.addElementHelper(element);
    }
    this.updateScrollbarHeight();
    this.updateScrollAreaPos();
  }

  addElement(element: HTMLElement) {
    this.addElementHelper(element);
    this.updateScrollbarHeight();
    this.updateScrollAreaPos();
  }

  removeElement(element: HTMLElement) {
    this.resizeObserver.unobserve(element);
    this.unhideElement(element);
    const elementHeight = element.offsetHeight;

    const elementIndex = this.elementIndices.get(element)!;
    this.elementYs.splice(elementIndex, 1);
    this.elementIndices.delete(element);
    this.shiftYsAfter(elementIndex, -elementHeight);
    // Shift indices of elements that came after the removed one
    for (let j = elementIndex; j < this.elementYs.length; j++) {
      const el = this.elementYs[j][0];
      this.elementIndices.set(el, j);
    }

    this.totalHeight -= elementHeight;
    this.scrollArea.removeChild(element);
    this.updateScrollbarHeight();
    this.updateScrollAreaPos();
  }

  removeAll() {
    for (const [element] of this.elementIndices) {
      this.scrollArea.removeChild(element);
    }

    this.elementYs = [];
    this.elementIndices = new Map<HTMLElement, number>();

    this.totalHeight = 0;
    this.loadedElements = [];
  }

  scrollTo(element: HTMLElement) {
    const elementY = this.elementYs[this.elementIndices.get(element)!][1];
    // Scrolls just a pixel too far, this makes it look prettier
    this.scrollbar.scrollTop = elementY - 1;
    this.updateScrollAreaPos();
  }

  recalculateHeights() {
    this.totalHeight = 0;
    this.scrollbar.scrollTop = 0;
    for (const [element, i] of this.elementIndices) {
      this.unhideElement(element);
      const elementHeight = element.offsetHeight;
      this.elementYs[i][1] = this.totalHeight;
      this.totalHeight += elementHeight;
    }
    this.updateScrollbarHeight();
    this.updateScrollAreaPos();
  }

  private hideElement(element: HTMLElement) {
    element.classList.add('neuroglancer-annotation-hiding-list-hiddenitem');
  }

  private unhideElement(element: HTMLElement) {
    element.classList.remove('neuroglancer-annotation-hiding-list-hiddenitem');
  }

  private updateScrollbarHeight() {
    // Add some extra padding on the bottom
    this.scrollbarFiller.style.height = (this.totalHeight + 10) + 'px';
  }

  private shiftYsAfter(startIndex: number, delta: number) {
    for (let i = startIndex; i < this.elementYs.length; i++) {
      this.elementYs[i][1] += delta;
    }
  }

  private findIndex(targetY: number) {
    // This is used for getting the first/last element to show on screen.
    // When the scrollbar is at position h, the first element we want to show is the one with the
    // closest Y position that is equal to or less than h. Since elementYs is sorted by Y position,
    // we use a binary search to find this, modified so that instead of failing upon not finding h,
    // it returns the next lower index.
    let left = 0;
    let right = this.elementYs.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const val = this.elementYs[mid][1];
      if (val < targetY) {
        left = mid + 1;
      } else if (val > targetY) {
        right = mid - 1;
      } else {
        return mid;
      }
    }
    return right;  // right < left in this case, so right is the next lower index
  }
}
