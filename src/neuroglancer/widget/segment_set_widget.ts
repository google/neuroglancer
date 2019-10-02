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

import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';

import 'neuroglancer/noselect.css';
import './segment_set_widget.css';

type ItemElement = HTMLButtonElement;

let temp = new Uint64();

export class SegmentSetWidget extends RefCounted {
  element = document.createElement('div');
  private clearButton = document.createElement('button');
  private itemContainer = document.createElement('span');
  private items = new Map<string, ItemElement>();

  get visibleSegments() {
    return this.displayState.visibleSegments;
  }
  get segmentColorHash() {
    return this.displayState.segmentColorHash;
  }
  get segmentSelectionState() {
    return this.displayState.segmentSelectionState;
  }

  constructor(public displayState: SegmentationDisplayState) {
    super();
    let {element, clearButton, itemContainer} = this;
    element.className = 'segment-set-widget neuroglancer-noselect';
    clearButton.className = 'clear-button';
    clearButton.title = 'Remove all segment IDs';
    this.registerEventListener(clearButton, 'click', () => {
      this.visibleSegments.clear();
    });

    itemContainer.className = 'item-container';
    element.appendChild(itemContainer);

    itemContainer.appendChild(clearButton);

    this.registerDisposer(displayState.visibleSegments.changed.add((x, add) => {
      this.handleSetChanged(x, add);
    }));
    this.registerDisposer(displayState.segmentColorHash.changed.add(() => {
      this.handleColorChanged();
    }));

    for (let x of displayState.visibleSegments) {
      this.addElement(x.toString());
    }
    this.updateClearButtonVisibility();
  }

  private updateClearButtonVisibility() {
    let {clearButton} = this;
    clearButton.style.display = (this.displayState.visibleSegments.size > 0) ? '' : 'none';
  }

  private handleSetChanged(x: Uint64|null, added: boolean) {
    this.updateClearButtonVisibility();
    let {items} = this;
    if (x === null) {
      // Cleared.
      let {itemContainer, clearButton} = this;
      while (true) {
        let lastElement = itemContainer.lastElementChild!;
        if (lastElement === clearButton) {
          break;
        }
        itemContainer.removeChild(lastElement);
      }
      items.clear();
    } else if (added) {
      this.addElement(x.toString());
    } else {
      let s = x.toString();
      let itemElement = items.get(s)!;
      itemElement.parentElement!.removeChild(itemElement);
      items.delete(s);
    }
  }

  private addElement(s: string) {
    let itemElement = document.createElement('button');
    itemElement.className = 'segment-button';
    itemElement.textContent = s;
    itemElement.title = `Remove segment ID ${s}`;
    let widget = this;
    itemElement.addEventListener('click', function(this: ItemElement) {
      temp.tryParseString(this.textContent!);
      widget.visibleSegments.delete(temp);
    });
    itemElement.addEventListener('mouseenter', function(this: ItemElement) {
      temp.tryParseString(this.textContent!);
      widget.segmentSelectionState.set(temp);
    });
    itemElement.addEventListener('mouseleave', function(this: ItemElement) {
      temp.tryParseString(this.textContent!);
      widget.segmentSelectionState.set(null);
    });
    this.setItemColor(itemElement);
    this.itemContainer.appendChild(itemElement);
    this.items.set(s, itemElement);
  }

  private setItemColor(itemElement: ItemElement) {
    temp.tryParseString(itemElement.textContent!);
    itemElement.style.backgroundColor = this.segmentColorHash.computeCssColor(temp);
  }

  private handleColorChanged() {
    this.items.forEach(itemElement => {
      this.setItemColor(itemElement);
    });
  }

  disposed() {
    let {element} = this;
    let {parentElement} = element;
    if (parentElement) {
      parentElement.removeChild(element);
    }
    super.disposed();
  }
}
