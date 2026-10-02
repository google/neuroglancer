/**
 * @license
 * Copyright 2026 Google Inc.
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

import { TrackableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  parseArray,
  parseUint64,
  verify3dVec,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

/**
 * Representation-neutral endpoint identity for skeleton path finding.
 *
 * Spatial skeletons use their node and segment IDs. A regular skeleton can
 * use its object ID as `segmentId` and a stable vertex index as `nodeId`.
 */
export interface SkeletonFindPathEndpoint {
  readonly nodeId: bigint;
  readonly segmentId: bigint;
  readonly position: Float32Array;
}

export interface SkeletonFindPathResultNode {
  readonly nodeId: bigint;
  readonly position: Float32Array;
}

export interface SkeletonFindPathEndpointJson {
  nodeId: string;
  segmentId: string;
  position: number[];
}

export interface SkeletonFindPathResultNodeJson {
  nodeId: string;
  position: number[];
}

export interface SkeletonFindPathStateJson {
  source?: SkeletonFindPathEndpointJson;
  target?: SkeletonFindPathEndpointJson;
  result?: SkeletonFindPathResultNodeJson[];
}

export interface SkeletonDataSourceStateJson {
  findPath?: SkeletonFindPathStateJson;
}

function restoreEndpoint(value: unknown): SkeletonFindPathEndpoint {
  return {
    nodeId: verifyObjectProperty(value, "nodeId", parseUint64),
    segmentId: verifyObjectProperty(value, "segmentId", parseUint64),
    position: verifyObjectProperty(value, "position", verify3dVec),
  };
}

function restoreResultNode(value: unknown): SkeletonFindPathResultNode {
  return {
    nodeId: verifyObjectProperty(value, "nodeId", parseUint64),
    position: verifyObjectProperty(value, "position", verify3dVec),
  };
}

function endpointToJson(
  endpoint: SkeletonFindPathEndpoint,
): SkeletonFindPathEndpointJson {
  return {
    nodeId: endpoint.nodeId.toString(),
    segmentId: endpoint.segmentId.toString(),
    position: Array.from(endpoint.position),
  };
}

function resultNodeToJson(
  node: SkeletonFindPathResultNode,
): SkeletonFindPathResultNodeJson {
  return {
    nodeId: node.nodeId.toString(),
    position: Array.from(node.position),
  };
}

/**
 * Serializable state shared by skeleton find-path implementations.
 *
 * Source ownership belongs to the skeleton datasource containing this object,
 * matching Graphene's datasource-owned state model. Selection constraints are
 * enforced by the tool that populates this state.
 */
export class SkeletonFindPathState extends RefCounted implements Trackable {
  readonly changed = new NullarySignal();

  private readonly sourceValue = new TrackableValue<
    SkeletonFindPathEndpoint | undefined
  >(undefined, (value) => value);
  private readonly targetValue = new TrackableValue<
    SkeletonFindPathEndpoint | undefined
  >(undefined, (value) => value);
  private readonly resultValue = new TrackableValue<
    readonly SkeletonFindPathResultNode[] | undefined
  >(undefined, (value) => value);

  constructor() {
    super();
    this.registerDisposer(
      this.sourceValue.changed.add(() => {
        this.resultValue.reset();
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.targetValue.changed.add(() => {
        this.resultValue.reset();
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(this.resultValue.changed.add(this.changed.dispatch));
  }

  get source() {
    return this.sourceValue.value;
  }

  get target() {
    return this.targetValue.value;
  }

  get result() {
    return this.resultValue.value;
  }

  setSource(value: SkeletonFindPathEndpoint | undefined): boolean {
    if (this.source === value) return false;
    this.sourceValue.value = value;
    return true;
  }

  setTarget(value: SkeletonFindPathEndpoint | undefined): boolean {
    if (this.target === value) return false;
    this.targetValue.value = value;
    return true;
  }

  setEndpoints(
    source: SkeletonFindPathEndpoint | undefined,
    target: SkeletonFindPathEndpoint | undefined,
  ): boolean {
    const changed = this.source !== source || this.target !== target;
    this.sourceValue.value = source;
    this.targetValue.value = target;
    return changed;
  }

  setResult(value: readonly SkeletonFindPathResultNode[] | undefined): boolean {
    if (this.result === value) return false;
    this.resultValue.value = value;
    return true;
  }

  /** Clears only the resolved result while preserving both endpoints. */
  invalidateResult(): boolean {
    return this.setResult(undefined);
  }

  /** Clears the endpoints and resolved result. */
  clear(): boolean {
    const changed =
      this.source !== undefined ||
      this.target !== undefined ||
      this.result !== undefined;
    this.sourceValue.reset();
    this.targetValue.reset();
    this.resultValue.reset();
    return changed;
  }

  reset(): void {
    this.clear();
  }

  toJSON(): SkeletonFindPathStateJson | undefined {
    const { source, target, result } = this;
    if (source === undefined && target === undefined && result === undefined) {
      return undefined;
    }
    return {
      source: source === undefined ? undefined : endpointToJson(source),
      target: target === undefined ? undefined : endpointToJson(target),
      result: result === undefined ? undefined : result.map(resultNodeToJson),
    };
  }

  restoreState(value: unknown): void {
    if (value === undefined) {
      this.reset();
      return;
    }
    const obj = verifyObject(value);
    this.sourceValue.value = verifyOptionalObjectProperty(
      obj,
      "source",
      restoreEndpoint,
    );
    this.targetValue.value = verifyOptionalObjectProperty(
      obj,
      "target",
      restoreEndpoint,
    );
    this.resultValue.value = verifyOptionalObjectProperty(
      obj,
      "result",
      (result) => parseArray(result, restoreResultNode),
    );
  }
}

/**
 * Skeleton-tool state owned by a single datasource.
 *
 * Keeping this container representation-neutral mirrors Graphene's state
 * model and lets future regular-skeleton datasources reuse Find Path without
 * adding segmentation-layer state or source locators.
 */
export class SkeletonDataSourceState extends RefCounted implements Trackable {
  readonly changed = new NullarySignal();
  readonly findPathState = this.registerDisposer(new SkeletonFindPathState());

  constructor(value?: unknown) {
    super();
    this.registerDisposer(
      this.findPathState.changed.add(this.changed.dispatch),
    );
    if (value !== undefined) {
      this.restoreState(value);
    }
  }

  reset() {
    this.findPathState.reset();
  }

  toJSON(): SkeletonDataSourceStateJson | undefined {
    const findPath = this.findPathState.toJSON();
    return findPath === undefined ? undefined : { findPath };
  }

  restoreState(value: unknown) {
    const obj = verifyObject(value);
    verifyOptionalObjectProperty(obj, "findPath", (findPath) => {
      this.findPathState.restoreState(findPath);
    });
  }
}
