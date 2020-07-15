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
          if (this.sizeParent.offsetWidth === 0) {
            // Panel was hidden, don't resize
            return;
          }

          const minimizingEl = this.scrollArea.parentElement!.parentElement!.parentElement!;
          if (minimizingEl.classList.contains('minimized')) {
            // Annotations section is minimized, don't resize
            return;
          }

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
              // size because they were hidden offscreen
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

    if (this.elementYs.length === 0) {
      return;
    }
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

  private findFirstNonDescendant(currentElement: HTMLElement, parent: HTMLElement): HTMLElement
      |undefined {
    // Returns the first element that is not a descendant of parent. This is necessary so that when
    // a new element is added to its parent group, it can go at the "end" of the group (after all
    // existing children of the parent). If there is no such element(i.e. the parent group is at the
    // end of the list), this will return undefined. currentElement is the one being inserted, in
    // case it is being moved and has descendants.

    // will be filled with parent & all its descendants
    const visitedElements = new Set<string>();
    visitedElements.add(currentElement.dataset.id!);
    visitedElements.add(parent.dataset.id!);
    const startIndex = this.elementIndices.get(parent)! + 1;
    for (let i = startIndex; i < this.elementYs.length; i++) {
      const element = this.elementYs[i][0];
      visitedElements.add(element.dataset.id!);
      if (!element.dataset.parent || !visitedElements.has(element.dataset.parent)) {
        // element's parent has not yet been visited
        // try iterating up through the annotation's parent hierarchy, in case they're out of order
        let isInHierarchy = false;
        let elementToCheck = element;
        while (elementToCheck.dataset.parent) {
          if (visitedElements.has(elementToCheck.dataset.parent)) {
            isInHierarchy = true;
            break;
          }
          elementToCheck = this.findElementWithId(elementToCheck.dataset.parent)!;
        }
        if (!isInHierarchy) {
          // element is not a descendant of parent- this is the one we want
          return element;
        }
      }
    }

    return undefined;
  }

  private findElementWithId(id: string): HTMLElement|undefined {
    for (const entry of this.elementYs) {
      const element = entry[0];
      if (element.dataset.id === id) {
        return element;
      }
    }
    return undefined;
  }

  private refreshIndicesAfter(startIndex: number) {
    for (let i = startIndex; i < this.elementYs.length; i++) {
      const el = this.elementYs[i][0];
      this.elementIndices.set(el, i);
    }
  }

  private insertElementBefore(element: HTMLElement, nextElement: HTMLElement) {
    this.scrollArea.insertBefore(element, nextElement);
    const elementHeight = element.offsetHeight;
    const elementIndex = this.elementIndices.get(nextElement)!;
    const elementY = this.elementYs[elementIndex][1];
    this.elementIndices.set(element, elementIndex);
    this.elementYs.splice(elementIndex, 0, [element, elementY]);
    this.shiftYsAfter(elementIndex + 1, elementHeight);
    this.refreshIndicesAfter(elementIndex + 1);
    this.totalHeight += elementHeight;
    this.hideElement(element);
    this.resizeObserver.observe(element);
  }

  insertElement(element: HTMLElement, parent: HTMLElement|undefined) {
    let nextElement = undefined;
    if (parent) {
      nextElement = this.findFirstNonDescendant(element, parent);
    }
    if (nextElement) {
      this.insertElementBefore(element, nextElement);
    } else {
      this.addElementHelper(element);
    }
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
    this.refreshIndicesAfter(elementIndex);

    this.totalHeight -= elementHeight;
    this.scrollArea.removeChild(element);
    this.updateScrollbarHeight();
    this.updateScrollAreaPos();
  }

  replaceElement(newElement: HTMLElement, oldElement: HTMLElement) {
    this.insertElementBefore(newElement, oldElement);
    this.removeElement(oldElement);
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
    this.loadedElements = [];
    // Split up unhide and calculate height to avoid forcing reflow
    for (let i = 0; i < this.elementYs.length; i++) {
      const element = this.elementYs[i][0];
      this.unhideElement(element);
      this.loadedElements.push(element);
    }
    for (let i = 0; i < this.elementYs.length; i++) {
      const elementHeight = this.elementYs[i][0].offsetHeight;
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
