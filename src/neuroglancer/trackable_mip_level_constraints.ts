import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {verifyNonnegativeInt, verifyOptionalNonnegativeInt} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';

export type TrackableMIPLevel = TrackableValue<number|undefined>;

export class TrackableMIPLevelConstraints extends RefCounted {
  minMIPLevel: TrackableMIPLevel;
  maxMIPLevel: TrackableMIPLevel;
  changed = new NullarySignal();
  private _numberLevels: number|undefined;
  private dispatchEnabled = true;

  constructor(
      initialMinMIPLevel: number|undefined = undefined,
      initialMaxMIPLevel: number|undefined = undefined,
      numberLevels: number|undefined = undefined) {
    super();
    this.setNumberLevels(numberLevels);
    this.verifyValidConstraints(initialMinMIPLevel, initialMaxMIPLevel);
    this.minMIPLevel = new TrackableValue(initialMinMIPLevel, verifyOptionalNonnegativeInt);
    this.maxMIPLevel = new TrackableValue(initialMaxMIPLevel, verifyOptionalNonnegativeInt);
    this.registerDisposer(this.minMIPLevel.changed.add(() => {
      this.handleMIPLevelChanged(true);
    }));
    this.registerDisposer(this.maxMIPLevel.changed.add(() => {
      this.handleMIPLevelChanged(false);
    }));
  }

  public restoreState(
      newMinMIPLevel: number|undefined = undefined, newMaxMIPLevel: number|undefined = undefined, fireDispatch: boolean = true) {
    if (this.minMIPLevel.value !== newMinMIPLevel || this.maxMIPLevel.value !== newMaxMIPLevel) {
      this.verifyValidConstraints(newMinMIPLevel, newMaxMIPLevel);
      // Turn off default behavior to always fire this.changed.dispatch exactly once
      this.dispatchEnabled = false;
      this.minMIPLevel.restoreState(newMinMIPLevel);
      this.maxMIPLevel.restoreState(newMaxMIPLevel);
      this.dispatchEnabled = true;
      if (fireDispatch) {
        this.changed.dispatch();
      }
    }
  }

  private handleMIPLevelChanged(minLevelWasChanged: boolean) {
    if (this.dispatchEnabled) {
      // If maybeAdjustConstraints returns true, then the other constraint
      // will be changed, and handleMIPLevelChanged will fire again.
      // Either way, this.changed.dispatch will fire exactly once.
      if (!this.maybeAdjustConstraints(minLevelWasChanged)) {
        this.verifyValidConstraints(this.minMIPLevel.value, this.maxMIPLevel.value);
        this.changed.dispatch();
      }
    }
  }

  get numberLevels() {
    return this._numberLevels;
  }

  // De facto min MIP level is 0 if not specified
  public getDeFactoMinMIPLevel =
      () => {
        const {minMIPLevel: {value}, _numberLevels} = this;
        verifyNonnegativeInt(_numberLevels);
        return (value !== undefined) ? value : 0;
      }

  // De facto max MIP level is numberLevels - 1 if not specified
  public getDeFactoMaxMIPLevel =
      () => {
        const {maxMIPLevel: {value}, _numberLevels} = this;
        verifyNonnegativeInt(_numberLevels);
        return (value !== undefined) ? value : _numberLevels! - 1;
      }

  // Only set the number of levels once either in constructor or after the renderLayer has been
  // initialized and sources have been retrieved.
  public setNumberLevels(numberLevels: number|undefined) {
    if (this.numberLevels !== undefined) {
      throw new Error('Cannot set number of MIP Levels more than once.');
    }
    verifyOptionalNonnegativeInt(numberLevels);
    this._numberLevels = numberLevels;
  }

  private verifyValidConstraints(
      minMIPLevelValue: number|undefined, maxMIPLevelValue: number|undefined) {
    if (minMIPLevelValue !== undefined && maxMIPLevelValue !== undefined) {
      // Should never happen
      if (minMIPLevelValue < 0) {
        throw new Error('MIPLevels must be nonnegative');
      }
      if (minMIPLevelValue > maxMIPLevelValue) {
        throw new Error('Specified minMIPLevel cannot be greater than specified maxMIPLevel');
      }
      if (this.numberLevels !== undefined && maxMIPLevelValue > this.numberLevels) {
        throw new Error('Specified maxMIPLevel cannot be greater than the number of levels');
      }
    }
  }

  // Ensure that minMIPLevelRendered <= maxMIPLevelRendered when one is adjusted by widget. Return
  // true/false to tell handleMIPLevelChange to kick off changed dispatch exactly once when levels
  // are adjusted.
  private maybeAdjustConstraints(minLevelWasChanged: boolean): boolean {
    if (this.minMIPLevel.value !== undefined && this.maxMIPLevel.value !== undefined &&
        this.minMIPLevel.value > this.maxMIPLevel.value) {
      // Invalid levels so adjust
      if (minLevelWasChanged) {
        this.maxMIPLevel.value = this.minMIPLevel.value;
      } else {
        this.minMIPLevel.value = this.maxMIPLevel.value;
      }
      return true;
    }
    return false;
  }
}
