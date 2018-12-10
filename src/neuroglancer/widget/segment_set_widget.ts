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

require('neuroglancer/noselect.css');
require('./segment_set_widget.css');

type ItemElement = HTMLDivElement;

const temp = new Uint64();

export class SegmentSetWidget extends RefCounted {
  element = document.createElement('div');
  private clearButton = document.createElement('button');
  private itemContainer = document.createElement('div');
  private enabledItems = new Map<string, ItemElement>();
  private disabledItems = new Map<string, ItemElement>();

  // A segment ID will only be a key in either the enabledItems
  // or the disableItems map, in which case it is displayed or
  // hidden in neuroglancer respectively (but in either case it
  // appears in the widget). If a segment ID is in neither map
  // it is neither in the widget nor displayed on neuroglancer.

  get rootSegments() {
    return this.displayState.rootSegments;
  }
  get hiddenRootSegments() {
    return this.displayState.hiddenRootSegments;
  }
  get segmentColorHash() {
    return this.displayState.segmentColorHash;
  }
  get segmentSelectionState() {
    return this.displayState.segmentSelectionState;
  }

  constructor(public displayState: SegmentationDisplayState) {
    super();
    const {element, clearButton, itemContainer} = this;
    element.className = 'segment-set-widget neuroglancer-noselect';
    clearButton.className = 'clear-button';
    clearButton.title = 'Remove all segment IDs';
    this.registerEventListener(clearButton, 'click', () => {
      this.rootSegments.clear();
      this.hiddenRootSegments!.clear();
    });

    itemContainer.className = 'item-container';
    element.appendChild(itemContainer);

    itemContainer.appendChild(clearButton);

    this.registerDisposer(displayState.rootSegments.changed.add((x, add) => {
      this.handleEnabledSetChanged(x, add);
    }));
    this.registerDisposer(displayState.hiddenRootSegments!.changed.add((x, add) => {
      this.handleDisabledSetChanged(x, add);
    }));
    this.registerDisposer(displayState.segmentColorHash.changed.add(() => {
      this.handleColorChanged();
    }));

    for (let x of displayState.rootSegments) {
      this.addElement(x.toString());
    }
    this.updateClearButtonVisibility();
  }

  private anyRootSegments =
      () => {
        return this.displayState.rootSegments.size > 0;
      }

  private anyHiddenRootSegments =
      () => {
        return this.displayState.hiddenRootSegments!.size > 0;
      }

  private updateClearButtonVisibility() {
    const {clearButton} = this;
    clearButton.style.display =
        (this.anyRootSegments() || this.anyHiddenRootSegments()) ? '' : 'none';
  }

  private clearItems() {
    const {itemContainer, clearButton, enabledItems, disabledItems} = this;
    while (true) {
      const lastElement = itemContainer.lastElementChild!;
      if (lastElement === clearButton) {
        break;
      }
      itemContainer.removeChild(lastElement);
    }
    enabledItems.clear();
    disabledItems.clear();
  }

  private handleEnabledSetChanged(x: Uint64|Uint64[]|null, added: boolean) {
    this.updateClearButtonVisibility();
    const {enabledItems, disabledItems, hiddenRootSegments, anyHiddenRootSegments} = this;
    if (x === null) {
      if (!anyHiddenRootSegments()) {
        // Cleared.
        this.clearItems();
      }
    } else if (added) {
      for (const segmentID of Array<Uint64>().concat(x)) {
        const segmentIDString = segmentID.toString();
        const disabledItem = disabledItems.get(segmentIDString);
        // Make sure item not already added
        if (!disabledItem) {
          this.addElement(segmentIDString);
        } else {
          // Preparing to enable or disable an element
          enabledItems.set(segmentIDString, disabledItem);
          hiddenRootSegments!.delete(x);
          this.setItemsToggleButtonToHideSegment(disabledItem, segmentIDString);
        }
      }
    } else {
      for (const segmentID of Array<Uint64>().concat(x)) {
        const segmentIDString = segmentID.toString();
        // Make sure item has been deleted, instead of disabled
        if (!disabledItems.get(segmentIDString)) {
          let itemElement = enabledItems.get(segmentIDString)!;
          itemElement.parentElement!.removeChild(itemElement);
        }
        enabledItems.delete(segmentIDString);
      }
    }
  }

  private handleDisabledSetChanged(x: Uint64|Uint64[]|null, added: boolean) {
    this.updateClearButtonVisibility();
    const {enabledItems, disabledItems, rootSegments, anyRootSegments} = this;
    if (x === null) {
      if (!anyRootSegments()) {
        // Cleared.
        this.clearItems();
      }
    } else if (added) {
      for (const segmentID of Array<Uint64>().concat(x)) {
        const segmentIDString = segmentID.toString();
        const enabledItem = enabledItems.get(segmentIDString);
        if (!enabledItem) {
          // Should never happen
          throw new Error(
              'Erroneous attempt to hide a segment ID that does not exist in the widget');
        } else {
          // Preparing to enable or disable an element
          disabledItems.set(segmentIDString, enabledItem);
          rootSegments.delete(x);
          this.setItemsToggleButtonToShowSegment(enabledItem, segmentIDString);
        }
      }
    } else {
      for (const segmentID of Array<Uint64>().concat(x)) {
        const segmentIDString = segmentID.toString();
        // Make sure item has been deleted, instead of enabled
        if (!enabledItems.get(segmentIDString)) {
          let itemElement = disabledItems.get(segmentIDString)!;
          itemElement.parentElement!.removeChild(itemElement);
        }
        disabledItems.delete(segmentIDString);
      }
    }
  }

  private addElement(segmentIDString: string) {
    // Wrap buttons in div so node button and its hide button appear on same line
    const itemElement = document.createElement('div');
    itemElement.className = 'segment-div';
    const itemButton = document.createElement('button');
    itemButton.className = 'segment-button';
    itemButton.textContent = segmentIDString;
    itemButton.title = `Remove segment ID ${segmentIDString}`;
    const widget = this;
    itemButton.addEventListener('click', function(this: HTMLButtonElement) {
      temp.tryParseString(this.textContent!);
      widget.rootSegments.delete(temp);
      widget.hiddenRootSegments!.delete(temp);
    });
    itemButton.addEventListener('mouseenter', function(this: HTMLButtonElement) {
      temp.tryParseString(this.textContent!);
      widget.segmentSelectionState.set(temp);
    });
    itemButton.addEventListener('mouseleave', function(this: HTMLButtonElement) {
      temp.tryParseString(this.textContent!);
      widget.segmentSelectionState.set(null);
    });
    const itemToggleButton = document.createElement('button');
    itemToggleButton.className = 'segment-toggle-button';
    widget.setToggleButtonToHideSegment(itemToggleButton, segmentIDString);
    itemToggleButton.addEventListener('click', function(this: HTMLButtonElement) {
      temp.tryParseString(segmentIDString);
      if (widget.enabledItems.get(segmentIDString)) {
        // Add to hiddenRootSegments. handleSetChanged will delete segment from rootSegments
        widget.hiddenRootSegments!.add(temp);
      } else {
        // Add to rootSegments. handleSetChanged will delete segment from hiddenRootSegments
        widget.rootSegments.add(temp);
      }
    });
    // Button for the user to copy a segment's ID
    const itemCopyIDButton = document.createElement('button');
    itemCopyIDButton.className = 'segment-copy-button';
    itemCopyIDButton.title = `Copy segment ID ${segmentIDString}`;
    itemCopyIDButton.textContent = '\u2702';
    itemCopyIDButton.addEventListener('click', function(this: HTMLButtonElement) {
      const handleCopy = (e: ClipboardEvent) => {
        e.clipboardData.setData('text/plain', segmentIDString);
        e.preventDefault();
        document.removeEventListener('copy', handleCopy);
        this.style.backgroundColor = 'rgb(0, 255, 0)';
        setTimeout(() => {
          if (this.style.backgroundColor === 'rgb(0, 255, 0)') {
            this.style.backgroundColor = 'rgb(240, 240, 240)';
          }
        }, 300);
      };
      document.addEventListener('copy', handleCopy);
      document.execCommand('copy');
    });
    itemElement.appendChild(itemButton);
    itemElement.appendChild(itemToggleButton);
    itemElement.appendChild(itemCopyIDButton);
    this.setItemButtonColor(itemElement);
    this.itemContainer.appendChild(itemElement);
    this.enabledItems.set(segmentIDString, itemElement);
  }

  private setItemButtonColor(itemElement: ItemElement) {
    const itemButton = <HTMLElement>(itemElement.getElementsByClassName('segment-button')[0]);
    temp.tryParseString(itemButton.textContent!);
    itemButton.style.backgroundColor = this.segmentColorHash.computeCssColor(temp);
  }

  private handleColorChanged() {
    this.enabledItems.forEach(itemElement => {
      this.setItemButtonColor(itemElement);
    });
  }

  private setItemsToggleButtonToHideSegment(itemElement: ItemElement, segmentIDString: string) {
    const itemToggleButton =
        <HTMLButtonElement>(itemElement.getElementsByClassName('segment-toggle-button')[0]);
    this.setToggleButtonToHideSegment(itemToggleButton, segmentIDString);
  }

  private setToggleButtonToHideSegment(
      itemToggleButton: HTMLButtonElement, segmentIDString: string) {
    itemToggleButton.textContent = 'Hide';
    itemToggleButton.title = `Hide segment ID ${segmentIDString}`;
    itemToggleButton.style.borderStyle = 'outset';
    itemToggleButton.style.backgroundColor = 'rgb(240, 240, 240)';
  }

  private setItemsToggleButtonToShowSegment(itemElement: ItemElement, segmentIDString: string) {
    const itemToggleButton =
        <HTMLButtonElement>(itemElement.getElementsByClassName('segment-toggle-button')[0]);
    this.setToggleButtonToShowSegment(itemToggleButton, segmentIDString);
  }

  private setToggleButtonToShowSegment(
      itemToggleButton: HTMLButtonElement, segmentIDString: string) {
    itemToggleButton.textContent = 'Show';
    itemToggleButton.title = `Show segment ID ${segmentIDString}`;
    itemToggleButton.style.borderStyle = 'inset';
    itemToggleButton.style.backgroundColor = 'rgb(210, 210, 210)';
  }

  disposed() {
    const {element} = this;
    const {parentElement} = element;
    if (parentElement) {
      parentElement.removeChild(element);
    }
    super.disposed();
  }
}
