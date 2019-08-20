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
import {vec3} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';

require('neuroglancer/noselect.css');
require('./segment_set_widget.css');

const copyIcon = require('neuroglancer/../../assets/icons/copySegment.svg');

type ItemElement = HTMLDivElement;

const temp = new Uint64();

export class SegmentSetWidget extends RefCounted {
  element = document.createElement('div');
  private topButtons = document.createElement('div');
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
    this.createTopButtons();
    this.registerDisposer(displayState.rootSegments.changed.add((x, add) => {
      this.handleEnabledSetChanged(x, add);
    }));
    this.registerDisposer(displayState.hiddenRootSegments!.changed.add((x, add) => {
      this.handleDisabledSetChanged(x, add);
    }));
    this.registerDisposer(displayState.segmentColorHash.changed.add(() => {
      this.handleColorChanged();
    }));
    this.registerDisposer(displayState.segmentSelectionState.changed.add(() => {
      const segmentID = this.segmentSelectionState.selectedSegment.toString();
      const segmentButton = <HTMLElement>this.element.querySelector(`[data-seg-id="${segmentID}"]`);
      const existingHighlight = Array.from(this.element.getElementsByClassName('selectedSeg'))
                                    .filter((e) => e !== segmentButton);
      const white = vec3.fromValues(255, 255, 255);
      const saturation = 0.5;
      let rgbArray = [0, 0, 0];

      if (segmentButton) {
        const segBtnClass = segmentButton.classList;
        if (!segBtnClass.contains('selectedSeg')) {
          segBtnClass.add('selectedSeg');
          let base = segmentButton.style.backgroundColor || '';
          rgbArray = base.replace(/[^\d,.%]/g, '').split(',').map(v => parseFloat(v));
          let highlight = vec3.lerp(vec3.fromValues(0, 0, 0), white, rgbArray, saturation);
          let highFrame = `rgb(${highlight.join(',')})`;

          segmentButton.style.setProperty('--defBtnColor', base);
          segmentButton.style.setProperty('--actBtnColor', highFrame);
          segmentButton.style.setProperty('--pulseSpeed', '0.5s');
        }
      }
      if (existingHighlight) {
        existingHighlight.map(e => e.classList.remove('selectedSeg'));
      }
    }));

    for (const x of displayState.rootSegments) {
      this.addElement(x.toString(), true);
    }

    for (const x of displayState.hiddenRootSegments!) {
      this.addElement(x.toString(), false);
    }
    this.updateTopButtonsVisibility();
  }

  // Create 3 buttons: clear all segments, copy all segment IDs, copy all displayed segment IDs.
  // These "top buttons" are only displayed when there are any selected segments.
  private createTopButtons() {
    const {element, topButtons, itemContainer} = this;
    element.className = 'segment-set-widget neuroglancer-noselect';
    topButtons.className = 'top-buttons';
    topButtons.appendChild(this.createClearButton());
    topButtons.appendChild(this.createCopyAllSegmentIDsButton());
    topButtons.appendChild(this.createCopyVisibleSegmentIDsButton());
    topButtons.appendChild(this.createToggleItemsCheckbox());
    itemContainer.className = 'item-container';
    element.appendChild(itemContainer);

    itemContainer.appendChild(topButtons);
  }

  private anyRootSegments =
      () => {
        return this.displayState.rootSegments.size > 0;
      }

  private anyHiddenRootSegments =
      () => {
        return this.displayState.hiddenRootSegments!.size > 0;
      }

  private updateTopButtonsVisibility() {
    const {topButtons} = this;
    topButtons.style.display =
        (this.anyRootSegments() || this.anyHiddenRootSegments()) ? '' : 'none';
  }

  private clearItems() {
    const {itemContainer, topButtons, enabledItems, disabledItems} = this;
    while (true) {
      const lastElement = itemContainer.lastElementChild!;
      if (lastElement === topButtons) {
        break;
      }
      itemContainer.removeChild(lastElement);
    }
    enabledItems.clear();
    disabledItems.clear();
  }

  private handleEnabledSetChanged(x: Uint64|Uint64[]|null, added: boolean) {
    this.updateTopButtonsVisibility();
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
          this.addElement(segmentIDString, true);
        } else {
          // Preparing to enable or disable an element
          enabledItems.set(segmentIDString, disabledItem);
          hiddenRootSegments!.delete(x);
          this.checkItemsCheckbox(disabledItem, segmentIDString);
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
    this.updateTopButtonsVisibility();
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
          this.uncheckItemsCheckbox(enabledItem, segmentIDString);
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

  private addElement(segmentIDString: string, segmentEnabled: boolean) {
    // Wrap buttons in div so node button and its hide and copy buttons appear on same line
    const itemElement = document.createElement('div');
    itemElement.className = 'segment-div';
    itemElement.appendChild(this.createItemButton(segmentIDString));
    itemElement.appendChild(this.createItemCopyIDButton(segmentIDString));
    itemElement.appendChild(this.createItemCheckbox(segmentEnabled, segmentIDString));
    this.setItemButtonColor(itemElement);
    this.itemContainer.appendChild(itemElement);
    if (segmentEnabled) {
      this.enabledItems.set(segmentIDString, itemElement);
    } else {
      this.disabledItems.set(segmentIDString, itemElement);
    }
  }

  private createItemButton = (segmentIDString: string):
      HTMLButtonElement => {
        const widget = this;
        const itemButton = document.createElement('button');
        itemButton.className = 'segment-button';
        itemButton.textContent = segmentIDString;
        itemButton.title = `Remove segment ID ${segmentIDString}`;
        itemButton.dataset.segId = segmentIDString;
        itemButton.addEventListener('click', function(this: HTMLButtonElement) {
          temp.tryParseString(this.textContent!);
          widget.rootSegments.delete(temp);
          widget.hiddenRootSegments!.delete(temp);
        });
        itemButton.addEventListener('mouseenter', function(this: HTMLButtonElement) {
          temp.tryParseString(this.textContent!);
          widget.segmentSelectionState.set(temp);
          widget.segmentSelectionState.setRaw(temp);
          this.classList.add('selectedSeg');
          this.style.setProperty('--pulseSpeed', '2.5s');
        });
        itemButton.addEventListener('mouseleave', function(this: HTMLButtonElement) {
          temp.tryParseString(this.textContent!);
          widget.segmentSelectionState.set(null);
          widget.segmentSelectionState.setRaw(null);
          this.classList.remove('selectedSeg');
        });
        return itemButton;
      }

  private createItemCheckbox = (segmentEnabled: boolean, segmentIDString: string):
      HTMLInputElement => {
        const widget = this;
        const itemCheckbox = document.createElement('input');
        itemCheckbox.type = 'checkbox';
        itemCheckbox.className = 'segment-checkbox';
        if (segmentEnabled) {
          SegmentSetWidget.checkCheckbox(itemCheckbox, segmentIDString);
        } else {
          SegmentSetWidget.uncheckCheckbox(itemCheckbox, segmentIDString);
        }
        itemCheckbox.addEventListener('change', function(this: HTMLInputElement) {
          temp.tryParseString(segmentIDString);
          if (widget.enabledItems.get(segmentIDString)) {
            // Add to hiddenRootSegments. handleSetChanged will delete segment from rootSegments
            widget.hiddenRootSegments!.add(temp);
          } else {
            // Add to rootSegments. handleSetChanged will delete segment from hiddenRootSegments
            widget.rootSegments.add(temp);
          }
        });
        return itemCheckbox;
      }

  private createItemCopyIDButton = (segmentIDString: string):
      HTMLButtonElement => {
        // Button for the user to copy a segment's ID
        const itemCopyIDButton = document.createElement('button');
        itemCopyIDButton.className = 'segment-copy-button';
        itemCopyIDButton.title = `Copy segment ID ${segmentIDString}`;
        itemCopyIDButton.innerHTML = copyIcon;
        SegmentSetWidget.addCopyToClipboardEventToButton(itemCopyIDButton, () => segmentIDString);
        return itemCopyIDButton;
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
    this.disabledItems.forEach(itemElement => {
      this.setItemButtonColor(itemElement);
    });
  }

  private createClearButton(): HTMLButtonElement {
    const clearButton = document.createElement('button');
    clearButton.className = 'clear-button';
    clearButton.title = 'Remove all segment IDs';
    this.registerEventListener(clearButton, 'click', () => {
      this.rootSegments.clear();
      this.hiddenRootSegments!.clear();
    });
    return clearButton;
  }

  private createCopyAllSegmentIDsButton(): HTMLButtonElement {
    const {segmentIDsToCSV} = this;
    const copyAllSegmentIDsButton = document.createElement('button');
    copyAllSegmentIDsButton.className = 'copy-all-segment-IDs-button';
    copyAllSegmentIDsButton.title = 'Copy all segment IDs';
    copyAllSegmentIDsButton.innerHTML = copyIcon;
    SegmentSetWidget.addCopyToClipboardEventToButton(copyAllSegmentIDsButton, segmentIDsToCSV);
    return copyAllSegmentIDsButton;
  }

  private createCopyVisibleSegmentIDsButton(): HTMLButtonElement {
    const {segmentIDsToCSV} = this;
    const copyVisibleSegmentIDsButton = document.createElement('button');
    copyVisibleSegmentIDsButton.className = 'segment-copy-button copy-visible-segment-IDs-button';
    copyVisibleSegmentIDsButton.title = 'Copy visible segment IDs';
    const eyesSymbol = document.createElement('span');
    eyesSymbol.className = 'eyes-symbol-for-button';
    eyesSymbol.textContent = ' 👀';
    const copySymbol = document.createElement('span');
    copySymbol.innerHTML = copyIcon;
    copyVisibleSegmentIDsButton.appendChild(copySymbol);
    copyVisibleSegmentIDsButton.appendChild(eyesSymbol);
    SegmentSetWidget.addCopyToClipboardEventToButton(
        copyVisibleSegmentIDsButton, () => segmentIDsToCSV(true));
    return copyVisibleSegmentIDsButton;
  }

  private createToggleItemsCheckbox(): HTMLInputElement {
    const widget = this;
    const toggleItemsCheckbox = document.createElement('input');
    toggleItemsCheckbox.type = 'checkbox';
    toggleItemsCheckbox.className = 'segment-checkbox';
    toggleItemsCheckbox.title = 'Uncheck to hide all segments';
    toggleItemsCheckbox.checked = true;
    toggleItemsCheckbox.addEventListener('change', function(this: HTMLInputElement) {
      if (this.checked) {
        for (const x of widget.hiddenRootSegments!) {
          widget.rootSegments.add(x);
        }
        toggleItemsCheckbox.title = 'Uncheck to hide all segments';
      } else {
        for (const x of widget.rootSegments) {
          widget.hiddenRootSegments!.add(x);
        }
        toggleItemsCheckbox.title = 'Check to hide all segments';
      }
    });
    return toggleItemsCheckbox;
  }

  private segmentIDsToCSV = (displayedOnly: boolean = false):
      string => {
        const {displayState} = this;
        let segmentIDsString = '';
        // Boolean to avoid trailing comma
        let firstIDInString = false;
        for (const x of displayState.rootSegments) {
          if (firstIDInString) {
            segmentIDsString += ',' + x.toString();
          } else {
            segmentIDsString += x.toString();
            firstIDInString = true;
          }
        }
        if (!displayedOnly) {
          for (const x of displayState.hiddenRootSegments!) {
            if (firstIDInString) {
              segmentIDsString += ',' + x.toString();
            } else {
              segmentIDsString += x.toString();
              firstIDInString = true;
            }
          }
        }
        return segmentIDsString;
      }

  private static addCopyToClipboardEventToButton(
      button: HTMLButtonElement, stringCreator: () => string) {
    const defaultButtonColor = 'rgb(0, 255, 0)';
    const pressedButtonColor = 'rgb(240, 240, 240)';
    button.addEventListener('click', function(this: HTMLButtonElement) {
      const handleCopy = (e: ClipboardEvent) => {
        const {clipboardData} = e;
        if (clipboardData !== null) {
          clipboardData.setData('text/plain', stringCreator());
        }
        e.preventDefault();
        document.removeEventListener('copy', handleCopy);
        this.style.backgroundColor = defaultButtonColor;
        setTimeout(() => {
          if (this.style.backgroundColor === defaultButtonColor) {
            this.style.backgroundColor = pressedButtonColor;
          }
        }, 300);
      };
      document.addEventListener('copy', handleCopy);
      document.execCommand('copy');
    });
  }

  private checkItemsCheckbox(itemElement: ItemElement, segmentIDString: string) {
    const itemCheckbox =
        <HTMLInputElement>(itemElement.getElementsByClassName('segment-checkbox')[0]);
    SegmentSetWidget.checkCheckbox(itemCheckbox, segmentIDString);
  }

  private static checkCheckbox(checkbox: HTMLInputElement, segmentIDString: string) {
    checkbox.checked = true;
    checkbox.title = `Uncheck to hide segment ID ${segmentIDString}`;
  }

  private uncheckItemsCheckbox(itemElement: ItemElement, segmentIDString: string) {
    const itemCheckbox =
        <HTMLInputElement>(itemElement.getElementsByClassName('segment-checkbox')[0]);
    SegmentSetWidget.uncheckCheckbox(itemCheckbox, segmentIDString);
  }

  private static uncheckCheckbox(checkbox: HTMLInputElement, segmentIDString: string) {
    checkbox.checked = false;
    checkbox.title = `Check to show segment ID ${segmentIDString}`;
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
