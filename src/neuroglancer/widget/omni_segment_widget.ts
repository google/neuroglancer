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

import {SegmentMetadata} from 'neuroglancer/segment_metadata';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';
import {StatusMessage} from '../status';

require('./omni_segment_widget.css');

export class OmniSegmentWidget extends RefCounted {
  element = document.createElement('div');
  private segmentIDToTableRowMap = new Map<string, HTMLTableRowElement>();
  private segmentIDRemapping = new Map<string, string>();
  private mergedSegmentVoxelCount = new Map<string, number>();
  private segmentIDToVoxelCountMap = new Map<string, number>();
  private segmentEquivalenceToRowMap =
      new Map<string, {equivalentSegments: string[], row: HTMLTableRowElement}>();

  constructor(
      private displayState: SegmentationDisplayState, private segmentMetadata: SegmentMetadata) {
    super();
    this.element.className = 'omni-segment-widget-element';
    this.makeSegmentTable();
    this.makeCategoryTable();
    this.makeSegmentEquivalenceTable();
  }

  private makeSegmentTable() {
    const {element} = this;

    this.createExportToCSVButton();

    const segmentTableContainer = document.createElement('div');
    const segmentTable = document.createElement('table');
    segmentTable.className = 'omni-segment-table';

    this.createSegmentTableUtilities(segmentTableContainer);
    this.createSegmentTableHeader(segmentTable);
    this.createSegmentTableRows(segmentTable);

    segmentTableContainer.className = 'omni-segment-table-container';
    segmentTableContainer.appendChild(segmentTable);
    element.appendChild(segmentTableContainer);
  }

  private createExportToCSVButton() {
    const {
      segmentMetadata,
      segmentIDToVoxelCountMap,
      mergedSegmentVoxelCount,
      segmentIDRemapping,
      segmentEquivalenceToRowMap,
      element
    } = this;
    const exportToCSVButton = document.createElement('button');
    exportToCSVButton.textContent = 'Export to CSV';

    const exportToCSV = () => {
      const filename = 'segmentation_data.csv';
      const tableHeaderRow = [
        'Segments table', '', '', '', 'Base segments table', '', '', '',
        'Equivalence of merged segments', '', '', 'List of categories'
      ];
      const tableColumnHeaderRow = [
        'Segment ID', 'Voxel Count', 'Category', '', 'Segment ID (Unmerged)', 'Voxel Count',
        'Category', '', 'Segment ID', 'Equivalent Segments', '', 'Categories'
      ];
      const columnsPerTable = [4, 4, 3, 1];
      const csvTablesList: string[][][] = [[], [], [], []];
      let maxTableRows = 0;
      let i = 0;
      for (const segmentID of segmentIDToVoxelCountMap.keys()) {
        if (!segmentIDRemapping.get(segmentID)) {
          const currentRow = [segmentID];
          const voxelCount = mergedSegmentVoxelCount.get(segmentID);
          if (voxelCount) {
            currentRow.push(String(voxelCount));
          } else {
            currentRow.push(String(segmentIDToVoxelCountMap.get(segmentID)));
          }
          const segmentCategory = segmentMetadata.categorizedSegments.get(segmentID);
          if (segmentCategory) {
            currentRow.push(segmentMetadata.segmentCategories.get(segmentCategory)!);
          } else {
            currentRow.push('');
          }
          currentRow.push('');
          i++;
          csvTablesList[0].push(currentRow);
        }
      }
      if (i > maxTableRows) {
        maxTableRows = i;
      }
      i = 0;
      for (const [segmentID, voxelCount] of segmentIDToVoxelCountMap) {
        let currentRow = [segmentID];
        currentRow.push(String(voxelCount));
        const segmentCategory = segmentMetadata.categorizedSegments.get(segmentID);
        if (segmentCategory) {
          currentRow.push(segmentMetadata.segmentCategories.get(segmentCategory)!);
        } else {
          currentRow.push('');
        }
        currentRow.push('');
        i++;
        csvTablesList[1].push(currentRow);
      }
      if (i > maxTableRows) {
        maxTableRows = i;
      }
      i = 0;
      for (const [segmentID, {equivalentSegments}] of segmentEquivalenceToRowMap) {
        let currentRow = [segmentID];
        currentRow.push('"' + equivalentSegments.join(',') + '"');
        currentRow.push('');
        csvTablesList[2].push(currentRow);
        i++;
      }
      if (i > maxTableRows) {
        maxTableRows = i;
      }
      i = 0;
      for (const categoryName of segmentMetadata.segmentCategories.values()) {
        csvTablesList[3].push([categoryName]);
        i++;
      }
      if (i > maxTableRows) {
        maxTableRows = i;
      }
      for (let table = 0; table < csvTablesList.length; table++) {
        for (let tableRow = csvTablesList[table].length; tableRow < maxTableRows; tableRow++) {
          const emptyRow = [];
          for (let column = 0; column < columnsPerTable[table]; column++) {
            emptyRow.push('');
          }
          csvTablesList[table][tableRow] = emptyRow;
        }
      }
      const csvStringsList = [tableHeaderRow, tableColumnHeaderRow];
      for (i = 0; i < maxTableRows; i++) {
        csvStringsList.push(csvTablesList[0][i].concat(
            csvTablesList[1][i], csvTablesList[2][i], csvTablesList[3][i]));
      }
      const csvString = csvStringsList.map(row => row.join(',')).join('\n');
      const blob = new Blob([csvString], {type: 'text/csv;charset=utf-8;'});
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    exportToCSVButton.addEventListener('click', exportToCSV);
    const exportToCSVButtonDiv = document.createElement('div');
    exportToCSVButtonDiv.appendChild(exportToCSVButton);
    element.appendChild(exportToCSVButtonDiv);
  }

  private createSegmentTableUtilities(segmentTableContainer: HTMLDivElement) {
    const {element, segmentMetadata, segmentIDToTableRowMap, segmentIDRemapping} = this;

    const filterByCategoryDropdownContainer = document.createElement('div');
    const hideSegmentTableButtonContainer = document.createElement('div');
    const findSegmentIDContainer = document.createElement('div');

    const createHideSegmentTableButton = () => {
      let showSegmentTable = false;
      const hideSegmentTableButton = document.createElement('button');
      hideSegmentTableButtonContainer.id = 'toggle-segment-table-visibility';
      hideSegmentTableButton.textContent = 'Hide segment table';
      hideSegmentTableButton.addEventListener('click', () => {
        if (showSegmentTable) {
          hideSegmentTableButton.textContent = 'Hide segment table';
          segmentTableContainer.style.display = '';
          filterByCategoryDropdownContainer.style.display = '';
          findSegmentIDContainer.style.display = '';
        } else {
          hideSegmentTableButton.textContent = 'Show segment table';
          segmentTableContainer.style.display = 'none';
          filterByCategoryDropdownContainer.style.display = 'none';
          findSegmentIDContainer.style.display = 'none';
        }
        showSegmentTable = !showSegmentTable;
      });
      hideSegmentTableButtonContainer.appendChild(hideSegmentTableButton);
    };

    const filterDropdown = document.createElement('select');
    const segmentIDFinder = document.createElement('input');

    const setSegmentRowsVisibility = () => {
      for (const [segmentID, row] of segmentIDToTableRowMap) {
        if ((!segmentIDRemapping.has(segmentID)) &&
            segmentID.indexOf(segmentIDFinder.value) === 0 &&
            (filterDropdown.selectedOptions[0].value === '0' ||
             (<HTMLSelectElement>(row.cells[2].firstChild!)).selectedIndex ===
                 filterDropdown.selectedIndex)) {
          row.style.display = 'table-row';
        } else {
          row.style.display = 'none';
        }
      }
    };

    const createFilterByCategoryDropdown = () => {
      const filterDropdownLabel = document.createElement('label');
      filterDropdownLabel.textContent = 'Filter segment IDs by category: ';
      filterDropdown.id = 'omni-segment-widget-filter';
      const viewAllOption = document.createElement('option');
      viewAllOption.textContent = 'View all';
      viewAllOption.value = '0';
      filterDropdown.appendChild(viewAllOption);
      for (const [categoryId, categoryName] of segmentMetadata.segmentCategories) {
        const option = document.createElement('option');
        option.textContent = categoryName;
        option.value = String(categoryId);
        filterDropdown.appendChild(option);
      }

      // Only show segments that have the selected category
      filterDropdown.addEventListener('change', () => {
        setSegmentRowsVisibility();
      });
      // When a new category is added, add it to the filter dropdown
      segmentMetadata.categoryAdded.add((id: number, name: string) => {
        const filterOption = document.createElement('option');
        filterOption.textContent = name;
        filterOption.value = String(id);
        filterDropdown.appendChild(filterOption);
        for (const segmentRow of segmentIDToTableRowMap.values()) {
          const option = document.createElement('option');
          option.textContent = name;
          option.value = String(id);
          segmentRow.cells[2].firstChild!.appendChild(option);
        }
      });
      segmentMetadata.categoryDeleted.add((id: number) => {
        let deletedIndex = -1;
        Array.from(filterDropdown.options).forEach((option, index) => {
          if (option.value === String(id)) {
            deletedIndex = index;
          }
        });
        if (deletedIndex <= 0) {
          throw new Error('Deleted category ID not found in category filter dropdown');
        } else {
          if (filterDropdown.selectedIndex === deletedIndex) {
            filterDropdown.selectedIndex = 0;
            setSegmentRowsVisibility();
          }
          filterDropdown.remove(deletedIndex);
          for (const segmentRow of segmentIDToTableRowMap.values()) {
            const categorySelect = <HTMLSelectElement>(segmentRow.cells[2].firstChild!);
            if (categorySelect.selectedIndex === deletedIndex) {
              categorySelect.selectedIndex = 0;
              segmentMetadata.categorizedSegments.delete(
                  segmentRow.getElementsByClassName('toggle-segment-to-root-segments')[0]
                      .textContent!);
            }
            categorySelect.remove(deletedIndex);
            segmentMetadata.changed.dispatch();
            const option = document.createElement('option');
            option.textContent = name;
            option.value = String(id);
            segmentRow.cells[2].firstChild!.appendChild(option);
          }
        }
      });
      filterDropdownLabel.appendChild(filterDropdown);
      filterByCategoryDropdownContainer.appendChild(filterDropdownLabel);
    };

    const createFindSegmentID = () => {
      segmentIDFinder.placeholder = 'Enter a segment ID';
      const segmentIDFinderLabel = document.createElement('label');
      segmentIDFinderLabel.textContent = 'Find segment ID: ';
      segmentIDFinder.addEventListener('input', () => {
        setSegmentRowsVisibility();
      });
      segmentIDFinderLabel.appendChild(segmentIDFinder);
      findSegmentIDContainer.appendChild(segmentIDFinderLabel);
    };

    createHideSegmentTableButton();
    createFilterByCategoryDropdown();
    createFindSegmentID();

    element.appendChild(hideSegmentTableButtonContainer);
    element.appendChild(filterByCategoryDropdownContainer);
    element.appendChild(findSegmentIDContainer);
  }

  private createSegmentTableHeader(segmentTable: HTMLTableElement) {
    const {segmentIDToTableRowMap} = this;
    const segmentIDColumnHeader = document.createElement('th');
    const voxelCountHeader = document.createElement('th');

    const sortBySegmentIDButton = document.createElement('button');
    sortBySegmentIDButton.textContent = 'Segment ID';
    const sortByVoxelCountButton = document.createElement('button');
    sortByVoxelCountButton.textContent = 'Voxel Count';

    let sortedBySegmentID = false;
    let sortedBySegAscending = false;
    let sortedByVoxelCount = false;
    let sortedByVCAscending = false;

    const createSortBySegmentIDAction = () => {
      sortBySegmentIDButton.addEventListener('click', () => {
        const segmentTableRows = Array.from(segmentIDToTableRowMap.values());
        while (segmentTable.rows.length > 1) {
          segmentTable.deleteRow(1);
        }
        if (sortedBySegmentID && sortedBySegAscending) {
          // Sort segment rows by segment ID ascending
          segmentTableRows.sort((a, b) => {
            const aU64 = Uint64.parseString(a.children[0].textContent!, 10);
            const bU64 = Uint64.parseString(b.children[0].textContent!, 10);
            return Uint64.compare(bU64, aU64);
          });
          sortedBySegmentID = true;
          sortedBySegAscending = false;
          sortedByVoxelCount = false;
          sortedByVCAscending = false;
          sortBySegmentIDButton.textContent = 'Segment ID ▼';
          sortByVoxelCountButton.textContent = 'Voxel Count';
        } else {
          // Sort segment rows by segment ID descending
          segmentTableRows.sort((a, b) => {
            const aU64 = Uint64.parseString(a.children[0].textContent!, 10);
            const bU64 = Uint64.parseString(b.children[0].textContent!, 10);
            return Uint64.compare(aU64, bU64);
          });
          sortedBySegmentID = true;
          sortedBySegAscending = true;
          sortedByVoxelCount = false;
          sortedByVCAscending = false;
          sortBySegmentIDButton.textContent = 'Segment ID ▲';
          sortByVoxelCountButton.textContent = 'Voxel Count';
        }
        segmentTableRows.forEach(row => {
          segmentTable.appendChild(row);
        });
      });
      segmentIDColumnHeader.appendChild(sortBySegmentIDButton);
    };

    const createSortByVoxelCountAction = () => {
      sortByVoxelCountButton.addEventListener('click', () => {
        const segmentTableRows = Array.from(segmentIDToTableRowMap.values());
        while (segmentTable.rows.length > 1) {
          segmentTable.deleteRow(1);
        }
        if (sortedByVoxelCount && sortedByVCAscending) {
          // Sort segment rows by voxel count descending
          segmentTableRows.sort((a, b) => {
            return parseInt(b.children[1].textContent!, 10) -
                parseInt(a.children[1].textContent!, 10);
          });
          sortedByVoxelCount = true;
          sortedByVCAscending = false;
          sortedBySegmentID = false;
          sortedBySegAscending = false;
          sortBySegmentIDButton.textContent = 'Segment ID';
          sortByVoxelCountButton.textContent = 'Voxel Count ▼';
        } else {
          // Sort segment rows by voxel count ascending
          segmentTableRows.sort((a, b) => {
            return parseInt(a.children[1].textContent!, 10) -
                parseInt(b.children[1].textContent!, 10);
          });
          sortedByVoxelCount = true;
          sortedByVCAscending = true;
          sortedBySegmentID = false;
          sortedBySegAscending = false;
          sortBySegmentIDButton.textContent = 'Segment ID';
          sortByVoxelCountButton.textContent = 'Voxel Count ▲';
        }
        segmentTableRows.forEach(row => {
          segmentTable.appendChild(row);
        });
      });
      voxelCountHeader.appendChild(sortByVoxelCountButton);
    };

    createSortBySegmentIDAction();
    createSortByVoxelCountAction();

    const categoryHeader = document.createElement('th');
    categoryHeader.textContent = 'Category';

    const segmentTableHeader = document.createElement('tr');
    segmentTableHeader.appendChild(segmentIDColumnHeader);
    segmentTableHeader.appendChild(voxelCountHeader);

    segmentTableHeader.appendChild(categoryHeader);
    segmentTable.appendChild(segmentTableHeader);
  }

  private createSegmentTableRows(segmentTable: HTMLTableElement) {
    const {
      displayState,
      segmentMetadata,
      segmentIDToTableRowMap,
      segmentIDRemapping,
      mergedSegmentVoxelCount,
      segmentIDToVoxelCountMap: stringToVoxelCountMap
    } = this;
    for (const [segmentIDString, voxelCount] of segmentMetadata.segmentToVoxelCountMap) {
      const segmentID = Uint64.parseString(segmentIDString, 10);
      let statusIndex = 0;
      const categoryIDForSegment = segmentMetadata.categorizedSegments.get(segmentIDString);
      const segmentRow = document.createElement('tr');
      const segmentIDElement = document.createElement('td');
      stringToVoxelCountMap.set(segmentIDString, voxelCount);
      const toggleSegmentToRootSegments = document.createElement('button');
      toggleSegmentToRootSegments.className = 'toggle-segment-to-root-segments';
      toggleSegmentToRootSegments.textContent = segmentIDString;
      toggleSegmentToRootSegments.style.backgroundColor =
          displayState.segmentColorHash.computeCssColor(segmentID);
      toggleSegmentToRootSegments.addEventListener('click', () => {
        if (displayState.rootSegments.has(segmentID)) {
          displayState.rootSegments.delete(segmentID);
        } else {
          displayState.rootSegments.add(segmentID);
        }
      });
      segmentIDElement.appendChild(toggleSegmentToRootSegments);

      const voxelCountElement = document.createElement('td');
      voxelCountElement.textContent = voxelCount.toString();

      const categoryDropdownCell = document.createElement('td');
      const categoryDropdown = document.createElement('select');
      categoryDropdown.className = 'omni-segment-widget-category-dropdown';
      const defaultOption = document.createElement('option');
      defaultOption.textContent = '';
      defaultOption.value = '0';
      categoryDropdown.appendChild(defaultOption);
      let currentOptionIndex = 1;
      // Add all the segment categories to the dropdown
      for (const [categoryId, categoryName] of segmentMetadata.segmentCategories) {
        const option = document.createElement('option');
        option.textContent = categoryName;
        option.value = String(categoryId);
        categoryDropdown.appendChild(option);
        // Set the selected dropdown option to be the category for the segment from the state
        if (categoryIDForSegment === categoryId) {
          statusIndex = currentOptionIndex;
        }
        currentOptionIndex++;
      }
      categoryDropdown.selectedIndex = statusIndex;
      categoryDropdown.addEventListener('change', () => {
        const categoryId = Number(categoryDropdown.selectedOptions[0].value);
        if (categoryId === 0) {
          // Segment no longer categorized
          segmentMetadata.categorizedSegments.delete(segmentIDString);
        } else {
          segmentMetadata.categorizedSegments.set(segmentIDString, categoryId);
        }
        segmentMetadata.changed.dispatch();
      });
      categoryDropdownCell.appendChild(categoryDropdown);

      segmentRow.appendChild(segmentIDElement);
      segmentRow.appendChild(voxelCountElement);
      segmentRow.appendChild(categoryDropdownCell);

      // Check if segment is in an equivalence, if so row should be hidden and voxel count merged
      if (displayState.segmentEquivalences.has(segmentID)) {
        const maxSegmentID = displayState.segmentEquivalences.get(segmentID);
        const maxSegmentIDString = maxSegmentID.toString();
        const currentVoxelCount = mergedSegmentVoxelCount.get(maxSegmentIDString);
        if (currentVoxelCount === undefined) {
          mergedSegmentVoxelCount.set(maxSegmentIDString, voxelCount);
        } else {
          mergedSegmentVoxelCount.set(maxSegmentIDString, currentVoxelCount + voxelCount);
        }
        if (!Uint64.equal(segmentID, maxSegmentID)) {
          segmentIDRemapping.set(segmentIDString, maxSegmentIDString);
          segmentRow.style.display = 'none';
        }
      }
      segmentIDToTableRowMap.set(segmentIDString, segmentRow);
      segmentTable.appendChild(segmentRow);
    }
    // Loop through merged segments, setting voxel count appropriately
    for (const [segmentIDString, voxelCount] of mergedSegmentVoxelCount) {
      const associatedRow = segmentIDToTableRowMap.get(segmentIDString)!;
      associatedRow.cells[1].textContent = voxelCount.toString();
    }
  }

  private makeCategoryTable() {
    const {segmentMetadata, element} = this;
    const categoryTableContainer = document.createElement('div');
    categoryTableContainer.id = 'omni-segment-category-table-container';
    const segmentCategoryTable = document.createElement('table');
    segmentCategoryTable.id = 'omni-segment-category-table';
    const segmentCategoryTableHeader = document.createElement('tr');
    const categoryNameHeader = document.createElement('th');
    categoryNameHeader.textContent = 'Category';
    const deleteNameHeader = document.createElement('th');
    deleteNameHeader.textContent = 'Delete';
    segmentCategoryTableHeader.appendChild(categoryNameHeader);
    segmentCategoryTableHeader.appendChild(deleteNameHeader);
    segmentCategoryTable.appendChild(segmentCategoryTableHeader);
    categoryTableContainer.appendChild(segmentCategoryTable);

    const createCategoryRow = (categoryId: number, categoryName: string) => {
      const segmentCategoryRow = document.createElement('tr');
      const categoryNameCell = document.createElement('td');
      const categoryNameTextWrapper = document.createElement('div');
      categoryNameTextWrapper.className = 'category-name-wrapper';
      categoryNameTextWrapper.textContent = categoryName;
      categoryNameCell.appendChild(categoryNameTextWrapper);
      segmentCategoryRow.appendChild(categoryNameCell);
      const removeCategoryCell = document.createElement('td');
      const removeCategoryButton = document.createElement('button');
      removeCategoryButton.textContent = 'x';
      removeCategoryButton.addEventListener('click', () => {
        const confirmed = confirm(
            'Are you sure you want to delete this category? All associated segments will be disassociated');
        if (confirmed) {
          segmentMetadata.removeCategory(categoryId);
          segmentCategoryTable.removeChild(segmentCategoryRow);
        }
      });
      removeCategoryCell.appendChild(removeCategoryButton);
      segmentCategoryRow.appendChild(removeCategoryCell);
      segmentCategoryTable.appendChild(segmentCategoryRow);
    };
    for (const [categoryId, categoryName] of segmentMetadata.segmentCategories) {
      createCategoryRow(categoryId, categoryName);
    }

    const categoryInput = document.createElement('input');
    categoryInput.id = 'segment-category-input';
    categoryInput.placeholder = 'Enter your category';
    categoryInput.title = 'Enter the category you wish to add';
    const categoryNameInputButton = document.createElement('button');
    categoryNameInputButton.id = 'segment-category-input-button';
    categoryNameInputButton.textContent = 'Add category';
    categoryNameInputButton.addEventListener('click', () => {
      if (categoryInput.value === '') {
        alert('Category name cannot be empty');
      } else {
        const categoryId = segmentMetadata.addNewCategory(categoryInput.value);
        createCategoryRow(categoryId, categoryInput.value);
      }
    });
    const addCategoryDiv = document.createElement('div');
    addCategoryDiv.id = 'add-segment-category-div';
    addCategoryDiv.appendChild(categoryInput);
    addCategoryDiv.appendChild(categoryNameInputButton);

    let showCategoryTable = false;
    const hideCategoryTableButtonContainer = document.createElement('div');
    hideCategoryTableButtonContainer.id = 'toggle-segment-category-visibility';
    const hideCategoryTableButton = document.createElement('button');
    hideCategoryTableButton.textContent = 'Hide category table';
    hideCategoryTableButton.addEventListener('click', () => {
      if (showCategoryTable) {
        hideCategoryTableButton.textContent = 'Hide category table';
        categoryTableContainer.style.display = '';
        addCategoryDiv.style.display = '';
      } else {
        hideCategoryTableButton.textContent = 'Show category table';
        categoryTableContainer.style.display = 'none';
        addCategoryDiv.style.display = 'none';
      }
      showCategoryTable = !showCategoryTable;
    });
    hideCategoryTableButtonContainer.appendChild(hideCategoryTableButton);

    element.appendChild(hideCategoryTableButtonContainer);
    element.appendChild(addCategoryDiv);
    element.appendChild(categoryTableContainer);
  }

  private makeSegmentEquivalenceTable() {
    const {displayState, segmentMetadata, element} = this;

    const segmentEquivalenceTable = document.createElement('table');
    const segmentEquivalenceTableHeader = document.createElement('tr');
    const segmentEquivalenceIDHeader = document.createElement('th');
    segmentEquivalenceIDHeader.textContent = 'ID';
    const segmentEquivalenceEquivalentSegmentsHeader = document.createElement('th');
    segmentEquivalenceEquivalentSegmentsHeader.textContent = 'Equivalent IDs';
    segmentEquivalenceTableHeader.appendChild(segmentEquivalenceIDHeader);
    segmentEquivalenceTableHeader.appendChild(segmentEquivalenceEquivalentSegmentsHeader);
    segmentEquivalenceTable.appendChild(segmentEquivalenceTableHeader);

    const enableEquivalentSegmentsRemovalLabel = document.createElement('label');
    enableEquivalentSegmentsRemovalLabel.textContent =
        'Equivalent ID buttons remove from equivalence: ';
    const enableEquivalentSegmentsRemoval = document.createElement('input');
    enableEquivalentSegmentsRemoval.checked = false;
    enableEquivalentSegmentsRemoval.type = 'checkbox';
    enableEquivalentSegmentsRemovalLabel.appendChild(enableEquivalentSegmentsRemoval);
    const enableEquivalentSegmentsContainer = document.createElement('div');
    enableEquivalentSegmentsContainer.appendChild(enableEquivalentSegmentsRemovalLabel);

    const segmentEquivalenceTableContainer = document.createElement('div');
    segmentEquivalenceTableContainer.appendChild(enableEquivalentSegmentsContainer);

    const createAddSegmentEquivalenceDiv = () => {
      const addSegmentEquivalenceLabel = document.createElement('label');
      addSegmentEquivalenceLabel.textContent = 'Add segment equivalence:';
      addSegmentEquivalenceLabel.id = 'add-segment-equivalence-label';
      const addSegmentEquivalenceLabelDiv = document.createElement('div');
      addSegmentEquivalenceLabelDiv.appendChild(addSegmentEquivalenceLabel);
      addSegmentEquivalenceLabelDiv.id = 'add-segment-equivalence-label-div';
      const firstSegmentInput = document.createElement('input');
      firstSegmentInput.className = 'segment-id-input';
      firstSegmentInput.placeholder = 'Segment 1';
      const secondSegmentInput = document.createElement('input');
      secondSegmentInput.placeholder = 'Segment 2';
      secondSegmentInput.className = 'segment-id-input';
      const segmentInputDiv = document.createElement('div');
      segmentInputDiv.id = 'add-segment-equivalence-input-div';
      segmentInputDiv.appendChild(firstSegmentInput);
      segmentInputDiv.appendChild(secondSegmentInput);
      const addSegmentEquivalenceButton = document.createElement('button');
      addSegmentEquivalenceButton.textContent = 'Add';
      addSegmentEquivalenceButton.addEventListener('click', () => {
        const firstSegmentIDString = firstSegmentInput.value;
        if (segmentMetadata.segmentToVoxelCountMap.has(firstSegmentIDString)) {
          const secondSegmentIDString = secondSegmentInput.value;
          if (segmentMetadata.segmentToVoxelCountMap.has(secondSegmentIDString)) {
            const firstSegmentID = Uint64.parseString(firstSegmentIDString);
            const secondSegmentID = Uint64.parseString(secondSegmentIDString);
            displayState.segmentEquivalences.link(firstSegmentID, secondSegmentID);
            firstSegmentInput.value = '';
            secondSegmentInput.value = '';
          } else {
            alert(`${secondSegmentIDString} is not a valid segment ID`);
          }
        } else {
          alert(`${firstSegmentIDString} is not a valid segment ID`);
        }
      });
      segmentInputDiv.appendChild(addSegmentEquivalenceButton);
      segmentEquivalenceTableContainer.appendChild(addSegmentEquivalenceLabelDiv);
      segmentEquivalenceTableContainer.appendChild(segmentInputDiv);
    };

    createAddSegmentEquivalenceDiv();
    this.createSegmentEquivalenceTableRows(
        segmentEquivalenceTable, enableEquivalentSegmentsRemoval);
    this.createFilterSegmentEquivalence(segmentEquivalenceTableContainer);
    const segmentEquivalenceTableDiv = document.createElement('div');
    segmentEquivalenceTableDiv.id = 'segment-equivalence-table-div';
    segmentEquivalenceTableDiv.appendChild(segmentEquivalenceTable);
    segmentEquivalenceTableContainer.appendChild(segmentEquivalenceTableDiv);

    let showSegmentEquivalenceTable = false;
    const hideSegmentEquivalenceTableButton = document.createElement('button');
    hideSegmentEquivalenceTableButton.id = 'toggle-segment-equivalence-visibility';
    hideSegmentEquivalenceTableButton.textContent = 'Hide segment equivalence table';
    hideSegmentEquivalenceTableButton.addEventListener('click', () => {
      if (showSegmentEquivalenceTable) {
        hideSegmentEquivalenceTableButton.textContent = 'Hide segment equivalence table';
        segmentEquivalenceTableContainer.style.display = '';
      } else {
        hideSegmentEquivalenceTableButton.textContent = 'Show segment equivalence table';
        segmentEquivalenceTableContainer.style.display = 'none';
      }
      showSegmentEquivalenceTable = !showSegmentEquivalenceTable;
    });

    element.appendChild(hideSegmentEquivalenceTableButton);
    element.appendChild(segmentEquivalenceTableContainer);
  }

  private createSegmentEquivalenceTableRows(
      segmentEquivalenceTable: HTMLTableElement,
      enableEquivalentSegmentsRemoval: HTMLInputElement) {
    const {
      displayState,
      segmentMetadata,
      segmentIDToTableRowMap,
      segmentIDToVoxelCountMap: stringToVoxelCountMap,
      segmentIDRemapping,
      mergedSegmentVoxelCount,
      segmentEquivalenceToRowMap
    } = this;
    let segmentEquivalenceChangedFromTable = false;

    const createTableRows = () => {
      segmentEquivalenceToRowMap.clear();
      const segmentEquivalenceMap = new Map<string, Uint64[]>();
      for (const [segmentID, maxSegmentID] of segmentIDRemapping) {
        // For all merged segments, create a mapped from the maxSegmentID to a list of
        // the segments merged into it.
        const listOfEquivalentSegments = segmentEquivalenceMap.get(maxSegmentID);
        const segmentIDU64 = Uint64.parseString(segmentID, 10);
        if (listOfEquivalentSegments === undefined) {
          segmentEquivalenceMap.set(maxSegmentID, [segmentIDU64]);
        } else {
          listOfEquivalentSegments.push(segmentIDU64);
        }
        const listOfEquivalentSegmentsStrings = segmentEquivalenceToRowMap.get(maxSegmentID);
        if (listOfEquivalentSegmentsStrings === undefined) {
          const tableRowForSegmentID = document.createElement('tr');
          segmentEquivalenceToRowMap.set(
              maxSegmentID,
              {equivalentSegments: [maxSegmentID, segmentID], row: tableRowForSegmentID});
        } else {
          listOfEquivalentSegmentsStrings.equivalentSegments.push(segmentID);
        }
      }
      while (segmentEquivalenceTable.rows.length > 1) {
        segmentEquivalenceTable.deleteRow(1);
      }
      const maxSegmentIDs = Array.from(segmentEquivalenceMap.keys());
      const maxSegmentIDsU64s = maxSegmentIDs.map(sid => Uint64.parseString(sid, 10));
      // Sort the segment IDs to display in a predictable (ascending) order
      maxSegmentIDsU64s.sort((a, b) => {
        return Uint64.compare(a, b);
      });
      for (const maxSegmentIDU64 of maxSegmentIDsU64s) {
        const maxSegmentID = maxSegmentIDU64.toString();
        const listOfEquivalentSegments = segmentEquivalenceMap.get(maxSegmentID)!;
        // Sort the "child" segment IDs to display in a predictable (ascending) order
        listOfEquivalentSegments.sort((a, b) => {
          return Uint64.compare(a, b);
        });
        // const currentRow = document.createElement('tr');
        const currentRow = segmentEquivalenceToRowMap.get(maxSegmentID)!.row;
        const segmentIDCell = document.createElement('td');
        const segmentIDCellButton = document.createElement('button');
        segmentIDCellButton.textContent = maxSegmentID;
        segmentIDCellButton.title = `Show/hide segment ID ${maxSegmentID}`;
        segmentIDCellButton.addEventListener('click', () => {
          if (displayState.rootSegments.has(maxSegmentIDU64)) {
            displayState.rootSegments.delete(maxSegmentIDU64);
          } else {
            displayState.rootSegments.add(maxSegmentIDU64);
          }
        });
        segmentIDCell.appendChild(segmentIDCellButton);
        currentRow.appendChild(segmentIDCell);
        const segmentListCell = document.createElement('td');
        const removeEquivalenceButton = document.createElement('button');
        removeEquivalenceButton.textContent = 'x';
        removeEquivalenceButton.title = 'Delete this equivalence';
        removeEquivalenceButton.addEventListener('click', () => {
          const confirmed = confirm('Are you sure you want to delete this equivalence?');
          if (confirmed) {
            if (displayState.rootSegments.has(maxSegmentIDU64)) {
              listOfEquivalentSegments.forEach(equivalentSegment => {
                displayState.rootSegments.add(equivalentSegment);
              });
            }
            displayState.segmentEquivalences.deleteSet(Uint64.parseString(maxSegmentID, 10));
          }
        });
        segmentListCell.appendChild(removeEquivalenceButton);
        listOfEquivalentSegments.forEach(equivalentSegmentU64 => {
          const equivalentSegment = equivalentSegmentU64.toString();
          // Each "child" segment ID is represented in the list as a button that
          // removes the segment from the equivalence. To prevent misclicks, this behavior
          // is prevented by default. It's enabled if the enableEquivalentSegmentsRemoval
          // checkbox is checked.
          const currentButton = document.createElement('button');
          currentButton.textContent = equivalentSegment;
          currentButton.title = `Remove segment ${equivalentSegment} from equivalence`;
          currentButton.addEventListener('click', () => {
            if (enableEquivalentSegmentsRemoval.checked) {
              // We are listening to displayState.segmentEquivalence signal to update
              // our table on changes. Disable this when the changes originate from
              // the table itself.
              segmentEquivalenceChangedFromTable = true;
              displayState.segmentEquivalences.deleteSet(maxSegmentIDU64);
              // To delete a segment from the equivalence we have to recreate the entire
              // equivalence without the segment
              listOfEquivalentSegments.forEach(equivSegmentU64 => {
                if (!Uint64.equal(equivalentSegmentU64, equivSegmentU64)) {
                  displayState.segmentEquivalences.link(equivSegmentU64, maxSegmentIDU64);
                }
              });
              segmentEquivalenceChangedFromTable = false;
              segmentListCell.removeChild(currentButton);
              segmentIDRemapping.delete(equivalentSegment);
              segmentIDToTableRowMap.get(equivalentSegment)!.style.display = '';
              // Update the voxel counts for the new equivalence
              const oldCount = mergedSegmentVoxelCount.get(maxSegmentID);
              const newCount =
                  oldCount! - segmentMetadata.segmentToVoxelCountMap.get(equivalentSegment)!;
              mergedSegmentVoxelCount.set(maxSegmentID, newCount);
              const associatedRow = segmentIDToTableRowMap.get(maxSegmentID)!;
              associatedRow.cells[1].textContent = newCount.toString();
              // Delete the equivalence if there was only one child
              if (listOfEquivalentSegments.length === 1) {
                segmentEquivalenceTable.removeChild(currentRow);
                mergedSegmentVoxelCount.delete(maxSegmentID);
              }
              if (displayState.rootSegments.has(maxSegmentIDU64)) {
                displayState.rootSegments.add(equivalentSegmentU64);
              }
              StatusMessage.showTemporaryMessage(
                  `Removed segment ${equivalentSegment} from equivalence for segment ${
                      maxSegmentID}`,
                  7000);
            } else {
              StatusMessage.showTemporaryMessage(
                  `Will not remove ${
                      equivalentSegment} from equivalence because "Equivalent ID buttons remove from equivalence" checkbox is disabled`,
                  7000);
            }
          });
          segmentListCell.appendChild(currentButton);
        });
        currentRow.appendChild(segmentIDCell);
        currentRow.appendChild(segmentListCell);
        segmentEquivalenceTable.appendChild(currentRow);
      }
    };
    createTableRows();

    // Update the table when the equivalences change
    displayState.segmentEquivalences.changed.add(() => {
      if (!segmentEquivalenceChangedFromTable) {
        const oldRemappedSegments = segmentIDRemapping.keys();
        segmentIDRemapping.clear();
        mergedSegmentVoxelCount.clear();
        for (const [segmentID, maxSegmentID] of displayState.segmentEquivalences.disjointSets) {
          const maxSegmentIDString = maxSegmentID.toString();
          const currentVoxelCount = mergedSegmentVoxelCount.get(maxSegmentIDString);
          const segmentIDString = segmentID.toString();
          const voxelCount = stringToVoxelCountMap.get(segmentIDString)!;
          if (currentVoxelCount === undefined) {
            mergedSegmentVoxelCount.set(maxSegmentIDString, voxelCount);
          } else {
            mergedSegmentVoxelCount.set(maxSegmentIDString, currentVoxelCount + voxelCount);
          }
          const segmentRow = segmentIDToTableRowMap.get(segmentIDString)!;
          if (!Uint64.equal(segmentID, maxSegmentID)) {
            segmentIDRemapping.set(segmentIDString, maxSegmentIDString);
            segmentRow.style.display = 'none';
          } else {
            segmentRow.style.display = 'table-row';
          }
        }
        for (const [segmentIDString, voxelCount] of mergedSegmentVoxelCount) {
          const associatedRow = segmentIDToTableRowMap.get(segmentIDString)!;
          associatedRow.cells[1].textContent = voxelCount.toString();
        }
        for (const segmentIDString of oldRemappedSegments) {
          if (!segmentIDRemapping.has(segmentIDString)) {
            const segmentRow = segmentIDToTableRowMap.get(segmentIDString)!;
            segmentRow.style.display = 'table-row';
          }
        }
        createTableRows();
      }
    });
  }

  private createFilterSegmentEquivalence(segmentEquivalenceContainer: HTMLDivElement) {
    const {segmentEquivalenceToRowMap} = this;
    const filterSegmentEquivalenceDiv = document.createElement('div');
    filterSegmentEquivalenceDiv.id = 'filter-segment-equivalence-container';
    const filterSegmentEquivalenceLabel = document.createElement('label');
    const filterSegmentEquivalence = document.createElement('input');
    filterSegmentEquivalence.placeholder = 'Enter a segment ID';
    filterSegmentEquivalence.addEventListener('input', () => {
      for (const {equivalentSegments, row} of segmentEquivalenceToRowMap.values()) {
        let segmentIDFound = false;
        const filterText = filterSegmentEquivalence.value;
        if (filterText === '') {
          segmentIDFound = true;
        } else {
          for (let i = 0; i < equivalentSegments.length; i++) {
            if (equivalentSegments[i] === filterText) {
              segmentIDFound = true;
              break;
            }
          }
        }
        if (segmentIDFound) {
          row.style.display = 'table-row';
        } else {
          row.style.display = 'none';
        }
      }
    });
    filterSegmentEquivalenceLabel.textContent = 'Find a segment ID: ';
    filterSegmentEquivalenceLabel.appendChild(filterSegmentEquivalence);
    filterSegmentEquivalenceDiv.appendChild(filterSegmentEquivalenceLabel);
    segmentEquivalenceContainer.appendChild(filterSegmentEquivalenceDiv);
  }
}
