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
    if (!this.valid) return undefined;
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
      coordinates_[i] = Math.round(coordinates_[i]);
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
  coordinateSpace: CoordinateSpace;

  /**
   * Array of length `coordinateSpace.rank` specifying scale factors on top of (will be multiply by)
   * `coordinateSpace.scales` to use for display purposes.  This allows non-uniform zooming.
   */
  factors: Float64Array;
}

export class TrackableRelativeDisplayScales extends RefCounted implements
    Trackable, WatchableValueInterface<RelativeDisplayScales> {
  changed = new NullarySignal();
  private value_: RelativeDisplayScales = {
    coordinateSpace: emptyInvalidCoordinateSpace,
    factors: new Float64Array(0)
  };
  constructor(public coordinateSpace: WatchableValueInterface<CoordinateSpace>) {
    super();
    this.registerDisposer(coordinateSpace.changed.add(() => this.update()));
    this.update();
  }

  get value() {
    return this.update();
  }

  reset() {
    this.value_ = {coordinateSpace: emptyInvalidCoordinateSpace, factors: new Float64Array(0)};
    this.changed.dispatch();
  }

  toJSON() {
    const json: any = {};
    let nonEmpty = false;
    const {value} = this;
    const {coordinateSpace: {names, rank}, factors} = value;
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
    this.value_ = {coordinateSpace, factors};
    this.changed.dispatch();
  }

  setFactors(factors: Float64Array) {
    const {coordinateSpace: {value: coordinateSpace}} = this;
    if (factors.length !== coordinateSpace.rank) return;
    this.value_ = {coordinateSpace, factors};
    this.changed.dispatch();
  }

  private update() {
    const {coordinateSpace: {value: coordinateSpace}} = this;
    let value = this.value_;
    if (value.coordinateSpace === coordinateSpace) return value;
    const {ids: oldDimensionIds} = value.coordinateSpace;
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
    value = this.value_ = {coordinateSpace, factors: newFactors};
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
              const {factors: fa, coordinateSpace} = a.value;
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

export interface DisplayDimensions {
  /**
   * Coordinate space with display scale factors that serves as the input.
   */
  relativeDisplayScales: RelativeDisplayScales;

  /**
   * Rank of displayed dimensions.  Must be <= 3.
   */
  rank: number;

  /**
   * Array of length 3.  The first `rank` elements specify the indices of dimensions in
   * `coordinateSpace` that are displayed.  The remaining elements are `-1`.
   */
  dimensionIndices: Int32Array;

  /**
   * Physical unit corresponding to the canonical voxel.  This is always the unit in
   * `coordinateSpace` corresponding to `dimensionIndices[0]`, or unitless in the degenerate case of
   * `raank === 0`.
   */
  canonicalVoxelUnit: string;

  /**
   * Array of length 3.  `voxelPhysicalScales[i]` equals
   * `relativeDisplayScales[d] * coordinateSpace.scales[d]`,
   * where `d = dimensionIndices[i]`, or `1` for `i >= rank`.
   */
  voxelPhysicalScales: Float64Array;

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

export class TrackableDisplayDimensions extends RefCounted implements Trackable {
  changed = new NullarySignal();
  private default_ = true;
  private value_: DisplayDimensions|undefined = undefined;

  get coordinateSpace() {
    return this.relativeDisplayScales.coordinateSpace;
  }

  constructor(public relativeDisplayScales: Owned<TrackableRelativeDisplayScales>) {
    super();
    this.registerDisposer(relativeDisplayScales);
    this.registerDisposer(this.relativeDisplayScales.changed.add(this.changed.dispatch));
    this.update();
  }

  get value() {
    this.update();
    return this.value_!;
  }

  private update() {
    const {relativeDisplayScales: {value: relativeDisplayScales}} = this;
    const value = this.value_;
    if (value !== undefined && value.relativeDisplayScales === relativeDisplayScales) {
      return;
    }
    if (value === undefined || this.default_) {
      this.setToDefault(relativeDisplayScales);
      return;
    }
    const newDimensionIndices = new Int32Array(3);
    const {ids: oldDimensionIds} = value.relativeDisplayScales.coordinateSpace;
    const {ids: newDimensionIds} = relativeDisplayScales.coordinateSpace;
    const oldDimensionIndices = value.dimensionIndices;
    const oldRank = value.rank;
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
      this.setToDefault(relativeDisplayScales);
      return;
    }
    this.assignValue(relativeDisplayScales, newRank, newDimensionIndices);
    this.changed.dispatch();
  }

  private setToDefault(relativeDisplayScales: RelativeDisplayScales) {
    const {coordinateSpace} = relativeDisplayScales;
    const rank = Math.min(coordinateSpace.rank, 3);
    const dimensionIndices = new Int32Array(3);
    dimensionIndices.fill(-1);
    for (let i = 0; i < rank; ++i) {
      dimensionIndices[i] = i;
    }
    this.assignValue(relativeDisplayScales, rank, dimensionIndices);
  }

  private assignValue(
      relativeDisplayScales: RelativeDisplayScales, rank: number, dimensionIndices: Int32Array) {
    let canonicalVoxelUnit: string;
    const canonicalVoxelFactors = new Float64Array(3);
    let voxelPhysicalScales = new Float64Array(3);
    let canonicalVoxelPhysicalSize: number;
    const {coordinateSpace, factors} = relativeDisplayScales;
    canonicalVoxelFactors.fill(1);
    voxelPhysicalScales.fill(1);
    if (rank === 0) {
      canonicalVoxelUnit = '';
      canonicalVoxelPhysicalSize = 1;
    } else {
      canonicalVoxelUnit = coordinateSpace.units[dimensionIndices[0]];
      canonicalVoxelPhysicalSize = Number.POSITIVE_INFINITY;
      const {scales} = coordinateSpace;
      for (let i = 0; i < rank; ++i) {
        const dim = dimensionIndices[i];
        const s = voxelPhysicalScales[i] = factors[dim] * scales[dim];
        canonicalVoxelPhysicalSize = Math.min(canonicalVoxelPhysicalSize, s);
      }
      for (let i = 0; i < rank; ++i) {
        canonicalVoxelFactors[i] = voxelPhysicalScales[i] / canonicalVoxelPhysicalSize;
      }
    }
    this.value_ = {
      relativeDisplayScales,
      rank,
      dimensionIndices,
      canonicalVoxelUnit,
      canonicalVoxelFactors,
      voxelPhysicalScales,
      canonicalVoxelPhysicalSize,
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
    const {relativeDisplayScales: {value: relativeDisplayScales}} = this;
    const {coordinateSpace} = relativeDisplayScales;
    const dimensionIndices = new Int32Array(3);
    dimensionIndices.fill(-1);
    const {names} = coordinateSpace;
    let rank = 0;
    for (const name of displayDimensionNames) {
      const index = names.indexOf(name);
      if (index === -1) continue;
      dimensionIndices[rank++] = index;
    }
    if (rank === 0) {
      this.reset();
      return;
    }
    this.default_ = false;
    this.assignValue(relativeDisplayScales, rank, dimensionIndices);
  }

  get default() {
    this.update();
    return this.default_;
  }

  set default(value: boolean) {
    if (this.default_ === value) return;
    if (value) {
      this.default_ = true;
      this.setToDefault(this.relativeDisplayScales.value);
    } else {
      this.default_ = false;
      this.changed.dispatch();
    }
  }

  setDimensionIndices(rank: number, dimensionIndices: Int32Array) {
    this.default_ = false;
    this.assignValue(this.relativeDisplayScales.value, rank, dimensionIndices);
  }

  toJSON() {
    if (this.default_) return undefined;
    const {value} = this;
    const displayDimensionNames: string[] = [];
    const {rank, dimensionIndices, relativeDisplayScales: {coordinateSpace: {names}}} = value;
    if (rank === 0) return undefined;
    for (let i = 0; i < rank; ++i) {
      displayDimensionNames[i] = names[dimensionIndices[i]];
    }
    return displayDimensionNames;
  }

  assign(other: TrackableDisplayDimensions) {
    if (other.default) {
      this.default = true;
    } else {
      const {rank, dimensionIndices} = other.value;
      this.setDimensionIndices(rank, dimensionIndices);
    }
  }
}

export class LinkedDisplayDimensions extends SimpleLinkedBase<TrackableDisplayDimensions> {
  value = makeSimpleLinked(
      new TrackableDisplayDimensions(this.relativeDisplayScales.addRef()), this.peer, this.link, {
        assign: (target, source) => target.assign(source),
        isValid: () => true,
      });
  constructor(
      peer: Owned<TrackableDisplayDimensions>,
      public relativeDisplayScales: Owned<TrackableRelativeDisplayScales>) {
    super(peer);
  }
}

export class DisplayPose extends RefCounted {
  changed = new NullarySignal();
  constructor(
      public position: Owned<Position>, public displayDimensions: Owned<TrackableDisplayDimensions>,
      public orientation: Owned<OrientationState>) {
    super();
    this.registerDisposer(position);
    this.registerDisposer(orientation);
    this.registerDisposer(position.changed.add(this.changed.dispatch));
    this.registerDisposer(orientation.changed.add(this.changed.dispatch));
    this.registerDisposer(displayDimensions.changed.add(this.changed.dispatch));
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
    const {dimensionIndices, rank} = this.displayDimensions.value;
    if (coordinateSpace === undefined) return false;
    temp.fill(0);
    for (let i = 0; i < rank; ++i) {
      const dim = dimensionIndices[i];
      temp[i] = voxelCoordinates[dim];
    }
    if (fun(temp) !== false) {
      for (let i = 0; i < rank; ++i) {
        const dim = dimensionIndices[i];
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
    const {canonicalVoxelFactors, dimensionIndices} = this.displayDimensions.value;
    for (let i = 0; i < 3; ++i) {
      const dim = dimensionIndices[i];
      const scale = zoom / canonicalVoxelFactors[i];
      mat[i] *= scale;
      mat[4 + i] *= scale;
      mat[8 + i] *= scale;
      mat[12 + i] = voxelCoordinates[dim] || 0;
    }
  }

  toMat3(mat: mat3, zoom: number) {
    mat3.fromQuat(mat, this.orientation.orientation);
    const {canonicalVoxelFactors, rank} = this.displayDimensions.value;
    for (let i = 0; i < rank; ++i) {
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

  translateVoxelsRelative(translation: vec3) {
    if (!this.valid) {
      return;
    }
    const temp = vec3.transformQuat(tempVec3, translation, this.orientation.orientation);
    const {position} = this;
    const {value: voxelCoordinates} = position;
    const {dimensionIndices, rank} = this.displayDimensions.value;
    const {bounds: {lowerBounds, upperBounds}} = position.coordinateSpace.value;
    for (let i = 0; i < rank; ++i) {
      const dim = dimensionIndices[i];
      const adjustment = temp[i];
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
    const {relativeDisplayScales: {factors: relativeDisplayScales}, dimensionIndices, rank} =
        this.displayDimensions.value;
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
    for (let i = 0; i < rank; ++i) {
      const dim = dimensionIndices[i];
      const diff = fixedPoint[dim] - voxelCoordinates[dim];
      fixedPointLocal[i] = diff * scales[dim] * relativeDisplayScales[dim];
    }
    const invOrientation = quat.invert(tempQuat, orientation);
    vec3.transformQuat(fixedPointLocal, fixedPointLocal, invOrientation);

    // We then compute the newPosition by:
    // newPosition := fixedPoint - newOrientation * fixedPointLocal.
    quat.multiply(orientation, temp, orientation);
    vec3.transformQuat(fixedPointLocal, fixedPointLocal, orientation);

    for (let i = 0; i < rank; ++i) {
      const dim = dimensionIndices[i];
      voxelCoordinates[dim] =
          fixedPoint[dim] - fixedPointLocal[i] / (scales[dim] * relativeDisplayScales[i]);
    }
    this.position.changed.dispatch();
    this.orientation.changed.dispatch();
  }

  translateNonDisplayDimension(nonSpatialDimensionIndex: number, adjustment: number) {
    if (!this.valid) return;
    const {dimensionIndices} = this.displayDimensions.value;
    const {position} = this;
    const rank = position.coordinateSpace.value.rank;
    for (let i = 0; i < rank; ++i) {
      if (dimensionIndices.indexOf(i) !== -1) continue;
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
  constructor(peer: Owned<T>, displayDimensions: Owned<TrackableDisplayDimensions>) {
    super(peer);
    this.value = (() => {
      const self: T = new (peer.constructor as any)(displayDimensions);
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
      const isValid = (x: T) => x.coordinateSpace.value.valid && x.canonicalVoxelPhysicalSize !== 0;
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
  private curCoordinateSpace: CoordinateSpace = emptyInvalidCoordinateSpace;
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
    const {canonicalVoxelPhysicalSize} = this.displayDimensions.value;
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
    return this.displayDimensions.value.canonicalVoxelPhysicalSize;
  }

  /**
   * Sets the zoom factor in the legacy units.  For cross section views, `1e-9` spatial units per
   * viewport pixel.  For projection views, `2 * 100 * Math.tan(Math.PI / 8) * 1e-9` spatial units
   * per viewport height (for orthographic projection).
   */
  set legacyValue(value: number) {
    if (Object.is(value, this.legacyValue_)) return;
    this.curCoordinateSpace = emptyInvalidCoordinateSpace;
    this.value_ = Number.NaN;
    this.legacyValue_ = value;
    this.changed.dispatch();
  }

  get legacyValue() {
    return this.legacyValue_;
  }

  get coordinateSpace() {
    return this.displayDimensions.coordinateSpace;
  }

  constructor(public displayDimensions: Owned<TrackableDisplayDimensions>) {
    super();
    this.registerDisposer(displayDimensions);
    this.registerDisposer(displayDimensions.changed.add(() => this.handleCoordinateSpaceChanged()));
    this.registerDisposer(
        displayDimensions.coordinateSpace.changed.add(() => this.handleCoordinateSpaceChanged()));
    this.handleCoordinateSpaceChanged();
  }

  handleCoordinateSpaceChanged() {
    const {value_} = this;
    const {canonicalVoxelPhysicalSize} = this.displayDimensions.value;
    const {curCanonicalVoxelPhysicalSize} = this;
    const {curCoordinateSpace} = this;
    const coordinateSpace = this.coordinateSpace.value;
    if (canonicalVoxelPhysicalSize === curCanonicalVoxelPhysicalSize &&
        curCoordinateSpace === coordinateSpace) {
      return;
    }
    this.curCanonicalVoxelPhysicalSize = canonicalVoxelPhysicalSize;
    this.curCoordinateSpace = coordinateSpace;
    if (!Number.isNaN(value_)) {
      if (curCanonicalVoxelPhysicalSize !== 0) {
        this.value_ = value_ * (curCanonicalVoxelPhysicalSize / canonicalVoxelPhysicalSize);
        this.changed.dispatch();
      }
      return;
    }
    if (!coordinateSpace.valid || canonicalVoxelPhysicalSize === 0) return;
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
    this.curCoordinateSpace = emptyInvalidCoordinateSpace;
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
    this.curCoordinateSpace = emptyInvalidCoordinateSpace;
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
        this.displayDimensions.value.canonicalVoxelPhysicalSize;
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
    const {canonicalVoxelPhysicalSize} = this.displayDimensions.value;
    return this.legacyValue_ * 1e-9 / canonicalVoxelPhysicalSize;
  }
}

export class TrackableProjectionZoom extends TrackableZoom {
  protected getDefaultValue() {
    const {legacyValue_} = this;
    if (!Number.isNaN(legacyValue_)) {
      this.legacyValue_ = Number.NaN;
      const {canonicalVoxelPhysicalSize} = this.displayDimensions.value;
      return 2 * 100 * Math.tan(Math.PI / 8) * 1e-9 * legacyValue_ / canonicalVoxelPhysicalSize;
    }
    const {coordinateSpace: {value: {bounds: {lowerBounds, upperBounds}}}} = this;
    const {canonicalVoxelFactors, dimensionIndices} = this.displayDimensions.value;
    let value = canonicalVoxelFactors.reduce((x, factor, i) => {
      const dim = dimensionIndices[i];
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

export class NavigationState<Zoom extends TrackableZoomInterface = TrackableZoomInterface> extends
    RefCounted {
  changed = new NullarySignal();

  constructor(public pose: Owned<DisplayPose>, public zoomFactor: Owned<Zoom>) {
    super();
    this.registerDisposer(this.zoomFactor);
    this.registerDisposer(pose);
    this.registerDisposer(this.pose.changed.add(this.changed.dispatch));
    this.registerDisposer(this.zoomFactor.changed.add(this.changed.dispatch));
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
    return this.pose.displayDimensions.relativeDisplayScales;
  }
  toMat4(mat: mat4) {
    this.pose.toMat4(mat, this.zoomFactor.value);
  }
  toMat3(mat: mat3) {
    this.pose.toMat3(mat, this.zoomFactor.value);
  }

  get valid() {
    return this.pose.valid;
  }

  zoomBy(factor: number) {
    this.zoomFactor.value *= factor;
  }
}
