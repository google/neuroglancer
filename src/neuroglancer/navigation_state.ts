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

import {Borrowed, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat3, mat4, quat, vec3} from 'neuroglancer/util/geom';
import {parseFiniteVec, verifyObject, verifyObjectProperty} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Trackable} from 'neuroglancer/util/trackable';
import {TrackableEnum} from 'neuroglancer/util/trackable_enum';

export enum NavigationLinkType {
  LINKED,
  RELATIVE,
  UNLINKED,
}

export class TrackableNavigationLink extends TrackableEnum<NavigationLinkType> {
  constructor(value = NavigationLinkType.LINKED) {
    super(NavigationLinkType, value);
  }
}

export class VoxelSize extends RefCounted {
  size: vec3;
  valid: boolean;
  changed = new NullarySignal();
  constructor(voxelSize?: vec3) {
    super();
    let valid = true;
    if (voxelSize == null) {
      voxelSize = vec3.create();
      valid = false;
    }
    this.size = voxelSize;
    this.valid = valid;
  }

  reset() {
    this.valid = false;
    this.changed.dispatch();
  }

  /**
   * This should be called after setting the voxel size initially.  The voxel
   * size should not be changed once it is valid.
   */
  setValid() {
    if (!this.valid) {
      this.valid = true;
      this.changed.dispatch();
    }
  }

  toJSON() {
    if (!this.valid) {
      return undefined;
    }
    return Array.prototype.slice.call(this.size);
  }

  restoreState(obj: any) {
    try {
      parseFiniteVec(this.size, obj);
      this.valid = true;
      this.changed.dispatch();
    } catch (e) {
      this.valid = false;
      this.changed.dispatch();
    }
  }

  toString() {
    if (!this.valid) {
      return null;
    }
    return this.size.toString();
  }

  voxelFromSpatial(voxel: vec3, spatial: vec3) {
    return vec3.divide(voxel, spatial, this.size);
  }

  spatialFromVoxel(spatial: vec3, voxel: vec3) {
    return vec3.multiply(spatial, voxel, this.size);
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
    }) {
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

interface SpatialPositionOffset {
  spatialOffset?: vec3;
  voxelOffset?: vec3;
}

export class SpatialPosition extends RefCounted {
  voxelSize: VoxelSize;
  spatialCoordinates: vec3;
  spatialCoordinatesValid: boolean;
  protected voxelCoordinates: vec3|null = null;
  changed = new NullarySignal();
  constructor(voxelSize?: Owned<VoxelSize>, spatialCoordinates?: vec3) {
    super();
    if (voxelSize == null) {
      voxelSize = new VoxelSize();
    }
    this.voxelSize = voxelSize;

    let spatialCoordinatesValid = true;
    if (spatialCoordinates == null) {
      spatialCoordinates = vec3.create();
      spatialCoordinatesValid = false;
    }
    this.spatialCoordinates = spatialCoordinates;
    this.spatialCoordinatesValid = spatialCoordinatesValid;

    this.registerDisposer(voxelSize);
    this.registerDisposer(voxelSize.changed.add(() => {
      this.handleVoxelSizeChanged();
    }));
  }

  get valid() {
    return this.spatialCoordinatesValid && this.voxelSize.valid;
  }

  get voxelCoordinatesValid() {
    return this.valid || this.voxelCoordinates != null;
  }

  reset() {
    this.spatialCoordinatesValid = false;
    this.voxelCoordinates = null;
    this.voxelSize.reset();
    this.changed.dispatch();
  }

  getVoxelCoordinates(out: vec3) {
    let {voxelCoordinates} = this;
    if (voxelCoordinates) {
      vec3.copy(out, voxelCoordinates);
    } else if (this.valid) {
      this.voxelSize.voxelFromSpatial(out, this.spatialCoordinates);
    } else {
      return false;
    }
    return true;
  }

  /**
   * Sets this position to the spatial coordinats corresponding to the specified
   * voxelPosition.  If this.voxelSize.valid == false, then this position won't
   * be set until it is.
   */
  setVoxelCoordinates(voxelCoordinates: vec3) {
    let voxelSize = this.voxelSize;
    if (voxelSize.valid) {
      voxelSize.spatialFromVoxel(this.spatialCoordinates, voxelCoordinates);
      this.markSpatialCoordinatesChanged();
    } else {
      let voxelCoordinates_ = this.voxelCoordinates;
      if (!voxelCoordinates_) {
        this.voxelCoordinates = voxelCoordinates_ = vec3.clone(voxelCoordinates);
      } else {
        vec3.copy(voxelCoordinates_, voxelCoordinates);
      }
    }
    this.changed.dispatch();
  }

  markSpatialCoordinatesChanged() {
    this.spatialCoordinatesValid = true;
    this.voxelCoordinates = null;
    this.changed.dispatch();
  }

  private handleVoxelSizeChanged() {
    if (this.voxelCoordinates != null && !this.spatialCoordinatesValid) {
      this.voxelSize.spatialFromVoxel(this.spatialCoordinates, this.voxelCoordinates);
      this.spatialCoordinatesValid = true;
    }
    this.voxelCoordinates = null;
    this.changed.dispatch();
  }

  toJSON() {
    let empty = true;
    let voxelSizeJson = this.voxelSize.toJSON();
    let obj: any = {};
    if (voxelSizeJson !== undefined) {
      empty = false;
      obj['voxelSize'] = voxelSizeJson;
    }
    if (this.voxelCoordinatesValid) {
      let voxelCoordinates = tempVec3;
      this.getVoxelCoordinates(voxelCoordinates);
      obj['voxelCoordinates'] = Array.prototype.slice.call(voxelCoordinates);
      empty = false;
    } else if (this.spatialCoordinatesValid) {
      obj['spatialCoordinates'] = Array.prototype.slice.call(this.spatialCoordinates);
      empty = false;
    }
    if (empty) {
      return undefined;
    }
    return obj;
  }

  restoreState(obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, 'voxelSize', x => {
      if (x !== undefined) {
        this.voxelSize.restoreState(x);
      }
    });
    this.spatialCoordinatesValid = false;
    verifyObjectProperty(obj, 'voxelCoordinates', x => {
      if (x !== undefined) {
        this.setVoxelCoordinates(parseFiniteVec(vec3.create(), x));
      }
    });
    verifyObjectProperty(obj, 'spatialCoordinates', x => {
      if (x !== undefined) {
        parseFiniteVec(this.spatialCoordinates, x);
        this.markSpatialCoordinatesChanged();
      }
    });
  }

  snapToVoxel() {
    if (!this.valid) {
      let {voxelCoordinates} = this;
      if (voxelCoordinates != null) {
        for (let i = 0; i < 3; ++i) {
          voxelCoordinates[i] = Math.round(voxelCoordinates[i]);
        }
        this.changed.dispatch();
      }
    } else {
      let spatialCoordinates = this.spatialCoordinates;
      let voxelSize = this.voxelSize.size;
      for (let i = 0; i < 3; ++i) {
        let voxelSizeValue = voxelSize[i];
        spatialCoordinates[i] = Math.round(spatialCoordinates[i] / voxelSizeValue) * voxelSizeValue;
      }
      this.changed.dispatch();
    }
  }

  assign(other: Borrowed<SpatialPosition>) {
    this.spatialCoordinatesValid = other.spatialCoordinatesValid;
    vec3.copy(this.spatialCoordinates, other.spatialCoordinates);
    const {voxelCoordinates} = other;
    this.voxelCoordinates = voxelCoordinates && vec3.clone(voxelCoordinates);
    this.changed.dispatch();
  }

  /**
   * Get the offset of `a` relative to `b`.
   */
  static getOffset(a: SpatialPosition, b: SpatialPosition): SpatialPositionOffset {
    if (a.spatialCoordinatesValid && b.spatialCoordinatesValid) {
      return {
        spatialOffset: vec3.subtract(vec3.create(), a.spatialCoordinates, b.spatialCoordinates)
      };
    }
    if (a.voxelCoordinates && b.voxelCoordinates) {
      if (a.voxelSize !== b.voxelSize) {
        throw new Error('Voxel offsets are only meaningful with identical voxelSize.');
      }
      return {voxelOffset: vec3.subtract(vec3.create(), a.voxelCoordinates, b.voxelCoordinates)};
    }
    return {};
  }
  static addOffset(
      target: SpatialPosition, source: SpatialPosition, offset: SpatialPositionOffset,
      scale: number = 1): void {
    const {spatialOffset, voxelOffset} = offset;
    if (spatialOffset !== undefined && source.spatialCoordinatesValid) {
      vec3.scaleAndAdd(target.spatialCoordinates, source.spatialCoordinates, spatialOffset, scale);
      target.markSpatialCoordinatesChanged();
    } else if (voxelOffset !== undefined && source.getVoxelCoordinates(tempVec3)) {
      target.setVoxelCoordinates(vec3.scaleAndAdd(tempVec3, tempVec3, voxelOffset, scale));
    }
  }
}

abstract class LinkedBase<T extends RefCounted&Trackable&{assign(other: T): void}> implements
    Trackable {
  value: T;
  get changed() {
    return this.value.changed;
  }
  constructor(public peer: Owned<T>, public link = new TrackableNavigationLink()) {}

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
    if (obj === undefined || Object.keys(obj).length === 0) {
      this.link.value = NavigationLinkType.LINKED;
      return;
    }
    verifyObject(obj);
    this.link.value = NavigationLinkType.UNLINKED;
    verifyObjectProperty(obj, 'value', x => {
      if (x !== undefined) {
        this.value.restoreState(x);
      }
    });
    verifyObjectProperty(obj, 'link', x => this.link.restoreState(x));
  }

  copyToPeer() {
    if (this.link.value !== NavigationLinkType.LINKED) {
      this.link.value = NavigationLinkType.UNLINKED;
      this.peer.assign(this.value);
      this.link.value = NavigationLinkType.LINKED;
    }
  }
}

export class LinkedSpatialPosition extends LinkedBase<SpatialPosition> {
  value = makeLinked(new SpatialPosition(this.peer.voxelSize.addRef()), this.peer, this.link, {
    assign: (a: SpatialPosition, b: SpatialPosition) => a.assign(b),
    isValid:
        (a: SpatialPosition) => {
          return a.spatialCoordinatesValid || a.voxelCoordinatesValid;
        },
    difference: SpatialPosition.getOffset,
    add: SpatialPosition.addOffset,
    subtract:
        (target: SpatialPosition, source: SpatialPosition, amount: SpatialPositionOffset) => {
          SpatialPosition.addOffset(target, source, amount, -1);
        },
  });

  protected getValueJson() {
    const value = this.value.toJSON() || {};
    delete value['voxelSize'];
    return value;
  }
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

export class Pose extends RefCounted {
  position: SpatialPosition;
  orientation: OrientationState;
  changed = new NullarySignal();
  constructor(position?: Owned<SpatialPosition>, orientation?: Owned<OrientationState>) {
    super();
    if (position == null) {
      position = new SpatialPosition();
    }
    this.position = position;
    if (orientation == null) {
      orientation = new OrientationState();
    }
    this.orientation = orientation;
    this.registerDisposer(this.position);
    this.registerDisposer(this.orientation);
    this.registerDisposer(this.position.changed.add(this.changed.dispatch));
    this.registerDisposer(this.orientation.changed.add(this.changed.dispatch));
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
  }

  toMat4(mat: mat4) {
    mat4.fromRotationTranslation(
        mat, this.orientation.orientation, this.position.spatialCoordinates);
  }

  toJSON() {
    let positionJson = this.position.toJSON();
    let orientationJson = this.orientation.toJSON();
    if (positionJson === undefined && orientationJson === undefined) {
      return undefined;
    }
    return {'position': positionJson, 'orientation': orientationJson};
  }

  restoreState(obj: any) {
    verifyObject(obj);
    verifyObjectProperty(obj, 'position', x => {
      if (x !== undefined) {
        this.position.restoreState(x);
      }
    });
    verifyObjectProperty(obj, 'orientation', x => {
      if (x !== undefined) {
        this.orientation.restoreState(x);
      }
    });
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
  translateAbsolute(translation: vec3) {
    vec3.add(this.position.spatialCoordinates, this.position.spatialCoordinates, translation);
    this.position.changed.dispatch();
  }
  translateRelative(translation: vec3) {
    if (!this.valid) {
      return;
    }
    const temp = tempVec3;
    vec3.transformQuat(temp, translation, this.orientation.orientation);
    vec3.add(this.position.spatialCoordinates, this.position.spatialCoordinates, temp);
    this.position.changed.dispatch();
  }
  translateVoxelsRelative(translation: vec3) {
    if (!this.valid) {
      return;
    }
    var temp = vec3.create();
    vec3.transformQuat(temp, translation, this.orientation.orientation);
    vec3.multiply(temp, temp, this.position.voxelSize.size);
    vec3.add(this.position.spatialCoordinates, this.position.spatialCoordinates, temp);
    this.position.changed.dispatch();
  }
  rotateRelative(axis: vec3, angle: number) {
    var temp = quat.create();
    quat.setAxisAngle(temp, axis, angle);
    var orientation = this.orientation.orientation;
    quat.multiply(orientation, orientation, temp);
    this.orientation.changed.dispatch();
  }

  rotateAbsolute(axis: vec3, angle: number, fixedPoint?: vec3) {
    var temp = quat.create();
    quat.setAxisAngle(temp, axis, angle);
    var orientation = this.orientation.orientation;
    if (fixedPoint !== undefined) {
      // We want the coordinates in the transformed coordinate frame of the fixed point to remain
      // the same after the rotation.

      // We have the invariants:
      // oldOrienation * fixedPointLocal + oldPosition == fixedPoint.
      // newOrientation * fixedPointLocal + newPosition == fixedPoint.

      // Therefore, we compute fixedPointLocal by:
      // fixedPointLocal == inverse(oldOrientation) * (fixedPoint - oldPosition).
      let {spatialCoordinates} = this.position;
      let fixedPointLocal = vec3.subtract(tempVec3, fixedPoint, spatialCoordinates);
      let invOrientation = quat.invert(tempQuat, orientation);
      vec3.transformQuat(fixedPointLocal, fixedPointLocal, invOrientation);

      // We then compute the newPosition by:
      // newPosition := fixedPoint - newOrientation * fixedPointLocal.
      quat.multiply(orientation, temp, orientation);
      vec3.transformQuat(spatialCoordinates, fixedPointLocal, orientation);
      vec3.subtract(spatialCoordinates, fixedPoint, spatialCoordinates);

      this.position.changed.dispatch();
    } else {
      quat.multiply(orientation, temp, orientation);
    }
    this.orientation.changed.dispatch();
  }
}

export class TrackableZoomState extends RefCounted {
  constructor(private value_ = Number.NaN, public defaultValue = value_) {
    super();
  }
  get value() {
    return this.value_;
  }
  set value(newValue: number) {
    if (newValue !== this.value_) {
      this.value_ = newValue;
      this.changed.dispatch();
    }
  }
  changed = new NullarySignal();

  toJSON() {
    let {value_, defaultValue} = this;
    if (Number.isNaN(value_) && Number.isNaN(defaultValue) || value_ === defaultValue) {
      return undefined;
    }
    return value_;
  }

  restoreState(obj: any) {
    if (typeof obj === 'number' && Number.isFinite(obj) && obj > 0) {
      this.value = obj;
    } else {
      this.value = this.defaultValue;
    }
  }

  reset() {
    this.value = this.defaultValue;
  }

  zoomBy(factor: number) {
    let {value_} = this;
    if (Number.isNaN(value_)) {
      return;
    }
    this.value = value_ * factor;
  }

  assign(other: TrackableZoomState) {
    this.value = other.value;
  }

  get valid() {
    return !Number.isNaN(this.value);
  }
}

export class LinkedZoomState extends LinkedBase<TrackableZoomState> {
  value = (() => {
    const self = new TrackableZoomState();
    const assign = (target: TrackableZoomState, source: TrackableZoomState) =>
        target.assign(source);
    const difference = (a: TrackableZoomState, b: TrackableZoomState) => {
      return a.value / b.value;
    };
    const add = (target: TrackableZoomState, source: TrackableZoomState, amount: number) => {
      target.value = source.value * amount;
    };
    const subtract = (target: TrackableZoomState, source: TrackableZoomState, amount: number) => {
      target.value = source.value / amount;
    };
    const isValid = (x: TrackableZoomState) => x.valid;
    return makeLinked(self, this.peer, this.link, {assign, isValid, difference, add, subtract});
  })();
}

export class NavigationState extends RefCounted {
  changed = new NullarySignal();
  zoomFactor: TrackableZoomState;

  constructor(
      public pose: Owned<Pose> = new Pose(),
      zoomFactor: number|Owned<TrackableZoomState> = Number.NaN) {
    super();
    if (typeof zoomFactor === 'number') {
      this.zoomFactor = new TrackableZoomState(zoomFactor);
    } else {
      this.zoomFactor = zoomFactor;
    }
    this.registerDisposer(this.zoomFactor);
    this.registerDisposer(pose);
    this.registerDisposer(this.pose.changed.add(() => {
      this.changed.dispatch();
    }));
    this.registerDisposer(this.zoomFactor.changed.add(() => {
      this.changed.dispatch();
    }));
    this.registerDisposer(this.voxelSize.changed.add(() => {
      this.handleVoxelSizeChanged();
    }));
    this.handleVoxelSizeChanged();
  }
  get voxelSize() {
    return this.pose.position.voxelSize;
  }

  /**
   * Resets everything.
   */
  reset() {
    this.pose.reset();
    this.zoomFactor.reset();
  }

  private setZoomFactorFromVoxelSize() {
    let {voxelSize} = this;
    if (voxelSize.valid) {
      this.zoomFactor.value = Math.min.apply(null, this.voxelSize.size);
    }
  }

  /**
   * Sets the zoomFactor to the minimum voxelSize if it is not already set.
   */
  private handleVoxelSizeChanged() {
    if (!this.zoomFactor.valid) {
      this.setZoomFactorFromVoxelSize();
    }
  }
  get position() {
    return this.pose.position;
  }
  toMat4(mat: mat4) {
    this.pose.toMat4(mat);
    let zoom = this.zoomFactor.value;
    mat4.scale(mat, mat, vec3.fromValues(zoom, zoom, zoom));
  }

  get valid() {
    return this.pose.valid;
  }

  toJSON() {
    let poseJson = this.pose.toJSON();
    let zoomFactorJson = this.zoomFactor.toJSON();
    if (poseJson === undefined && zoomFactorJson === undefined) {
      return undefined;
    }
    return {'pose': poseJson, 'zoomFactor': zoomFactorJson};
  }

  restoreState(obj: any) {
    try {
      verifyObject(obj);
      verifyObjectProperty(obj, 'pose', x => {
        if (x !== undefined) {
          this.pose.restoreState(x);
        }
      });
      verifyObjectProperty(obj, 'zoomFactor', x => {
        if (x !== undefined) {
          this.zoomFactor.restoreState(x);
        }
      });
      this.handleVoxelSizeChanged();
      this.changed.dispatch();
    } catch (parseError) {
      this.reset();
    }
  }

  zoomBy(factor: number) {
    this.zoomFactor.zoomBy(factor);
  }
}
