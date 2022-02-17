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

import {CoordinateSpace, dimensionNamesFromJson, emptyInvalidCoordinateSpace, getBoundingBoxCenter, getCenterBound} from 'neuroglancer/coordinate_transform';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual} from 'neuroglancer/util/array';
import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat3, mat4, quat, vec3} from 'neuroglancer/util/geom';
import {parseArray, parseFiniteVec, verifyFiniteFloat, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {optionallyRestoreFromJsonMember, Trackable} from 'neuroglancer/util/trackable';
import {TrackableEnum} from 'neuroglancer/util/trackable_enum';
import * as vector from 'neuroglancer/util/vector';

export enum NavigationLinkType {
  LINKED = 0,
  RELATIVE = 1,
  UNLINKED = 2,
}

export enum NavigationSimpleLinkType {
  LINKED = 0,
  UNLINKED = 2,
}

export class TrackableNavigationLink extends TrackableEnum<NavigationLinkType> {
  constructor(value = NavigationLinkType.LINKED) {
    super(NavigationLinkType, value);
  }
}

export class TrackableNavigationSimpleLink extends TrackableEnum<NavigationSimpleLinkType> {
  constructor(value = NavigationSimpleLinkType.LINKED) {
    super(NavigationSimpleLinkType, value);
  }
}

const tempVec3 = vec3.create();
const tempQuat = quat.create();

function makeLinked<T extends RefCounted&{changed: NullarySignal}, Difference>(
    self: T, peer: T, link: TrackableNavigationLink, operations: {
      assign: (target: T, source: T) => void,
      isValid: (a: T) => boolean,
      difference: (a: T, b: T) => Difference,
      add: (target: T, source: T, amount: Difference) => void,
      subtract: (target: T, source: T, amount: Difference) => void
    }): T {
  let updatingSelf = false;
  let updatingPeer = false;
  let selfMinusPeer: Difference|undefined;
  self.registerDisposer(peer);
  const handlePeerUpdate = () => {
    if (updatingPeer) {
      return;
    }
    updatingSelf = true;
    switch (link.value) {
      case NavigationLinkType.UNLINKED:
        if (operations.isValid(self)) {
          break;
        } else {
          // Fallthrough to LINKED case.
        }
      case NavigationLinkType.LINKED:
        operations.assign(self, peer);
        break;
      case NavigationLinkType.RELATIVE:
        operations.add(self, peer, selfMinusPeer!);
        break;
    }
    updatingSelf = false;
  };
  const handleSelfUpdate = () => {
    if (updatingSelf) {
      return;
    }
    switch (link.value) {
      case NavigationLinkType.UNLINKED:
        break;
      case NavigationLinkType.LINKED:
        operations.assign(peer, self);
        break;
      case NavigationLinkType.RELATIVE:
        operations.subtract(peer, self, selfMinusPeer!);
        break;
    }
  };
  let previousLinkValue = NavigationLinkType.UNLINKED;
  const handleLinkUpdate = () => {
    const linkValue = link.value;
    if (linkValue !== previousLinkValue) {
      switch (linkValue) {
        case NavigationLinkType.UNLINKED:
          selfMinusPeer = undefined;
          break;
        case NavigationLinkType.LINKED:
          selfMinusPeer = undefined;
          operations.assign(self, peer);
          break;
        case NavigationLinkType.RELATIVE:
          selfMinusPeer = operations.difference(self, peer);
          break;
      }
    }
    previousLinkValue = linkValue;
    self.changed.dispatch();
  };
  self.registerDisposer(self.changed.add(handleSelfUpdate));
  self.registerDisposer(peer.changed.add(handlePeerUpdate));
  self.registerDisposer(link.changed.add(handleLinkUpdate));
  handleLinkUpdate();
  return self;
}

function makeSimpleLinked<T extends RefCounted&{changed: NullarySignal}>(
    self: T, peer: T, link: TrackableNavigationSimpleLink, operations: {
      assign: (target: T, source: T) => void,
      isValid: (a: T) => boolean,
    }) {
  return makeLinked(self, peer, link as any, operations as any);
}

export class Position extends RefCounted {
  private coordinates_: Float32Array = vector.kEmptyFloat32Vec;
  private curCoordinateSpace: CoordinateSpace|undefined;
  changed = new NullarySignal();
  constructor(public coordinateSpace: WatchableValueInterface<CoordinateSpace>) {
    super();
    this.registerDisposer(coordinateSpace.changed.add(() => {
      this.handleCoordinateSpaceChanged();
    }));
  }

  get valid() {
    return this.coordinateSpace.value.valid;
  }

  /**
   * Returns the position in voxels.
   */
  get value() {
    this.handleCoordinateSpaceChanged();
    return this.coordinates_;
  }

  reset() {
    this.curCoordinateSpace = undefined;
    this.coordinates_ = vector.kEmptyFloat32Vec;
    this.changed.dispatch();
  }

  set value(coordinates: Float32Array) {
    const {curCoordinateSpace} = this;
    if (curCoordinateSpace === undefined || !curCoordinateSpace.valid ||
        curCoordinateSpace.rank !== coordinates.length) {
      return;
    }
    const {coordinates_} = this;
    coordinates_.set(coordinates);
    this.changed.dispatch();
  }

  private handleCoordinateSpaceChanged() {
    const coordinateSpace = this.coordinateSpace.value;
    const prevCoordinateSpace = this.curCoordinateSpace;
    if (coordinateSpace === prevCoordinateSpace) return;
    this.curCoordinateSpace = coordinateSpace;
    const {rank} = coordinateSpace;
    if (!coordinateSpace.valid) return;
    if (prevCoordinateSpace === undefined || !prevCoordinateSpace.valid) {
      let {coordinates_} = this;
      if (coordinates_ !== undefined && coordinates_.length === rank) {
        // Use the existing voxel coordinates if rank is the same.  Otherwise, ignore.
      } else {
        coordinates_ = this.coordinates_ = new Float32Array(rank);
        getBoundingBoxCenter(coordinates_, coordinateSpace.bounds);
        for (let i = 0; i < rank; ++i) {
          coordinates_[i] = Math.floor(coordinates_[i]) + 0.5;
        }
      }
      this.changed.dispatch();
      return;
    }
    // Match dimensions by ID.
    const newCoordinates = new Float32Array(rank);
    const prevCoordinates = this.coordinates_;
    const {ids, scales: newScales} = coordinateSpace;
    const {ids: prevDimensionIds, scales: oldScales} = prevCoordinateSpace;
    for (let newDim = 0; newDim < rank; ++newDim) {
      const newDimId = ids[newDim];
      const oldDim = prevDimensionIds.indexOf(newDimId);
      if (oldDim === -1) {
        newCoordinates[newDim] = getCenterBound(
            coordinateSpace.bounds.lowerBounds[newDim], coordinateSpace.bounds.upperBounds[newDim]);
      } else {
        newCoordinates[newDim] = prevCoordinates[oldDim] * (oldScales[oldDim] / newScales[newDim]);
      }
    }
    this.coordinates_ = newCoordinates;
    this.changed.dispatch();
  }

  toJSON() {
    if (!this.valid && this.coordinates_.length === 0) return undefined;
    this.handleCoordinateSpaceChanged();
    const {value} = this;
    if (value.length === 0) return undefined;
    return Array.from(value);
  }

  restoreState(obj: any) {
    if (obj === undefined) {
      this.reset();
      return;
    }
    this.curCoordinateSpace = undefined;
    this.coordinates_ = Float32Array.from(parseArray(obj, verifyFiniteFloat));
    this.handleCoordinateSpaceChanged();
    this.changed.dispatch();
  }

  snapToVoxel() {
    this.handleCoordinateSpaceChanged();
    const {coordinates_} = this;
    const rank = coordinates_.length;
    for (let i = 0; i < rank; ++i) {
      coordinates_[i] = Math.floor(coordinates_[i]) + 0.5;
    }
    this.changed.dispatch();
  }

  assign(other: Borrowed<Position>) {
    other.handleCoordinateSpaceChanged();
    const {curCoordinateSpace, coordinates_} = other;
    this.curCoordinateSpace = curCoordinateSpace;
    this.coordinates_ = Float32Array.from(coordinates_);
    this.changed.dispatch();
  }

  /**
   * Get the offset of `a` relative to `b`.
   */
  static getOffset(a: Position, b: Position): Float32Array|undefined {
    const aCoordinates = a.coordinates_;
    const bCoordinates = b.coordinates_;
    const rank = aCoordinates.length;
    if (rank === bCoordinates.length) {
      return vector.subtract(new Float32Array(aCoordinates.length), aCoordinates, bCoordinates);
    }
    return undefined;
  }
  static addOffset(
      target: Position, source: Position, offset: Float32Array|undefined, scale: number = 1): void {
    target.handleCoordinateSpaceChanged();
    const {value: sourceCoordinates} = source;
    if (offset !== undefined && sourceCoordinates.length === offset.length) {
      vector.scaleAndAdd(target.value, sourceCoordinates, offset, scale);
      target.changed.dispatch();
    }
  }

  get legacyJsonView() {
    const self = this;
    return {
      changed: self.changed,
      toJSON() {
        return self.toJSON();
      },
      reset() {
        self.reset();
      },
      restoreState(obj: unknown) {
        if (obj === undefined || Array.isArray(obj)) {
          self.restoreState(obj);
          return;
        }
        verifyObject(obj);
        optionallyRestoreFromJsonMember(obj, 'voxelCoordinates', self);
      },
    };
  }
}

type TrackableLinkInterface = TrackableNavigationLink|TrackableNavigationSimpleLink;

function restoreLinkedFromJson(
    link: TrackableLinkInterface, value: {restoreState(obj: unknown): void}, json: any) {
  if (json === undefined || Object.keys(json).length === 0) {
    link.value = NavigationLinkType.LINKED;
    return;
  }
  verifyObject(json);
  link.value = NavigationLinkType.UNLINKED;
  verifyObjectProperty(json, 'value', x => {
    if (x !== undefined) {
      value.restoreState(x);
    }
  });
  verifyObjectProperty(json, 'link', x => link.restoreState(x));
}

interface LinkableState<T> extends RefCounted, Trackable {
  assign(other: T): void;
}

abstract class LinkedBase<T extends LinkableState<T>,
                                    Link extends TrackableLinkInterface = TrackableNavigationLink>
    implements Trackable {
  value: T;
  get changed() {
    return this.value.changed;
  }
  constructor(public peer: Owned<T>, public link: Link = new TrackableNavigationLink() as any) {}

  toJSON() {
    const {link} = this;
    if (link.value === NavigationLinkType.LINKED) {
      return undefined;
    }
    return {link: link.toJSON(), value: this.getValueJson()};
  }

  protected getValueJson(): any {
    return this.value.toJSON();
  }

  reset() {
    this.link.value = NavigationLinkType.LINKED;
  }

  restoreState(obj: any) {
    restoreLinkedFromJson(this.link, this.value, obj);
  }

  copyToPeer() {
    if (this.link.value !== NavigationLinkType.LINKED) {
      this.link.value = NavigationLinkType.UNLINKED;
      this.peer.assign(this.value);
      this.link.value = NavigationLinkType.LINKED;
    }
  }
}

abstract class SimpleLinkedBase<T extends RefCounted&Trackable&{assign(other: T): void}> extends
    LinkedBase<T, TrackableNavigationSimpleLink> implements Trackable {
  constructor(peer: Owned<T>, link = new TrackableNavigationSimpleLink()) {
    super(peer, link);
  }
}


export class LinkedPosition extends LinkedBase<Position> {
  value = makeLinked(new Position(this.peer.coordinateSpace), this.peer, this.link, {
    assign: (a: Position, b: Position) => a.assign(b),
    isValid:
        (a: Position) => {
          return a.valid;
        },
    difference: Position.getOffset,
    add: Position.addOffset,
    subtract:
        (target: Position, source: Position, amount: Float32Array|undefined) => {
          Position.addOffset(target, source, amount, -1);
        },
  });
}

function quaternionIsIdentity(q: quat) {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

export class OrientationState extends RefCounted {
  orientation: quat;
  changed = new NullarySignal();

  constructor(orientation?: quat) {
    super();
    if (orientation == null) {
      orientation = quat.create();
    }
    this.orientation = orientation;
  }
  toJSON() {
    let {orientation} = this;
    quat.normalize(this.orientation, this.orientation);
    if (quaternionIsIdentity(orientation)) {
      return undefined;
    }
    return Array.prototype.slice.call(this.orientation);
  }
  restoreState(obj: any) {
    try {
      parseFiniteVec(this.orientation, obj);
      quat.normalize(this.orientation, this.orientation);
    } catch (ignoredError) {
      quat.identity(this.orientation);
    }
    this.changed.dispatch();
  }

  reset() {
    quat.identity(this.orientation);
    this.changed.dispatch();
  }

  snap() {
    let mat = mat3.create();
    mat3.fromQuat(mat, this.orientation);
    let usedAxes = [false, false, false];
    for (let i = 0; i < 3; ++i) {
      let maxComponent = 0;
      let argmaxComponent = 0;
      for (let j = 0; j < 3; ++j) {
        let value = mat[i * 3 + j];
        mat[i * 3 + j] = 0;
        if (usedAxes[j]) {
          continue;
        }
        if (Math.abs(value) > Math.abs(maxComponent)) {
          maxComponent = value;
          argmaxComponent = j;
        }
      }
      mat[i * 3 + argmaxComponent] = Math.sign(maxComponent);
      usedAxes[argmaxComponent] = true;
    }
    quat.fromMat3(this.orientation, mat);
    this.changed.dispatch();
  }

  /**
   * Returns a new OrientationState with orientation fixed to peerToSelf * peer.orientation.  Any
   * changes to the returned OrientationState will cause a corresponding change in peer, and vice
   * versa.
   */
  static makeRelative(peer: OrientationState, peerToSelf: quat) {
    let self = new OrientationState(quat.multiply(quat.create(), peer.orientation, peerToSelf));
    let updatingPeer = false;
    self.registerDisposer(peer.changed.add(() => {
      if (!updatingPeer) {
        updatingSelf = true;
        quat.multiply(self.orientation, peer.orientation, peerToSelf);
        self.changed.dispatch();
        updatingSelf = false;
      }
    }));
    let updatingSelf = false;
    const selfToPeer = quat.invert(quat.create(), peerToSelf);
    self.registerDisposer(self.changed.add(() => {
      if (!updatingSelf) {
        updatingPeer = true;
        quat.multiply(peer.orientation, self.orientation, selfToPeer);
        peer.changed.dispatch();
        updatingPeer = false;
      }
    }));
    return self;
  }

  assign(other: Borrowed<OrientationState>) {
    quat.copy(this.orientation, other.orientation);
    this.changed.dispatch();
  }
}

export class LinkedOrientationState extends LinkedBase<OrientationState> {
  value = makeLinked(new OrientationState(), this.peer, this.link, {
    assign: (a: OrientationState, b: OrientationState) => a.assign(b),
    isValid: () => true,
    difference:
        (a: OrientationState, b: OrientationState) => {
          const temp = quat.create();
          return quat.multiply(temp, quat.invert(temp, b.orientation), a.orientation);
        },
    add:
        (target: OrientationState, source: OrientationState, amount: quat) => {
          quat.multiply(target.orientation, source.orientation, amount);
          target.changed.dispatch();
        },
    subtract:
        (target: OrientationState, source: OrientationState, amount: quat) => {
          quat.multiply(target.orientation, source.orientation, quat.invert(tempQuat, amount));
          target.changed.dispatch();
        }
  });
}

export interface RelativeDisplayScales {
  /**
   * Array of length `coordinateSpace.rank` specifying scale factors on top of (will be multiply by)
   * `coordinateSpace.scales` to use for display purposes.  This allows non-uniform zooming.
   */
  factors: Float64Array;
}

export class TrackableRelativeDisplayScales extends RefCounted implements
    Trackable, WatchableValueInterface<RelativeDisplayScales> {
  changed = new NullarySignal();
  private curCoordinateSpace = emptyInvalidCoordinateSpace;
  private value_: RelativeDisplayScales = {factors: new Float64Array(0)};
  constructor(public coordinateSpace: WatchableValueInterface<CoordinateSpace>) {
    super();
    this.registerDisposer(coordinateSpace.changed.add(() => this.update()));
    this.update();
  }

  get value() {
    return this.update();
  }

  reset() {
    this.value_ = {factors: new Float64Array(0)};
    this.curCoordinateSpace = emptyInvalidCoordinateSpace;
    this.changed.dispatch();
  }

  toJSON() {
    const json: any = {};
    let nonEmpty = false;
    const {value} = this;
    const {factors} = value;
    const {names, rank} = this.curCoordinateSpace;
    for (let i = 0; i < rank; ++i) {
      const factor = factors[i];
      if (factor === 1) continue;
      json[names[i]] = factor;
      nonEmpty = true;
    }
    if (nonEmpty) return json;
    return undefined;
  }

  restoreState(json: unknown) {
    const {coordinateSpace: {value: coordinateSpace}} = this;
    const {names, rank} = coordinateSpace;
    const factors = new Float64Array(rank);
    factors.fill(-1);
    if (json !== undefined) {
      const obj = verifyObject(json);
      for (let i = 0; i < rank; ++i) {
        factors[i] = verifyObjectProperty(
            obj, names[i], x => x === undefined ? 1 : verifyFinitePositiveFloat(x));
      }
    }
    this.value_ = {factors};
    this.curCoordinateSpace = coordinateSpace;
    this.changed.dispatch();
  }

  setFactors(factors: Float64Array) {
    const {coordinateSpace: {value: coordinateSpace}} = this;
    if (factors.length !== coordinateSpace.rank) return;
    this.value_ = {factors};
    this.curCoordinateSpace = coordinateSpace;
    this.changed.dispatch();
  }

  private update() {
    const {coordinateSpace: {value: coordinateSpace}} = this;
    let value = this.value_;
    const {curCoordinateSpace} = this;
    if (curCoordinateSpace === coordinateSpace) return value;
    const {ids: oldDimensionIds} = curCoordinateSpace;
    const {ids: newDimensionIds, rank} = coordinateSpace;
    const oldFactors = value.factors;
    const newFactors = new Float64Array(rank);
    newFactors.fill(1);
    for (let i = 0; i < rank; ++i) {
      const id = newDimensionIds[i];
      const oldIndex = oldDimensionIds.indexOf(id);
      if (oldIndex === -1) continue;
      newFactors[i] = oldFactors[oldIndex];
    }
    if (arraysEqual(newFactors, oldFactors)) return value;
    value = this.value_ = {factors: newFactors};
    this.curCoordinateSpace = coordinateSpace;
    this.changed.dispatch();
    return value;
  }

  assign(other: TrackableRelativeDisplayScales) {
    this.setFactors(other.value.factors);
  }
}

function mapPerDimensionValues<T, A extends {length: number, [index: number]: T},
                                            C extends {new (n: number): A}>(
    arrayConstructor: C, input: A, oldCoordinateSpace: CoordinateSpace,
    newCoordinateSpace: CoordinateSpace, defaultValue: (index: number) => T): A {
  if (oldCoordinateSpace === newCoordinateSpace) return input;
  const {ids: oldDimensionIds} = oldCoordinateSpace;
  const {rank: newRank, ids: newDimensionIds} = newCoordinateSpace;
  const output = new arrayConstructor(newRank);
  for (let newDim = 0; newDim < newRank; ++newDim) {
    const id = newDimensionIds[newDim];
    const oldDim = oldDimensionIds.indexOf(id);
    output[newDim] = (oldDim === -1) ? defaultValue(newDim) : input[oldDim];
  }
  return output;
}

export class LinkedRelativeDisplayScales extends LinkedBase<TrackableRelativeDisplayScales> {
  value = makeLinked(
      new TrackableRelativeDisplayScales(this.peer.coordinateSpace), this.peer, this.link, {
        assign: (target, source) => target.assign(source),
        difference:
            (a, b) => {
              const {factors: fa} = a.value;
              const coordinateSpace = a.coordinateSpace.value;
              const fb = b.value.factors;
              return {
                coordinateSpace,
                offsets: vector.subtract(new Float64Array(fa.length), fa, fb)
              };
            },
        add:
            (target, source, delta: {offsets: Float64Array, coordinateSpace: CoordinateSpace}) => {
              const newOffsets = mapPerDimensionValues(
                  Float64Array, delta.offsets, delta.coordinateSpace, target.coordinateSpace.value,
                  () => 0);
              target.setFactors(vector.add(
                  new Float64Array(newOffsets.length), newOffsets, source.value.factors));
            },
        subtract:
            (target, source, delta: {offsets: Float64Array, coordinateSpace: CoordinateSpace}) => {
              const newOffsets = mapPerDimensionValues(
                  Float64Array, delta.offsets, delta.coordinateSpace, target.coordinateSpace.value,
                  () => 0);
              target.setFactors(vector.subtract(
                  new Float64Array(newOffsets.length), source.value.factors, newOffsets));
            },
        isValid: () => true,
      });
}

export interface DisplayDimensionRenderInfo {
  /**
   * Number of global dimensions.
   */
  globalRank: number;

  /**
   * Array of length `globalRank` specifying global dimension names.
   */
  globalDimensionNames: readonly string[];

  /**
   * Number of displayed dimensions.  Must be <= 3.
   */
  displayRank: number;

  /**
   * Array of length 3.  The first `displayRank` elements specify the indices of the the global
   * dimensions that are displayed.  The remaining elements are `-1`.
   */
  displayDimensionIndices: Int32Array;

  /**
   * Array of length 3.  `voxelPhysicalScales[i]` equals
   * `relativeDisplayScales[d] * coordinateSpace.scales[d]`,
   * where `d = displayDimensionIndices[i]`, or `1` for `i >= rank`.
   */
  voxelPhysicalScales: Float64Array;

  /**
   * Unit corresponding to each dimension in `displayDimensionIndices`.  `displayDimensionUnits[i]`
   * is equal to `coordinateSpace.units[displayDimensionIndices[i]]`, or `''` if
   * `displayDimensionIndices[i] == -1`.
   */
  displayDimensionUnits: readonly string[];

  /**
   * Scale corresponding to each dimension in `displayDimensionIndices`.
   * `displayDimensionScales[i]` is equal to `coordinateSpace.scales[displayDimensionIndices[i]]`,
   * or `1` if `displayDimensionIndices[i] == -1`.
   */
  displayDimensionScales: Float64Array;

  /**
   * Physical scale corresponding to the canonical voxel.  Equal to minimum of
   * `voxelPhysicalScales.slice(0, rank)`, or `1` if `rank == 0`.
   */
  canonicalVoxelPhysicalSize: number;

  /**
   * Array of length 3.  Amount by which the voxel coordinates of each display dimensions must be
   * multiplied to convert to canonical voxels.  canonicalVoxelFactors[i] = voxelPhysicalScales[d] /
   * canonicalVoxelPhysicalSize, where d = dimensionIndices[i], or `1` for `i >= rank`.
   */
  canonicalVoxelFactors: Float64Array;
}

function getDisplayDimensionRenderInfo(
    coordinateSpace: CoordinateSpace, displayDimensions: DisplayDimensions,
    relativeDisplayScales: RelativeDisplayScales): DisplayDimensionRenderInfo {
  const {rank: globalRank, names: globalDimensionNames, units} = coordinateSpace;
  const {displayRank, displayDimensionIndices} = displayDimensions;
  const canonicalVoxelFactors = new Float64Array(3);
  let voxelPhysicalScales = new Float64Array(3);
  let canonicalVoxelPhysicalSize: number;
  const {factors} = relativeDisplayScales;
  const displayDimensionUnits = new Array<string>(3);
  const displayDimensionScales = new Float64Array(3);
  canonicalVoxelFactors.fill(1);
  voxelPhysicalScales.fill(1);
  displayDimensionScales.fill(1);
  displayDimensionUnits.fill('');
  if (displayRank === 0) {
    canonicalVoxelPhysicalSize = 1;
  } else {
    canonicalVoxelPhysicalSize = Number.POSITIVE_INFINITY;
    const {scales} = coordinateSpace;
    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      const s = voxelPhysicalScales[i] = factors[dim] * scales[dim];
      canonicalVoxelPhysicalSize = Math.min(canonicalVoxelPhysicalSize, s);
      displayDimensionUnits[i] = units[dim];
      displayDimensionScales[i] = scales[dim];
    }
    for (let i = 0; i < displayRank; ++i) {
      canonicalVoxelFactors[i] = voxelPhysicalScales[i] / canonicalVoxelPhysicalSize;
    }
  }
  return {
    globalRank,
    globalDimensionNames,
    displayRank,
    displayDimensionIndices,
    displayDimensionUnits,
    displayDimensionScales,
    canonicalVoxelFactors,
    voxelPhysicalScales,
    canonicalVoxelPhysicalSize,
  };
}

export function displayDimensionRenderInfosEqual(
    a: DisplayDimensionRenderInfo, b: DisplayDimensionRenderInfo) {
  return arraysEqual(a.globalDimensionNames, b.globalDimensionNames) &&
      arraysEqual(a.displayDimensionIndices, b.displayDimensionIndices) &&
      arraysEqual(a.canonicalVoxelFactors, b.canonicalVoxelFactors) &&
      arraysEqual(a.voxelPhysicalScales, b.voxelPhysicalScales) &&
      a.canonicalVoxelPhysicalSize === b.canonicalVoxelPhysicalSize &&
      arraysEqual(a.displayDimensionUnits, b.displayDimensionUnits) &&
      arraysEqual(a.displayDimensionScales, b.displayDimensionScales);
}

export class WatchableDisplayDimensionRenderInfo extends RefCounted {
  changed = new NullarySignal();
  private curRelativeDisplayScales: RelativeDisplayScales = this.relativeDisplayScales.value;
  private curDisplayDimensions: DisplayDimensions = this.displayDimensions.value;
  private curCoordinateSpace: CoordinateSpace = this.relativeDisplayScales.coordinateSpace.value;
  private value_: DisplayDimensionRenderInfo = getDisplayDimensionRenderInfo(
      this.curCoordinateSpace, this.curDisplayDimensions, this.curRelativeDisplayScales);
  get value() {
    const {
      relativeDisplayScales:
          {value: relativeDisplayScales, coordinateSpace: {value: coordinateSpace}},
      displayDimensions: {value: displayDimensions},
      curRelativeDisplayScales,
      curDisplayDimensions,
      curCoordinateSpace,
    } = this;
    let value = this.value_;
    if (curRelativeDisplayScales !== relativeDisplayScales ||
        curDisplayDimensions !== displayDimensions || curCoordinateSpace !== coordinateSpace) {
      this.curRelativeDisplayScales = relativeDisplayScales;
      this.curDisplayDimensions = displayDimensions;
      this.curCoordinateSpace = coordinateSpace;
      const newValue =
          getDisplayDimensionRenderInfo(coordinateSpace, displayDimensions, relativeDisplayScales);
      if (!displayDimensionRenderInfosEqual(value, newValue)) {
        this.value_ = value = newValue;
        this.changed.dispatch();
      }
    }
    return value;
  }
  constructor(
      public relativeDisplayScales: Owned<TrackableRelativeDisplayScales>,
      public displayDimensions: Owned<TrackableDisplayDimensions>) {
    super();
    this.registerDisposer(relativeDisplayScales);
    this.registerDisposer(displayDimensions);
    const maybeUpdateValue = () => {
      this.value;
    };
    this.registerDisposer(relativeDisplayScales.changed.add(maybeUpdateValue));
    this.registerDisposer(displayDimensions.changed.add(maybeUpdateValue));
  }
}

export interface DisplayDimensions {
  coordinateSpace: CoordinateSpace;
  displayRank: number;
  displayDimensionIndices: Int32Array;
}

export class TrackableDisplayDimensions extends RefCounted implements Trackable {
  changed = new NullarySignal();
  private default_ = true;
  private value_: DisplayDimensions|undefined = undefined;

  constructor(public coordinateSpace: WatchableValueInterface<CoordinateSpace>) {
    super();
    this.registerDisposer(this.coordinateSpace.changed.add(this.changed.dispatch));
    this.update();
  }

  get value() {
    this.update();
    return this.value_!;
  }

  private update() {
    const {coordinateSpace: {value: coordinateSpace}} = this;
    const value = this.value_;
    if (value !== undefined && value.coordinateSpace === coordinateSpace) {
      return;
    }
    if (value === undefined || this.default_) {
      this.setToDefault(coordinateSpace);
      return;
    }
    const newDimensionIndices = new Int32Array(3);
    const {ids: oldDimensionIds} = value.coordinateSpace;
    const {ids: newDimensionIds} = coordinateSpace;
    const oldDimensionIndices = value.displayDimensionIndices;
    const oldRank = value.displayRank;
    let newRank = 0;
    for (let i = 0; i < oldRank; ++i) {
      const newDim = newDimensionIds.indexOf(oldDimensionIds[oldDimensionIndices[i]]);
      if (newDim === -1) continue;
      newDimensionIndices[newRank] = newDim;
      ++newRank;
    }
    newDimensionIndices.fill(-1, newRank);
    if (newRank === 0) {
      this.default_ = true;
      this.setToDefault(coordinateSpace);
      return;
    }
    this.assignValue(coordinateSpace, newRank, newDimensionIndices);
    this.changed.dispatch();
  }

  private setToDefault(coordinateSpace: CoordinateSpace) {
    const displayRank = Math.min(coordinateSpace.rank, 3);
    const displayDimensionIndices = new Int32Array(3);
    displayDimensionIndices.fill(-1);
    for (let i = 0; i < displayRank; ++i) {
      displayDimensionIndices[i] = i;
    }
    this.assignValue(coordinateSpace, displayRank, displayDimensionIndices);
  }

  private assignValue(
      coordinateSpace: CoordinateSpace, displayRank: number, displayDimensionIndices: Int32Array) {
    this.value_ = {
      coordinateSpace,
      displayRank,
      displayDimensionIndices,
    };
    this.changed.dispatch();
  }

  reset() {
    this.default_ = true;
    this.value_ = undefined;
    this.changed.dispatch();
  }

  restoreState(obj: any) {
    if (obj === undefined) {
      this.reset();
      return;
    }
    const displayDimensionNames = dimensionNamesFromJson(obj);
    if (displayDimensionNames.length > 3) {
      throw new Error('Number of spatial dimensions must be <= 3');
    }
    const {coordinateSpace: {value: coordinateSpace}} = this;
    const displayDimensionIndices = new Int32Array(3);
    displayDimensionIndices.fill(-1);
    const {names} = coordinateSpace;
    let displayRank = 0;
    for (const name of displayDimensionNames) {
      const index = names.indexOf(name);
      if (index === -1) continue;
      displayDimensionIndices[displayRank++] = index;
    }
    if (displayRank === 0) {
      this.reset();
      return;
    }
    this.default_ = false;
    this.assignValue(coordinateSpace, displayRank, displayDimensionIndices);
  }

  get default() {
    this.update();
    return this.default_;
  }

  set default(value: boolean) {
    if (this.default_ === value) return;
    if (value) {
      this.default_ = true;
      this.setToDefault(this.coordinateSpace.value);
    } else {
      this.default_ = false;
      this.changed.dispatch();
    }
  }

  setDimensionIndices(rank: number, dimensionIndices: Int32Array) {
    this.default_ = false;
    this.assignValue(this.coordinateSpace.value, rank, dimensionIndices);
  }

  toJSON() {
    if (this.default_) return undefined;
    const {value} = this;
    const displayDimensionNames: string[] = [];
    const {displayRank, displayDimensionIndices, coordinateSpace: {names}} = value;
    if (displayRank === 0) return undefined;
    for (let i = 0; i < displayRank; ++i) {
      displayDimensionNames[i] = names[displayDimensionIndices[i]];
    }
    return displayDimensionNames;
  }

  assign(other: TrackableDisplayDimensions) {
    if (other.default) {
      this.default = true;
    } else {
      const {displayRank, displayDimensionIndices} = other.value;
      this.setDimensionIndices(displayRank, displayDimensionIndices);
    }
  }
}

export class LinkedDisplayDimensions extends SimpleLinkedBase<TrackableDisplayDimensions> {
  value = makeSimpleLinked(
      new TrackableDisplayDimensions(this.peer.coordinateSpace), this.peer, this.link, {
        assign: (target, source) => target.assign(source),
        isValid: () => true,
      });
  constructor(peer: Owned<TrackableDisplayDimensions>) {
    super(peer);
  }
}

export class DisplayPose extends RefCounted {
  changed = new NullarySignal();

  get displayDimensions(): Borrowed<TrackableDisplayDimensions> {
    return this.displayDimensionRenderInfo.displayDimensions;
  }

  get relativeDisplayScales(): Borrowed<TrackableRelativeDisplayScales> {
    return this.displayDimensionRenderInfo.relativeDisplayScales;
  }

  constructor(
      public position: Owned<Position>,
      public displayDimensionRenderInfo: WatchableDisplayDimensionRenderInfo,
      public orientation: Owned<OrientationState>) {
    super();
    this.registerDisposer(position);
    this.registerDisposer(orientation);
    this.registerDisposer(displayDimensionRenderInfo);
    this.registerDisposer(position.changed.add(this.changed.dispatch));
    this.registerDisposer(orientation.changed.add(this.changed.dispatch));
    this.registerDisposer(displayDimensionRenderInfo.changed.add(this.changed.dispatch));
  }

  get valid() {
    return this.position.valid;
  }

  /**
   * Resets everything.
   */
  reset() {
    this.position.reset();
    this.orientation.reset();
    this.displayDimensions.reset();
  }

  updateDisplayPosition(fun: (pos: vec3) => boolean | void, temp: vec3 = tempVec3): boolean {
    const {coordinateSpace: {value: coordinateSpace}, value: voxelCoordinates} = this.position;
    const {displayDimensionIndices, displayRank} = this.displayDimensions.value;
    if (coordinateSpace === undefined) return false;
    temp.fill(0);
    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      temp[i] = voxelCoordinates[dim];
    }
    if (fun(temp) !== false) {
      for (let i = 0; i < displayRank; ++i) {
        const dim = displayDimensionIndices[i];
        voxelCoordinates[dim] = temp[i];
      }
      this.position.changed.dispatch();
      return true;
    }
    return false;
  }

  // Transform from view coordinates to global spatial coordinates.
  toMat4(mat: mat4, zoom: number) {
    mat4.fromQuat(mat, this.orientation.orientation);
    const {value: voxelCoordinates} = this.position;
    const {canonicalVoxelFactors, displayDimensionIndices} = this.displayDimensionRenderInfo.value;
    for (let i = 0; i < 3; ++i) {
      const dim = displayDimensionIndices[i];
      const scale = zoom / canonicalVoxelFactors[i];
      mat[i] *= scale;
      mat[4 + i] *= scale;
      mat[8 + i] *= scale;
      mat[12 + i] = voxelCoordinates[dim] || 0;
    }
  }

  toMat3(mat: mat3, zoom: number) {
    mat3.fromQuat(mat, this.orientation.orientation);
    const {canonicalVoxelFactors, displayRank} = this.displayDimensionRenderInfo.value;
    for (let i = 0; i < displayRank; ++i) {
      const scale = zoom / canonicalVoxelFactors[i];
      mat[i] *= scale;
      mat[3 + i] *= scale;
      mat[6 + i] *= scale;
    }
  }

  /**
   * Snaps the orientation to the nearest axis-aligned orientation, and
   * snaps the position to the nearest voxel.
   */
  snap() {
    this.orientation.snap();
    this.position.snapToVoxel();
    this.changed.dispatch();
  }

  translateDimensionRelative(dimensionIndex: number, adjustment: number) {
    if (!this.valid) {
      return;
    }
    const {position} = this;
    const {value: voxelCoordinates} = position;
    const {bounds: {lowerBounds, upperBounds}} = position.coordinateSpace.value;
    let newValue = voxelCoordinates[dimensionIndex] + adjustment;
    if (adjustment > 0) {
      const bound = upperBounds[dimensionIndex];
      if (Number.isFinite(bound)) {
        newValue = Math.min(newValue, Math.ceil(bound - 1));
      }
    } else {
      const bound = lowerBounds[dimensionIndex];
      if (Number.isFinite(bound)) {
        newValue = Math.max(newValue, Math.floor(bound));
      }
    }
    voxelCoordinates[dimensionIndex] = newValue;
    position.changed.dispatch();
  }

  translateVoxelsRelative(translation: vec3, round: boolean = false) {
    if (!this.valid) {
      return;
    }
    const temp = vec3.transformQuat(tempVec3, translation, this.orientation.orientation);
    const {position} = this;
    const {value: voxelCoordinates} = position;
    const {displayDimensionIndices, displayRank} = this.displayDimensions.value;
    const {bounds: {lowerBounds, upperBounds}} = position.coordinateSpace.value;
    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      const adjustment = temp[i];
      if (adjustment === 0) continue;
      let newValue = voxelCoordinates[dim] + adjustment;
      if (adjustment > 0) {
        const bound = upperBounds[dim];
        if (Number.isFinite(bound)) {
          newValue = Math.min(newValue, Math.ceil(bound - 1));
        }
      } else {
        const bound = lowerBounds[dim];
        if (Number.isFinite(bound)) {
          newValue = Math.max(newValue, Math.floor(bound));
        }
      }
      if (round) newValue = Math.floor(newValue) + 0.5;
      voxelCoordinates[dim] = newValue;
    }
    this.position.changed.dispatch();
  }

  rotateRelative(axis: vec3, angle: number) {
    var temp = quat.create();
    quat.setAxisAngle(temp, axis, angle);
    var orientation = this.orientation.orientation;
    quat.multiply(orientation, orientation, temp);
    this.orientation.changed.dispatch();
  }

  rotateAbsolute(axis: vec3, angle: number, fixedPoint: Float32Array) {
    const {coordinateSpace: {value: coordinateSpace}, value: voxelCoordinates} = this.position;
    if (coordinateSpace === undefined) return;
    const {
      relativeDisplayScales: {value: {factors: relativeDisplayScales}},
      displayDimensions: {value: {displayDimensionIndices, displayRank}}
    } = this;
    const {scales} = coordinateSpace;
    const temp = quat.create();
    quat.setAxisAngle(temp, axis, angle);
    const orientation = this.orientation.orientation;

    // We want the coordinates in the transformed coordinate frame of the fixed point to remain
    // the same after the rotation.

    // We have the invariants:
    // oldOrienation * fixedPointLocal + oldPosition == fixedPoint.
    // newOrientation * fixedPointLocal + newPosition == fixedPoint.

    // Therefore, we compute fixedPointLocal by:
    // fixedPointLocal == inverse(oldOrientation) * (fixedPoint - oldPosition).
    const fixedPointLocal = tempVec3;
    tempVec3.fill(0);
    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      const diff = fixedPoint[dim] - voxelCoordinates[dim];
      fixedPointLocal[i] = diff * scales[dim] * relativeDisplayScales[dim];
    }
    const invOrientation = quat.invert(tempQuat, orientation);
    vec3.transformQuat(fixedPointLocal, fixedPointLocal, invOrientation);

    // We then compute the newPosition by:
    // newPosition := fixedPoint - newOrientation * fixedPointLocal.
    quat.multiply(orientation, temp, orientation);
    vec3.transformQuat(fixedPointLocal, fixedPointLocal, orientation);

    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      voxelCoordinates[dim] =
          fixedPoint[dim] - fixedPointLocal[i] / (scales[dim] * relativeDisplayScales[dim]);
    }
    this.position.changed.dispatch();
    this.orientation.changed.dispatch();
  }

  translateNonDisplayDimension(nonSpatialDimensionIndex: number, adjustment: number) {
    if (!this.valid) return;
    const {displayDimensionIndices} = this.displayDimensions.value;
    const {position} = this;
    const rank = position.coordinateSpace.value.rank;
    for (let i = 0; i < rank; ++i) {
      if (displayDimensionIndices.indexOf(i) !== -1) continue;
      if (nonSpatialDimensionIndex-- === 0) {
        this.translateDimensionRelative(i, adjustment);
        return;
      }
    }
  }
}

export type TrackableZoomInterface = TrackableProjectionZoom|TrackableCrossSectionZoom;

export class LinkedZoomState<T extends TrackableProjectionZoom|TrackableCrossSectionZoom> extends
    LinkedBase<T> {
  constructor(
      peer: Owned<T>, displayDimensionRenderInfo: Owned<WatchableDisplayDimensionRenderInfo>) {
    super(peer);
    this.value = (() => {
      const self: T = new (peer.constructor as any)(displayDimensionRenderInfo);
      const assign = (target: T, source: T) => {
        target.assign(source);
      };
      const difference = (a: T, b: T) => {
        return (a.value / b.value) * (a.canonicalVoxelPhysicalSize / b.canonicalVoxelPhysicalSize);
      };
      const add = (target: T, source: T, amount: number) => {
        target.setPhysicalScale(source.value * amount, source.canonicalVoxelPhysicalSize);
      };
      const subtract = (target: T, source: T, amount: number) => {
        target.setPhysicalScale(source.value / amount, source.canonicalVoxelPhysicalSize);
      };
      const isValid = (x: T) => x.coordinateSpaceValue.valid && x.canonicalVoxelPhysicalSize !== 0;
      makeLinked(self, this.peer, this.link, {assign, isValid, difference, add, subtract});
      return self;
    })();
  }
}

export function
linkedStateLegacyJsonView<T extends LinkableState<T>&{readonly legacyJsonView: Trackable}>(
    linked: LinkedBase<T>) {
  return {
    changed: linked.changed,
    toJSON() {
      return linked.toJSON();
    },
    restoreState(obj: unknown) {
      restoreLinkedFromJson(linked.link, linked.value.legacyJsonView, obj);
    },
    reset() {
      linked.reset();
    },
  };
}

abstract class TrackableZoom extends RefCounted implements Trackable,
                                                           WatchableValueInterface<number> {
  readonly changed = new NullarySignal();
  private curCanonicalVoxelPhysicalSize = 0;
  private value_: number = Number.NaN;
  protected legacyValue_: number = Number.NaN;

  /**
   * Zoom factor.  For cross section views, in canonical voxels per viewport pixel.  For projection
   * views, in canonical voxels per viewport height (for orthographic projection).
   */
  get value() {
    this.handleCoordinateSpaceChanged();
    return this.value_;
  }

  set value(value: number) {
    const {canonicalVoxelPhysicalSize} = this;
    if (Object.is(value, this.value_) &&
        canonicalVoxelPhysicalSize === this.curCanonicalVoxelPhysicalSize) {
      return;
    }
    this.curCanonicalVoxelPhysicalSize = canonicalVoxelPhysicalSize;
    this.legacyValue_ = Number.NaN;
    this.value_ = value;
    this.changed.dispatch();
  }

  get canonicalVoxelPhysicalSize() {
    return this.displayDimensionRenderInfo.value.canonicalVoxelPhysicalSize;
  }

  get coordinateSpaceValue() {
    return this.displayDimensionRenderInfo.relativeDisplayScales.coordinateSpace.value;
  }

  /**
   * Sets the zoom factor in the legacy units.  For cross section views, `1e-9` spatial units per
   * viewport pixel.  For projection views, `2 * 100 * Math.tan(Math.PI / 8) * 1e-9` spatial units
   * per viewport height (for orthographic projection).
   */
  set legacyValue(value: number) {
    if (Object.is(value, this.legacyValue_)) return;
    this.value_ = Number.NaN;
    this.legacyValue_ = value;
    this.curCanonicalVoxelPhysicalSize = 0;
    this.changed.dispatch();
  }

  get legacyValue() {
    return this.legacyValue_;
  }

  constructor(public displayDimensionRenderInfo: Owned<WatchableDisplayDimensionRenderInfo>) {
    super();
    this.registerDisposer(displayDimensionRenderInfo);
    this.registerDisposer(
        displayDimensionRenderInfo.changed.add(() => this.handleCoordinateSpaceChanged()));
    this.registerDisposer(
        displayDimensionRenderInfo.relativeDisplayScales.coordinateSpace.changed.add(
            () => this.handleCoordinateSpaceChanged()));
    this.handleCoordinateSpaceChanged();
  }

  handleCoordinateSpaceChanged() {
    const {value_} = this;
    const {
      displayDimensionRenderInfo: {
        value: {canonicalVoxelPhysicalSize},
        relativeDisplayScales: {coordinateSpace: {value: coordinateSpace}}
      }
    } = this;
    const {curCanonicalVoxelPhysicalSize} = this;
    if (!Number.isNaN(value_) && canonicalVoxelPhysicalSize === curCanonicalVoxelPhysicalSize) {
      return;
    }
    if (!Number.isNaN(value_)) {
      if (curCanonicalVoxelPhysicalSize !== 0) {
        this.value_ = value_ * (curCanonicalVoxelPhysicalSize / canonicalVoxelPhysicalSize);
        this.curCanonicalVoxelPhysicalSize = canonicalVoxelPhysicalSize;
        this.changed.dispatch();
      }
      return;
    }
    if (!coordinateSpace.valid || canonicalVoxelPhysicalSize === 0) {
      return;
    }
    this.curCanonicalVoxelPhysicalSize = canonicalVoxelPhysicalSize;
    this.value_ = this.getDefaultValue();
    this.changed.dispatch();
  }

  protected abstract getDefaultValue(): number;

  toJSON() {
    const {value} = this;
    return Number.isNaN(value) ? undefined : value;
  }

  restoreState(obj: any) {
    this.curCanonicalVoxelPhysicalSize = 0;
    this.legacyValue_ = Number.NaN;
    if (obj === undefined) {
      this.value_ = Number.NaN;
    } else {
      this.value_ = verifyFinitePositiveFloat(obj);
    }
    this.changed.dispatch();
  }

  reset() {
    this.curCanonicalVoxelPhysicalSize = 0;
    this.value_ = Number.NaN;
    this.legacyValue_ = Number.NaN;
    this.changed.dispatch();
  }

  get legacyJsonView() {
    const self = this;
    return {
      changed: self.changed,
      toJSON() {
        return self.toJSON();
      },
      reset() {
        return self.reset();
      },
      restoreState(obj: any) {
        self.legacyValue = verifyFinitePositiveFloat(obj);
      },
    };
  }

  setPhysicalScale(scaleInCanonicalVoxels: number, canonicalVoxelPhysicalSize: number) {
    const curCanonicalVoxelPhysicalSize = this.curCanonicalVoxelPhysicalSize =
        this.canonicalVoxelPhysicalSize;
    this.value =
        scaleInCanonicalVoxels * (canonicalVoxelPhysicalSize / curCanonicalVoxelPhysicalSize);
  }

  assign(source: TrackableZoomInterface) {
    const {legacyValue} = source;
    if (!Number.isNaN(legacyValue)) {
      this.legacyValue = legacyValue;
    } else {
      this.setPhysicalScale(source.value, source.canonicalVoxelPhysicalSize);
    }
  }
}

export class TrackableCrossSectionZoom extends TrackableZoom {
  protected getDefaultValue() {
    const {legacyValue_} = this;
    if (Number.isNaN(legacyValue_)) {
      // Default is 1 voxel per viewport pixel.
      return 1;
    }
    const {canonicalVoxelPhysicalSize} = this;
    return this.legacyValue_ * 1e-9 / canonicalVoxelPhysicalSize;
  }
}

export class TrackableProjectionZoom extends TrackableZoom {
  protected getDefaultValue() {
    const {legacyValue_} = this;
    if (!Number.isNaN(legacyValue_)) {
      this.legacyValue_ = Number.NaN;
      const {canonicalVoxelPhysicalSize} = this;
      return 2 * 100 * Math.tan(Math.PI / 8) * 1e-9 * legacyValue_ / canonicalVoxelPhysicalSize;
    }
    const {coordinateSpaceValue: {bounds: {lowerBounds, upperBounds}}} = this;
    const {canonicalVoxelFactors, displayDimensionIndices} = this.displayDimensionRenderInfo.value;
    let value = canonicalVoxelFactors.reduce((x, factor, i) => {
      const dim = displayDimensionIndices[i];
      const extent = (upperBounds[dim] - lowerBounds[dim]) * factor;
      return Math.max(x, extent);
    }, 0);
    if (!Number.isFinite(value)) {
      // Default to showing 1024 voxels if there is no bounds information.
      value = 1024;
    } else {
      value = 2 ** Math.ceil(Math.log2(value));
    }
    return value;
  }
}

export class TrackableDepthRange extends RefCounted implements WatchableValueInterface<number> {
  changed = new NullarySignal();

  constructor(
      public readonly defaultValue: number,
      public displayDimensionRenderInfo: WatchableValueInterface<DisplayDimensionRenderInfo>) {
    super();
    this.value_ = defaultValue;
    this.canonicalVoxelPhysicalSize = displayDimensionRenderInfo.value.canonicalVoxelPhysicalSize;
    this.registerDisposer(displayDimensionRenderInfo.changed.add(() => {
      this.value;
    }));
  }

  private value_: number;
  canonicalVoxelPhysicalSize: number;

  get value() {
    let {value_} = this;
    if (value_ > 0) {
      const {canonicalVoxelPhysicalSize} = this.displayDimensionRenderInfo.value;
      const prevCanonicalVoxelPhysicalSize = this.canonicalVoxelPhysicalSize;
      if (canonicalVoxelPhysicalSize !== prevCanonicalVoxelPhysicalSize) {
        this.canonicalVoxelPhysicalSize = canonicalVoxelPhysicalSize;
        value_ = this.value_ = value_ =
            (prevCanonicalVoxelPhysicalSize / canonicalVoxelPhysicalSize);
        this.changed.dispatch();
      }
    }
    return value_;
  }

  set value(value: number) {
    if (value === this.value) return;
    this.value_ = value;
    const {canonicalVoxelPhysicalSize} = this.displayDimensionRenderInfo.value;
    this.canonicalVoxelPhysicalSize = canonicalVoxelPhysicalSize;
    this.changed.dispatch();
  }

  toJSON() {
    const {value} = this;
    if (value === this.defaultValue) return undefined;
    return value;
  }

  reset() {
    this.value = this.defaultValue;
  }

  restoreState(obj: unknown) {
    if (typeof obj !== 'number' || !Number.isFinite(obj) || obj === 0) {
      this.value = this.defaultValue;
    } else {
      this.value = obj;
    }
  }

  setValueAbsolute(value: number, sourceCanonicalVoxelPhysicalSize: number) {
    if (value > 0) {
      const {canonicalVoxelPhysicalSize} = this.displayDimensionRenderInfo.value;
      value = value * (sourceCanonicalVoxelPhysicalSize / canonicalVoxelPhysicalSize);
    }
    this.value = value;
  }

  assign(other: TrackableDepthRange) {
    this.setValueAbsolute(other.value, other.canonicalVoxelPhysicalSize);
  }
}

export class LinkedDepthRange extends SimpleLinkedBase<TrackableDepthRange> {
  constructor(
      peer: Owned<TrackableDepthRange>,
      displayDimensionRenderInfo: WatchableValueInterface<DisplayDimensionRenderInfo>) {
    super(peer);
    this.value = makeSimpleLinked(
        new TrackableDepthRange(peer.defaultValue, displayDimensionRenderInfo), this.peer,
        this.link, {
          assign: (target, source) => target.assign(source),
          isValid: () => true,
        });
  }
}

export class NavigationState<Zoom extends TrackableZoomInterface = TrackableZoomInterface> extends
    RefCounted {
  changed = new NullarySignal();

  constructor(
      public pose: Owned<DisplayPose>, public zoomFactor: Owned<Zoom>,
      public depthRange: Owned<TrackableDepthRange>) {
    super();
    this.registerDisposer(pose);
    this.registerDisposer(zoomFactor);
    this.registerDisposer(depthRange);
    this.registerDisposer(this.pose.changed.add(this.changed.dispatch));
    this.registerDisposer(this.zoomFactor.changed.add(this.changed.dispatch));
    this.registerDisposer(this.depthRange.changed.add(this.changed.dispatch));
  }
  get coordinateSpace() {
    return this.pose.position.coordinateSpace;
  }

  /**
   * Resets everything.
   */
  reset() {
    this.pose.reset();
    this.zoomFactor.reset();
  }

  get position() {
    return this.pose.position;
  }
  get displayDimensions() {
    return this.pose.displayDimensions;
  }
  get relativeDisplayScales() {
    return this.pose.relativeDisplayScales;
  }
  get displayDimensionRenderInfo() {
    return this.pose.displayDimensionRenderInfo;
  }
  toMat4(mat: mat4) {
    this.pose.toMat4(mat, this.zoomFactor.value);
  }
  toMat3(mat: mat3) {
    this.pose.toMat3(mat, this.zoomFactor.value);
  }

  get relativeDepthRange() {
    let depthRange = this.depthRange.value;
    if (depthRange > 0) {
      depthRange /= this.zoomFactor.value;
    } else {
      depthRange *= -1;
    }
    return depthRange;
  }

  get valid() {
    return this.pose.valid && !Number.isNaN(this.zoomFactor.value);
  }

  zoomBy(factor: number) {
    this.zoomFactor.value *= factor;
  }
}
