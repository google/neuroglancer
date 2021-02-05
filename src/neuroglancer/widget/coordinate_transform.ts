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

/**
 * @file Coordinate space transform editor widget.
 */

import './coordinate_transform.css';

import svg_updateArrow from 'ikonate/icons/arrow-up.svg';
import svg_plus from 'ikonate/icons/plus.svg';
import {CoordinateSpace, CoordinateSpaceCombiner, CoordinateSpaceTransform, coordinateSpaceTransformsEquivalent, extendTransformedBoundingBoxUpToRank, getDefaultInputScale, getDimensionNameValidity, getInferredOutputScale, homogeneousTransformSubmatrix, isLocalDimension, makeCoordinateSpace, makeSingletonDimTransformedBoundingBox, newDimensionId, permuteCoordinateSpace, validateDimensionNames, WatchableCoordinateSpaceTransform} from 'neuroglancer/coordinate_transform';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {animationFrameDebounce} from 'neuroglancer/util/animation_frame_debounce';
import {arraysEqual} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent} from 'neuroglancer/util/dom';
import {ActionEvent, KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import {createIdentity, extendHomogeneousTransform, isIdentity} from 'neuroglancer/util/matrix';
import {EventActionMap, MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {formatScaleWithUnitAsString, parseScale} from 'neuroglancer/util/si_units';
import {makeIcon} from 'neuroglancer/widget/icon';

function updateInputFieldWidth(element: HTMLInputElement, value: string = element.value) {
  element.style.minWidth = (value.length + 1) + 'ch';
}

const singletonClassName = 'neuroglancer-coordinate-space-transform-singleton';

function formatBounds(lower: number, upper: number) {
  let lowerString: string;
  if (lower === Number.NEGATIVE_INFINITY) {
    lowerString = '(-∞,';
  } else {
    lowerString = `[${Math.floor(lower)},`;
  }
  let upperString: string;
  if (upper === Number.POSITIVE_INFINITY) {
    upperString = '+∞)';
  } else {
    upperString = `${Math.floor(upper)})`;
  }
  return {lower: lowerString, upper: upperString};
}

const inputEventMap = EventActionMap.fromObject({
  'arrowup': {action: 'move-up'},
  'arrowdown': {action: 'move-down'},
  'arrowleft': {action: 'move-left', preventDefault: false},
  'arrowright': {action: 'move-right', preventDefault: false},
  'enter': {action: 'commit'},
  'escape': {action: 'cancel'},
});

function makeScaleElement() {
  const cellElement = document.createElement('div');
  const inputElement = document.createElement('input');
  cellElement.classList.add('neuroglancer-coordinate-space-transform-scale-container');
  inputElement.spellcheck = false;
  inputElement.autocomplete = 'off';
  inputElement.size = 1;
  inputElement.classList.add('neuroglancer-coordinate-space-transform-scale');
  cellElement.appendChild(inputElement);
  const suggestionElement = document.createElement('div');
  const suggestionArrow = document.createElement('span');
  suggestionArrow.innerHTML = svg_updateArrow;
  suggestionElement.appendChild(suggestionArrow);
  const textNode = document.createTextNode('');
  suggestionElement.appendChild(textNode);
  suggestionElement.classList.add('neuroglancer-coordinate-space-transform-scale-suggestion');
  cellElement.appendChild(suggestionElement);
  return {cellElement, inputElement, suggestionElement};
}

function updateScaleSuggestionElement(
    suggestionElement: HTMLElement, suggested: {unit: string, scale: number}|undefined,
    existingScale: number, existingUnit: string, prefix: string) {
  if (suggested === undefined ||
      (suggested.scale === existingScale && suggested.unit === existingUnit)) {
    suggestionElement.style.display = 'none';
  } else {
    suggestionElement.style.display = '';
    const suggestedString =
        formatScaleWithUnitAsString(suggested.scale, suggested.unit, {elide1: false});
    suggestionElement.lastChild!.textContent = suggestedString;
    suggestionElement.title = `${prefix}${suggestedString}`;
  }
}

function makeOutputNameElement() {
  const inputElement = document.createElement('input');
  inputElement.spellcheck = false;
  inputElement.autocomplete = 'off';
  inputElement.size = 1;
  inputElement.placeholder = ' ';
  inputElement.classList.add('neuroglancer-coordinate-space-transform-output-name');
  return inputElement;
}

function updateCoordinateSpaceScales(
    scaleElements: HTMLInputElement[], modified: boolean[],
    watchable: WatchableValueInterface<CoordinateSpace>): boolean {
  const scalesAndUnits = scaleElements.map(x => parseScale(x.value));
  if (scalesAndUnits.includes(undefined)) {
    return false;
  }
  const newScales = Float64Array.from(scalesAndUnits, x => x!.scale);
  const newUnits = Array.from(scalesAndUnits, x => x!.unit);
  const existing = watchable.value;
  const {scales, units, rank} = existing;
  for (let i = 0; i < rank; ++i) {
    if (!modified[i]) {
      newScales[i] = scales[i];
      newUnits[i] = units[i];
    }
  }
  if (arraysEqual(scales, newScales) && arraysEqual(units, newUnits)) return false;
  const timestamps = existing.timestamps.map(
      (t, i) => (newScales[i] === scales[i] && newUnits[i] === units[i]) ? t : Date.now());
  const newSpace = makeCoordinateSpace({
    valid: existing.valid,
    rank: existing.rank,
    scales: newScales,
    units: newUnits,
    timestamps,
    ids: existing.ids,
    names: existing.names,
    boundingBoxes: existing.boundingBoxes,
    coordinateArrays: existing.coordinateArrays,
  });
  watchable.value = newSpace;
  return true;
}

function updateCoordinateSpaceSingleDimensionScale(
    space: CoordinateSpace, dimIndex: number, scale: number, unit: string): CoordinateSpace {
  const scales = new Float64Array(space.scales);
  const units = Array.from(space.units);
  if (scales[dimIndex] === scale && units[dimIndex] === unit) return space;
  const timestamps = Array.from(space.timestamps);
  scales[dimIndex] = scale;
  units[dimIndex] = unit;
  timestamps[dimIndex] = Date.now();
  return {...space, scales, units, timestamps};
}

export class CoordinateSpaceTransformWidget extends RefCounted {
  element = document.createElement('div');
  private coefficientContainer = document.createElement('div');
  private translationContainer = document.createElement('div');
  private outputNameContainer = document.createElement('div');
  private outputScaleContainer = document.createElement('div');
  private inputNameContainer = document.createElement('div');
  private inputScaleContainer = document.createElement('div');
  private inputLowerBoundsContainer = document.createElement('div');
  private inputUpperBoundsContainer = document.createElement('div');
  private coefficientElements: HTMLInputElement[] = [];
  private inputNameElements: HTMLElement[] = [];
  private outputNameElements: HTMLInputElement[] = [];
  private outputScaleElements: HTMLInputElement[] = [];
  private outputScaleSuggestionElements: HTMLElement[] = [];
  private inputScaleSuggestionElements: HTMLElement[] = [];
  private inputScaleElements: HTMLInputElement[] = [];
  private inputBoundsElements: {lower: HTMLDivElement, upper: HTMLDivElement}[] = [];
  private outputBoundsElements: {lower: HTMLDivElement, upper: HTMLDivElement}[] = [];
  private addSourceDimensionIcon = makeIcon({svg: svg_plus, text: 'S'});
  private addOutputDimensionIcon = makeIcon({svg: svg_plus, text: 'V'});
  private addOutputDimensionCell = document.createElement('div');
  private addOutputDimensionInput = makeOutputNameElement();
  private inputScaleModified: boolean[] = [];
  private outputScaleModified: boolean[] = [];
  private curSourceRank: number = -1;
  private curRank: number = -1;
  private curTransform: CoordinateSpaceTransform|undefined = undefined;
  private addingSourceDimension = false;
  private resetToIdentityButton = makeIcon({
    text: 'Set to identity',
    title: 'Reset to identity transform',
    onClick:
        () => {
          const {transform} = this;
          const rank = transform.value.rank;
          transform.transform = createIdentity(Float64Array, rank + 1);
        }
  });
  private resetToDefaultButton = makeIcon({
    text: 'Reset to default',
    title: 'Reset to default input scales, transform, and output dimensions.',
    onClick:
        () => {
          const {transform} = this;
          if (transform.mutableSourceRank) return;
          const {defaultTransform} = transform;
          let {outputSpace: newOutputSpace} = defaultTransform;
          const ids = newOutputSpace.ids.map(() => newDimensionId());
          transform.value = {
            ...defaultTransform,
            outputSpace: {
              ...newOutputSpace,
              ids,
            },
          };
        }
  });
  constructor(
      public transform: WatchableCoordinateSpaceTransform,
      public localCombiner: CoordinateSpaceCombiner,
      public globalCombiner: CoordinateSpaceCombiner) {
    super();
    const {element} = this;
    const keyboardHandler = this.registerDisposer(new KeyboardEventBinder(element, inputEventMap));
    keyboardHandler.allShortcutsAreGlobal = true;
    element.classList.add('neuroglancer-coordinate-space-transform-widget');
    this.registerDisposer(new MouseEventBinder(element, inputEventMap));
    const updateView = animationFrameDebounce(() => this.updateView());
    this.registerDisposer(transform.changed.add(updateView));
    const {
      coefficientContainer,
      translationContainer,
      outputNameContainer,
      inputNameContainer,
      inputScaleContainer,
      inputLowerBoundsContainer,
      inputUpperBoundsContainer,
      outputScaleContainer,
      addOutputDimensionCell,
      addOutputDimensionIcon,
      addSourceDimensionIcon,
      resetToIdentityButton,
      resetToDefaultButton,
    } = this;
    coefficientContainer.style.display = 'contents';
    translationContainer.style.display = 'contents';
    outputNameContainer.style.display = 'contents';
    inputNameContainer.style.display = 'contents';
    inputScaleContainer.style.display = 'contents';
    outputScaleContainer.style.display = 'contents';
    inputLowerBoundsContainer.style.display = 'contents';
    inputUpperBoundsContainer.style.display = 'contents';
    const resetButtons = document.createElement('div');
    resetButtons.classList.add('neuroglancer-coordinate-space-transform-widget-reset-buttons');
    resetToIdentityButton.classList.add(
        'neuroglancer-coordinate-space-transform-widget-reset-to-identity');
    resetToDefaultButton.classList.add(
        'neuroglancer-coordinate-space-transform-widget-reset-to-default');
    resetButtons.appendChild(resetToIdentityButton);
    resetButtons.appendChild(resetToDefaultButton);
    element.appendChild(resetButtons);


    for (const [className, textContent] of [
             ['source', 'Source dimensions'],
             ['output', 'Output dimensions'],
             ['input-lower', 'Lower'],
             ['input-upper', 'Upper'],
             ['input-scale', 'Scale'],
             ['translation', 'Translation'],
    ]) {
      const label = document.createElement('div');
      label.classList.add(`neuroglancer-coordinate-space-transform-${className}-label`);
      label.classList.add(`neuroglancer-coordinate-space-transform-label`);
      label.textContent = textContent;
      element.appendChild(label);
    }
    if (transform.mutableSourceRank) {
      addOutputDimensionCell.appendChild(addSourceDimensionIcon);
    }
    addOutputDimensionCell.appendChild(addOutputDimensionIcon);
    addOutputDimensionCell.classList.add('neuroglancer-coordinate-space-transform-output-extend');
    const extendOutputDimensionsTitle = 'Embed in additional output dimension';
    const extendSourceDimensionsTitle = 'Extend to additional source dimension';
    addOutputDimensionIcon.title = extendOutputDimensionsTitle;
    addSourceDimensionIcon.title = extendSourceDimensionsTitle;
    addOutputDimensionCell.appendChild(this.addOutputDimensionInput);
    addOutputDimensionCell.dataset.isActive = 'false';
    addOutputDimensionIcon.addEventListener('click', () => {
      this.addingSourceDimension = false;
      this.addOutputDimensionInput.title = extendOutputDimensionsTitle;
      this.addOutputDimensionCell.dataset.isActive = 'true';
      this.addOutputDimensionInput.focus();
    });
    addSourceDimensionIcon.addEventListener('click', () => {
      this.addingSourceDimension = true;
      this.addOutputDimensionInput.title = extendSourceDimensionsTitle;
      ;
      this.addOutputDimensionCell.dataset.isActive = 'true';
      this.addOutputDimensionInput.focus();
    });

    this.addOutputDimensionInput.addEventListener('blur', () => {
      this.updateAddOutputDimensionCellStyle();
    });

    element.appendChild(coefficientContainer);
    element.appendChild(outputNameContainer);
    element.appendChild(inputNameContainer);
    element.appendChild(inputScaleContainer);
    element.appendChild(outputScaleContainer);
    element.appendChild(inputLowerBoundsContainer);
    element.appendChild(inputUpperBoundsContainer);
    coefficientContainer.appendChild(translationContainer);
    element.addEventListener('input', (event: UIEvent) => {
      const {target} = event;
      if (target instanceof HTMLInputElement) {
        updateInputFieldWidth(target);

        let index = this.inputScaleElements.indexOf(target);
        if (index !== -1) {
          this.inputScaleModified[index] = true;
          this.updateScaleValidity(target);
          return;
        }

        index = this.outputScaleElements.indexOf(target);
        if (index !== -1) {
          this.outputScaleModified[index] = true;
          this.updateScaleValidity(target);
          return;
        }

        index = this.outputNameElements.indexOf(target);
        if (index !== -1) {
          this.updateOutputNameValidity();
          return;
        }

        if (this.coefficientContainer.contains(target)) {
          this.updateCoefficientValidity(target);
          return;
        }
      }
    });
    const registerMoveUpDown = (action: string, rowDelta: number, colDelta: number) => {
      registerActionListener<Event>(element, action, (event: ActionEvent<Event>) => {
        event.stopPropagation();
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (colDelta !== 0) {
          // Only move to another column if the selection is in the correct state.
          if (target.selectionStart !== target.selectionEnd ||
              target.selectionStart !== (colDelta === 1 ? target.value.length : 0)) {
            return;
          }
        }
        const gridPos = this.getElementGridPosition(target);
        if (gridPos === undefined) return;
        const newElement =
            this.getElementByGridPosition(gridPos.row + rowDelta, gridPos.col + colDelta);
        if (newElement !== null) {
          newElement.focus();
          event.preventDefault();
        }
      });
    };
    registerMoveUpDown('move-up', -1, 0);
    registerMoveUpDown('move-down', +1, 0);
    registerMoveUpDown('move-left', 0, -1);
    registerMoveUpDown('move-right', 0, +1);
    const registerFocusout = (container: HTMLDivElement, handler: (event: FocusEvent) => void) => {
      container.addEventListener('focusout', (event: FocusEvent) => {
        const {relatedTarget} = event;
        if ((relatedTarget instanceof Node) && container.contains(relatedTarget)) {
          return;
        }
        handler(event);
      });
    };
    registerFocusout(coefficientContainer, () => {
      if (!this.updateModelTransform()) {
        this.updateViewTransformCoefficients();
      }
    });
    registerFocusout(outputNameContainer, () => {
      if (!this.updateModelOutputNames()) {
        this.updateViewOutputNames();
      }
    });
    registerFocusout(inputScaleContainer, () => {
      if (!this.updateModelInputScales()) {
        this.updateViewInputScales();
      }
    });
    registerFocusout(outputScaleContainer, () => {
      if (!this.updateModelOutputScales()) {
        this.updateViewOutputScales();
      }
    });
    registerActionListener(element, 'cancel', event => {
      this.curTransform = undefined;
      this.updateView();
      (event.target! as HTMLElement).blur();
    });
    registerActionListener(coefficientContainer, 'commit', () => {
      this.updateModelTransform();
    });
    registerActionListener(outputNameContainer, 'commit', () => {
      this.updateModelOutputNames();
    });
    registerActionListener(inputScaleContainer, 'commit', () => {
      this.updateModelInputScales();
    });
    registerActionListener(outputScaleContainer, 'commit', () => {
      this.updateModelOutputScales();
    });
    element.addEventListener('focusin', (event: FocusEvent) => {
      const {target} = event;
      if (target instanceof HTMLInputElement) {
        target.select();
      }
    });
    this.updateView();
  }

  private updateWillBeDeletedAttributes(dimensionWillBeDeleted?: boolean[]) {
    const {rank} = this.transform.value;
    if (dimensionWillBeDeleted === undefined) {
      dimensionWillBeDeleted = new Array<boolean>(rank);
      dimensionWillBeDeleted.fill(false);
    }
    const {coefficientElements, inputBoundsElements, inputScaleElements} = this;
    for (let row = 0; row < rank; ++row) {
      const rowDeleted = dimensionWillBeDeleted[row];
      for (let col = 0; col <= rank; ++col) {
        const element = coefficientElements[rank * col + row];
        const colDeleted = col < rank && dimensionWillBeDeleted[col];
        element.dataset.willBeDeleted = (rowDeleted || colDeleted).toString();
      }
      inputScaleElements[row].dataset.willBeDeleted = rowDeleted.toString();
      const {lower, upper} = inputBoundsElements[row];
      lower.dataset.willBeDeleted = rowDeleted.toString();
      upper.dataset.willBeDeleted = rowDeleted.toString();
    }
  }

  private updateAddOutputDimensionCellStyle() {
    const {addOutputDimensionInput} = this;
    this.addOutputDimensionCell.dataset.isActive =
        (addOutputDimensionInput.value.length !== 0 ||
         document.activeElement === addOutputDimensionInput)
            .toString();
  }

  private updateOutputNameValidity() {
    const {outputNameElements} = this;
    const names = outputNameElements.map(x => x.value);
    const {value: {sourceRank, rank}, mutableSourceRank} = this.transform;
    if (outputNameElements.length !== rank + 1) return;
    const isValid = getDimensionNameValidity(names);
    let dimensionWillBeDeleted = new Array<boolean>(rank);
    dimensionWillBeDeleted.fill(false);
    for (let i = 0; i <= rank; ++i) {
      let valid = isValid[i];
      if (names[i].length === 0 && (mutableSourceRank || i >= sourceRank)) {
        valid = true;
        dimensionWillBeDeleted[i] = true;
      }
      outputNameElements[i].dataset.isValid = valid.toString();
    }
    this.updateWillBeDeletedAttributes(dimensionWillBeDeleted);
    this.updateAddOutputDimensionCellStyle();
  }

  private updateScaleValidity(element: HTMLInputElement) {
    const isValid = parseScale(element.value) !== undefined;
    element.dataset.isValid = isValid.toString();
  }

  private updateCoefficientValidity(element: HTMLInputElement) {
    const isValid = Number.isFinite(Number(element.value));
    element.dataset.isValid = isValid.toString();
  }

  private getElementGridPosition(element: HTMLInputElement) {
    {
      const i = this.outputNameElements.indexOf(element);
      if (i !== -1) {
        return {row: i, col: -2};
      }
    }
    {
      const i = this.inputScaleElements.indexOf(element);
      if (i !== -1) {
        return {row: -1, col: i};
      }
    }
    {
      const i = this.coefficientElements.indexOf(element);
      const {rank} = this.transform.value;
      if (i !== -1) {
        return {row: i % rank, col: Math.floor(i / rank)};
      }
    }
    {
      const i = this.outputScaleElements.indexOf(element);
      if (i !== -1) {
        return {row: i, col: -1};
      }
    }
    return undefined;
  }

  private getElementByGridPosition(row: number, col: number) {
    const {rank} = this.transform.value;
    if (row === -1) {
      if (col < 0 || col >= rank) return null;
      return this.inputScaleElements[col];
    }
    if (col === -2) {
      if (row < 0 || row > rank) return null;
      return this.outputNameElements[row];
    }
    if (col === -1) {
      if (row < 0 || row >= rank) return null;
      return this.outputScaleElements[row];
    }
    if (row < 0 || row >= rank || col < 0 || col > rank) return null;
    return this.coefficientElements[col * rank + row];
  }

  private dimensionRefCount(name: string) {
    const combiner = isLocalDimension(name) ? this.localCombiner : this.globalCombiner;
    return combiner.dimensionRefCounts.get(name) || 0;
  }

  private updateModelInputScales() {
    return updateCoordinateSpaceScales(
        this.inputScaleElements, this.inputScaleModified, this.transform.inputSpace);
  }

  private updateModelOutputScales() {
    return updateCoordinateSpaceScales(
        this.outputScaleElements, this.outputScaleModified, this.transform.outputSpace);
  }

  private updateModelOutputNames() {
    const outputNames = this.outputNameElements.map(e => e.value);
    const {value: existingValue, mutableSourceRank} = this.transform;
    const {outputSpace, rank, sourceRank} = existingValue;
    if (outputNames.length !== rank + 1) return;
    const newToOldDimensionIndices: number[] = [];
    const newNames: string[] = [];
    const add = outputNames[rank].length !== 0;
    let newSourceRank = sourceRank;
    for (let i = 0; i <= rank; ++i) {
      const name = outputNames[i];
      if (name.length === 0) {
        if (i < sourceRank) {
          if (!mutableSourceRank) return false;
          --newSourceRank;
        }
        continue;
      }
      newNames.push(name);
      newToOldDimensionIndices.push(i);
    }
    if (!validateDimensionNames(newNames)) return false;
    const existingNames = outputSpace.names;
    if (!add && arraysEqual(existingNames, newNames)) {
      // No change.
      return true;
    }

    let newInputSpace = existingValue.inputSpace;
    let newOutputSpace = existingValue.outputSpace;

    let newTransform = existingValue.transform;
    if (add) {
      if (this.addingSourceDimension) ++newSourceRank;
      const newName = outputNames[rank];
      const space =
          (isLocalDimension(newName) ? this.localCombiner : this.globalCombiner).combined.value;
      const existingIndex = space.names.indexOf(newName);
      let unit: string;
      let scale: number;
      if (existingIndex !== -1) {
        unit = space.units[existingIndex];
        scale = space.scales[existingIndex];
      } else {
        unit = '';
        scale = 1;
      }
      const boundingBoxes = newInputSpace.boundingBoxes.map(
          boundingBox => extendTransformedBoundingBoxUpToRank(boundingBox, rank, rank + 1));
      if (!this.addingSourceDimension) {
        boundingBoxes.push(makeSingletonDimTransformedBoundingBox(rank + 1, rank));
      }
      newInputSpace = makeCoordinateSpace({
        valid: newInputSpace.valid,
        rank: rank + 1,
        names: [...newInputSpace.names, ''],
        ids: [...newInputSpace.ids, newDimensionId()],
        timestamps: [...newInputSpace.timestamps, Date.now()],
        scales: Float64Array.from([...newInputSpace.scales, scale]),
        units: [...newInputSpace.units, unit],
        boundingBoxes,
        coordinateArrays: [...newInputSpace.coordinateArrays, undefined],
      });

      newOutputSpace = makeCoordinateSpace({
        valid: outputSpace.valid,
        rank: rank + 1,
        names: [...outputSpace.names, newName],
        ids: [...outputSpace.ids, newDimensionId()],
        timestamps: [...outputSpace.timestamps, Date.now()],
        scales: Float64Array.from([...outputSpace.scales, scale]),
        units: [...outputSpace.units, unit],
        coordinateArrays: [...outputSpace.coordinateArrays, undefined],
      });
      newTransform = extendHomogeneousTransform(
          new Float64Array((rank + 2) ** 2), rank + 1, newTransform, rank);
    }

    newTransform = homogeneousTransformSubmatrix(
        Float64Array, newTransform, newInputSpace.rank, newToOldDimensionIndices,
        newToOldDimensionIndices);
    newInputSpace = permuteCoordinateSpace(newInputSpace, newToOldDimensionIndices);
    newOutputSpace = permuteCoordinateSpace(newOutputSpace, newToOldDimensionIndices);

    const ids = newOutputSpace.ids.map((id, i) => {
      const oldIndex = newToOldDimensionIndices[i];
      if (oldIndex === rank) return id;
      const newName = newNames[i];
      const existingName = existingNames[oldIndex];
      return ((newName === existingName) ||
              (this.dimensionRefCount(existingName) === 1 &&
               (this.dimensionRefCount(newName) === (existingNames.includes(newName) ? 1 : 0)))) ?
          id :
          newDimensionId();
    });

    const timestamps = newOutputSpace.timestamps.map((t, i) => {
      const oldIndex = newToOldDimensionIndices[i];
      return (oldIndex === rank || newNames[i] === existingNames[oldIndex]) ? t : Date.now();
    });
    newOutputSpace = {
      ...newOutputSpace,
      names: newNames,
      ids,
      timestamps,
    };
    let newValue = {
      rank: newOutputSpace.rank,
      sourceRank: newSourceRank,
      outputSpace: newOutputSpace,
      inputSpace: newInputSpace,
      transform: newTransform
    };
    this.transform.value = newValue;
    return true;
  }

  private updateModelTransform(): boolean {
    const coefficientElements = this.coefficientElements;
    const {rank} = this.transform.value;
    const newTransform = new Float64Array((rank + 1) ** 2);
    newTransform[newTransform.length - 1] = 1;
    for (let row = 0; row < rank; ++row) {
      for (let col = 0; col <= rank; ++col) {
        const e = coefficientElements[col * rank + row];
        const v = parseFloat(e.value);
        if (!Number.isFinite(v)) {
          return false;
        }
        newTransform[col * (rank + 1) + row] = v;
      }
    }
    this.transform.transform = newTransform;
    return true;
  }

  private updateViewOutputNames() {
    const {transform: {value: {outputSpace, rank}}} = this;
    if (rank !== this.curRank) return;
    const {outputNameElements} = this;
    const {names: outputNames} = outputSpace;
    for (let outputDim = 0; outputDim < rank; ++outputDim) {
      const outputNameElement = outputNameElements[outputDim];
      outputNameElement.value = outputNames[outputDim];
      outputNameElement.dataset.isValid = 'true';
      updateInputFieldWidth(outputNameElement);
    }
    outputNameElements[rank].value = '';
    this.updateWillBeDeletedAttributes();
  }

  private updateViewTransformCoefficients() {
    const {transform: {value: {transform, rank}}} = this;
    const {coefficientElements} = this;
    for (let outputDim = 0; outputDim < rank; ++outputDim) {
      for (let inputDim = 0; inputDim <= rank; ++inputDim) {
        const coeffElement = coefficientElements[inputDim * rank + outputDim];
        coeffElement.value = transform[inputDim * (rank + 1) + outputDim].toString();
        coeffElement.dataset.isValid = 'true';
        updateInputFieldWidth(coeffElement);
      }
    }
  }

  private ensureViewRankUpdated() {
    const transform = this.transform.value;
    const {rank} = transform;
    const sourceRank = transform.sourceRank;
    if (this.curSourceRank === sourceRank && this.curRank === rank) {
      return;
    }
    const {
      inputBoundsElements,
      inputNameElements,
      inputScaleElements,
    } = this;

    const {
      element,
      coefficientElements,
      outputNameElements,
      outputScaleElements,
      outputScaleSuggestionElements,
      inputScaleSuggestionElements,
      outputBoundsElements,
      coefficientContainer,
      translationContainer,
      outputNameContainer,
      inputNameContainer,
      inputScaleContainer,
      inputLowerBoundsContainer,
      inputUpperBoundsContainer,
      outputScaleContainer,
    } = this;
    element.style.gridTemplateColumns =
        `[outputLabel headerStart] min-content [outputNames] 1fr [outputScales] 1fr [headerEnd] ` +
        `repeat(${Math.max(1, rank) + 1}, [sourceDim] 1fr)`;
    element.style.gridTemplateRows = `[sourceLabel headerStart] auto [sourceNames] ` +
        `auto [sourceLower] auto [sourceUpper] auto [sourceScales] auto [headerEnd]` +
        `repeat(${rank + 1}, [outputDim] auto)`;
    removeChildren(coefficientContainer);
    removeChildren(translationContainer);
    coefficientContainer.appendChild(translationContainer);
    removeChildren(outputNameContainer);
    removeChildren(inputNameContainer);
    removeChildren(inputScaleContainer);
    removeChildren(inputLowerBoundsContainer);
    removeChildren(inputUpperBoundsContainer);
    removeChildren(outputScaleContainer);
    inputNameElements.length = 0;
    inputScaleElements.length = 0;
    inputBoundsElements.length = 0;
    outputScaleElements.length = 0;
    outputScaleSuggestionElements.length = 0;
    inputScaleSuggestionElements.length = 0;
    coefficientElements.length = 0;
    outputNameElements.length = 0;
    outputBoundsElements.length = 0;

    for (let inputDim = 0; inputDim < rank; ++inputDim) {
      const addClasses = (element: HTMLElement) => {
        element.classList.add('neuroglancer-coordinate-space-transform-input');
        if (inputDim >= sourceRank) {
          element.classList.add(singletonClassName);
        }
      };

      {
        const cellElement = document.createElement('div');
        cellElement.classList.add('neuroglancer-coordinate-space-transform-input-name');
        addClasses(cellElement);
        cellElement.style.gridRowStart = 'sourceNames';
        cellElement.style.gridColumnStart = `sourceDim ${inputDim + 1}`;
        inputNameContainer.appendChild(cellElement);
        inputNameElements.push(cellElement);
      }
      {
        const {cellElement, inputElement, suggestionElement} = makeScaleElement();
        cellElement.classList.add('neuroglancer-coordinate-space-transform-input-scale-container');
        addClasses(cellElement);
        cellElement.style.gridRowStart = `sourceScales`;
        cellElement.style.gridColumnStart = `sourceDim ${inputDim + 1}`;
        inputScaleContainer.appendChild(cellElement);
        inputScaleElements.push(inputElement);
        inputScaleSuggestionElements.push(suggestionElement);
        const dim = inputDim;
        suggestionElement.addEventListener('click', () => {
          const suggested = getDefaultInputScale(this.transform, dim);
          if (suggested === undefined) return;
          this.transform.inputSpace.value = updateCoordinateSpaceSingleDimensionScale(
              this.transform.inputSpace.value, dim, suggested.scale, suggested.unit);
        });
      }
      {
        const lower = document.createElement('div');
        addClasses(lower);
        lower.classList.add('neuroglancer-coordinate-space-transform-input-bounds');
        lower.style.gridRowStart = `sourceLower`;
        lower.style.gridColumnStart = `sourceDim ${inputDim + 1}`;
        inputLowerBoundsContainer.appendChild(lower);
        const upper = document.createElement('div');
        addClasses(upper);
        upper.classList.add('neuroglancer-coordinate-space-transform-input-bounds');
        upper.style.gridRowStart = `sourceUpper`;
        upper.style.gridColumnStart = `sourceDim ${inputDim + 1}`;
        inputUpperBoundsContainer.appendChild(upper);
        inputBoundsElements.push({lower, upper});
      }
    }
    for (let outputDim = 0; outputDim < rank; ++outputDim) {
      for (let inputDim = 0; inputDim <= rank; ++inputDim) {
        const cellElement = document.createElement('input');
        cellElement.classList.add('neuroglancer-coordinate-space-transform-coeff');
        cellElement.spellcheck = false;
        cellElement.autocomplete = 'off';
        cellElement.size = 1;
        cellElement.style.gridRowStart = `outputDim ${outputDim + 1}`;
        cellElement.placeholder = ' ';
        cellElement.style.gridColumnStart = `sourceDim ${inputDim + 1}`;
        coefficientElements[inputDim * rank + outputDim] = cellElement;
        if (inputDim === rank) {
          cellElement.classList.add('neuroglancer-coordinate-space-transform-translation-coeff');
        } else if (inputDim == sourceRank) {
          cellElement.classList.add(singletonClassName);
        }

        ((inputDim === rank) ? translationContainer : coefficientContainer)
            .appendChild(cellElement);
      }
      {
        const {cellElement, suggestionElement, inputElement} = makeScaleElement();
        cellElement.classList.add('neuroglancer-coordinate-space-transform-output-scale-container');
        cellElement.style.gridRowStart = `outputDim ${outputDim + 1}`;
        cellElement.style.gridColumnStart = `outputScales`;
        const dim = outputDim;
        suggestionElement.addEventListener('click', () => {
          const {value: transform} = this.transform;
          const suggested = getInferredOutputScale(transform, dim);
          if (suggested === undefined) return;
          this.transform.outputSpace.value = updateCoordinateSpaceSingleDimensionScale(
              transform.outputSpace, dim, suggested.scale, suggested.unit);
        });
        outputScaleSuggestionElements.push(suggestionElement);
        outputScaleContainer.appendChild(cellElement);
        outputScaleElements.push(inputElement);
      }

      {
        const cellElement = document.createElement('div');
        cellElement.classList.add('neuroglancer-coordinate-space-transform-output-name-container');
        cellElement.style.gridRowStart = `outputDim ${outputDim + 1}`;
        cellElement.style.gridColumnStart = `outputNames`;
        const nameInput = makeOutputNameElement();
        nameInput.title = 'Rebind to a different dimension';
        if (outputDim >= sourceRank) {
          nameInput.title += `, or delete to remove singleton dimension`;
        } else if (this.transform.mutableSourceRank) {
          nameInput.title += `, or delete to remove source dimension`;
        }
        nameInput.title +=
            `.  Names ending in ' or ^ indicate dimensions local to the layer; names ending in ^ indicate channel dimensions (image layers only).`;
        outputNameElements.push(nameInput);
        outputNameContainer.appendChild(cellElement);
        cellElement.appendChild(nameInput);
        const lower = document.createElement('div');
        lower.classList.add('neuroglancer-coordinate-space-transform-output-bounds');
        cellElement.appendChild(lower);
        const upper = document.createElement('div');
        upper.classList.add('neuroglancer-coordinate-space-transform-output-bounds');
        cellElement.appendChild(upper);
        outputBoundsElements.push({lower, upper});
        cellElement.addEventListener('mousedown', event => {
          if (event.target === nameInput) return;
          nameInput.focus();
          event.preventDefault();
        });
      }
    }

    outputNameElements.push(this.addOutputDimensionInput);
    this.addOutputDimensionInput.value = '';
    outputNameContainer.appendChild(this.addOutputDimensionCell);
    this.curSourceRank = sourceRank;
    this.curRank = rank;
  }

  private updateViewInputScales() {
    this.ensureViewRankUpdated();
    this.inputScaleModified.length = 0;
    const {inputSpace, rank, sourceRank} = this.transform.value;
    const {
      inputBoundsElements,
      inputNameElements,
      inputScaleElements,
      inputScaleSuggestionElements,
    } = this;
    const {
      names: inputNames,
      scales: inputScales,
      units: inputUnits,
      bounds: {lowerBounds: inputLowerBounds, upperBounds: inputUpperBounds}
    } = inputSpace;
    for (let inputDim = 0; inputDim < rank; ++inputDim) {
      const inputScaleElement = inputScaleElements[inputDim];
      const scale = inputScales[inputDim];
      const unit = inputUnits[inputDim];
      inputScaleElement.value = formatScaleWithUnitAsString(scale, unit, {elide1: false});
      inputScaleElement.dataset.isValid = 'true';
      updateInputFieldWidth(inputScaleElement);
      let dimensionNameString: string;
      if (inputDim < sourceRank) {
        let name = inputNames[inputDim];
        if (!name) name = `${inputDim}`;
        inputNameElements[inputDim].textContent = name;
        dimensionNameString = `source dimension ${name}`;
        inputScaleElement.title = `Override scale of ${dimensionNameString}`;
      } else {
        dimensionNameString = `singleton dimension`;
        inputScaleElement.title = `Set extent of ${dimensionNameString}`;
      }
      const {lower, upper} = formatBounds(inputLowerBounds[inputDim], inputUpperBounds[inputDim]);
      const elements = inputBoundsElements[inputDim];
      elements.lower.textContent = lower;
      elements.lower.title = `Lower bound of ${dimensionNameString}`;
      elements.upper.title = `Upper bound of ${dimensionNameString}`;
      elements.upper.textContent = upper;
      updateScaleSuggestionElement(
          inputScaleSuggestionElements[inputDim], getDefaultInputScale(this.transform, inputDim),
          scale, unit, `Revert scale of ${dimensionNameString} to `);
    }
  }

  private updateViewOutputScales() {
    const {value: transform} = this.transform;
    const {
      rank,
      names,
      units: outputUnits,
      scales: outputScales,
      bounds: {lowerBounds: outputLowerBounds, upperBounds: outputUpperBounds}
    } = transform.outputSpace;
    const {outputScaleElements, outputBoundsElements, outputScaleSuggestionElements} = this;
    for (let outputDim = 0; outputDim < rank; ++outputDim) {
      const scaleElement = outputScaleElements[outputDim];
      const scale = outputScales[outputDim];
      const unit = outputUnits[outputDim];
      scaleElement.value = formatScaleWithUnitAsString(scale, unit, {elide1: false});
      updateInputFieldWidth(scaleElement);
      const name = names[outputDim];
      scaleElement.dataset.isValid = 'true';
      const titlePrefix =
          `Change coordinates of ${isLocalDimension(name) ? 'local' : 'global'} dimension ${name}`;
      scaleElement.title = `${titlePrefix} (does not rescale the source)`;
      const {lower, upper} =
          formatBounds(outputLowerBounds[outputDim], outputUpperBounds[outputDim]);
      const elements = outputBoundsElements[outputDim];
      elements.lower.textContent = lower;
      elements.upper.textContent = upper;
      updateScaleSuggestionElement(
          outputScaleSuggestionElements[outputDim], getInferredOutputScale(transform, outputDim),
          scale, unit, `${titlePrefix} to inferred scale of `);
    }
  }

  private updateResetButtonVisibility(coefficientsModified = false, dimensionsModified = false) {
    const {transform: {value: transform, mutableSourceRank, defaultTransform}} = this;
    const {rank} = transform;
    this.resetToIdentityButton.style.visibility =
        (coefficientsModified || !isIdentity(transform.transform, rank + 1, rank + 1)) ? 'visible' :
                                                                                         'hidden';
    this.resetToDefaultButton.style.visibility =
        (!mutableSourceRank &&
         (coefficientsModified || dimensionsModified ||
          !coordinateSpaceTransformsEquivalent(defaultTransform, transform))) ?
        'visible' :
        'hidden';
  }

  updateView() {
    const transform = this.transform.value;
    if (this.curTransform === transform) return;
    this.curTransform = transform;
    this.ensureViewRankUpdated();
    this.updateViewInputScales();
    this.updateViewOutputNames();
    this.updateViewTransformCoefficients();
    this.updateViewOutputScales();
    this.updateAddOutputDimensionCellStyle();
    this.updateResetButtonVisibility();
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
