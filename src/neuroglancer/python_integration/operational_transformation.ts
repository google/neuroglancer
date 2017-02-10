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

/**
 * @file Implements an operational transformation client.
 */

import {getRandomHexString} from 'neuroglancer/util/random';
import {NullarySignal} from 'neuroglancer/util/signal';
import {RefCounted} from 'neuroglancer/util/disposable';
import {CompoundTrackable, Trackable} from 'neuroglancer/util/trackable';
import {TrackableValue} from 'neuroglancer/trackable_value';
import throttle from 'lodash/throttle';

interface LastSeenState {
  generation: number;
  info: any;
}

interface OperationImplementation<T, OpT> {
  /**
   * Constructor function.
   */
  type: { new(...args: any[]): T };
  id: string;
  combineOperations(a: OpT, b: OpT): OpT|null;
  transformOperations(a: OpT, b: OpT): [OpT|null, OpT|null];
  makeOperation(value: T, lastSeenState: LastSeenState): OpT|null;
  applyOperation(value: T, operation: OpT, lastSeenState: LastSeenState): void;
  makeValue?: (operation: OpT, lastSeenState: LastSeenState) => T;
}

const registeredIds = new Map<string, OperationImplementation<any, any>>();
const registeredTypes = new Map<any, OperationImplementation<any, any>>();

export function registerType<T, OpT>(transforms: OperationImplementation<T, OpT>) {
  registeredIds.set(transforms.id, transforms);
  registeredTypes.set(transforms.type, transforms);
}

function getOperationImplementation<T>(obj: T): OperationImplementation<T, any> {
  do {
    const result = registeredTypes.get(obj.constructor);
    if (result !== undefined) {
      return result;
    }
    obj = Object.getPrototypeOf(obj);
  } while (obj != null);
  return registeredTypes.get(TrackableValue)!;
  // throw new Error(`Type not supported for operational transformation: ${obj}`);
}

function getOperationImplementationById(id: string) {
  const result = registeredIds.get(id);
  if (result === undefined) {
    throw new Error(`Type id not supported for operational transformation: ${JSON.stringify(id)}.`);
  }
  return result;
}

interface Operation {
  [key: string]: any;
}

interface ValueOperation {
  t: 'value';
  value: any;
}


function applyOperation(state: Trackable, operation: Operation|null, lastSeenState: LastSeenState) {
  if (operation === null) {
    return;
  }
  const implementation = getOperationImplementationById(operation['t']);
  const expectedImplementation = getOperationImplementation(state);
  if (implementation !== expectedImplementation) {
    throw new Error(
        `State type ${JSON.stringify(expectedImplementation.id)} does not match ` +
        `operation id ${JSON.stringify(implementation.id)}.`);
  }
  implementation.applyOperation(state, operation, lastSeenState);
  lastSeenState.generation = state.changed.count;
}

function makeOperation(state: Trackable, lastSeenState: LastSeenState): Operation|null {
  const generation = state.changed.count;
  if (generation === lastSeenState.generation) {
    return null;
  }
  lastSeenState.generation = generation;
  const implementation = getOperationImplementation(state);
  return implementation.makeOperation(state, lastSeenState);
}

/**
 * Compute the combined operation corresponding to performing `a` and then `b`.
 */
function combineOperations(a: Operation|null|undefined, b: Operation|null|undefined): Operation|null {
  if (a == null) {
    return b ? b : null;
  }
  if (b == null) {
    return a;
  }
  const opType = a['t'];
  if (opType !== b['t']) {
    throw new Error(
        `Operation type mismatch: a=${JSON.stringify(a['t'])}, b=${JSON.stringify(b['t'])}`);
  }
  const implementation = getOperationImplementationById(opType);
  return implementation.combineOperations(a, b);
}

/**
 * Return [newClientOp, newServerOp], with the property that:
 *
 *   combineOperations(clientOp, newServerOp)  is equivalent to
 *   combineOperations(serverOp, newClientOp).
 */
function transformOperations(
    clientOp: Operation|null|undefined,
    serverOp: Operation|null|undefined): [Operation | null, Operation | null] {
  if (clientOp == null || serverOp == null) {
    return [clientOp ? clientOp : null, serverOp ? serverOp : null];
  }

  const clientType = clientOp['t'], serverType = serverOp['t'];
  if (clientType !== serverType) {
    throw new Error(
        `Operation type mismatch: client=${JSON.stringify(clientType)},` +
        ` server=${JSON.stringify(serverType)}`);
  }
  const implementation = getOperationImplementationById(clientType);
  return implementation.transformOperations(clientOp, serverOp);
}

export interface OperationToSubmit {
  operation: any;
  id: string;
}

export class OperationalTransformationClient extends RefCounted {
  /**
   * Caches information about the last-seen version of `state` needed to compute an operation
   * reflecting the changes since then.
   */
  private lastSeenState: LastSeenState = {generation: -1, info: undefined};

  /**
   * Server generation reflected in `state`.
   */
  serverGeneration: number = -1;

  /**
   * Operation reflecting local changes that has been submitted to the server already.  Only a
   * single unacknolwedged operation may be submitted to the server.  If undefined, then there is no
   * unacknowledged operation.
   */
  private submittedOperation: OperationToSubmit|undefined;

  /**
   * Signal dispatched when a new operation is ready to submit.
   */
  operationToSubmitPending = new NullarySignal();

  /**
   * Equal to true if, and only if, a subsequent call to getOperationToSubmit(false) will return
   * true.
   */
  get hasOperationToSubmit() {
    return this.serverGeneration !== -1 && this.submittedOperation === undefined &&
        this.pendingOperation !== null;
  }

  // FIXME: Maybe remove this if unneeded.
  get isInitialized() {
    return this.serverGeneration !== -1;
  }

  /**
   * Get an operation to submit.
   *
   * @param resubmit If true, will also return a previously submitted but not yet acknolwedged
   * operation (as is needed when the client has just reconnected).
   */
  getOperationToSubmit(resubmit: boolean) {
    let {submittedOperation} = this;
    if (submittedOperation === undefined) {
      const {serverGeneration} = this;
      if (serverGeneration !== -1) {
        const {pendingOperation} = this;
        if (pendingOperation !== null) {
          submittedOperation = this.submittedOperation = {
            operation: pendingOperation,
            id: getRandomHexString()
          };
          this.pendingOperation = null;
        }
      }
      return submittedOperation;
    } else if (resubmit) {
      return submittedOperation;
    }
    return undefined;
  }

  /**
   * Operation reflecting the local changes to the state, relative to `serverGeneration`, on top of
   * submittedOperation, as of the time `lastSeenStateInformation` was updated.
   */
  private pendingOperation: Operation|null = null;

  constructor(public state: Trackable, updateDelayMilliseconds: number) {
    super();
    const throttledHandleStateChanged =
        throttle(() => this.handleStateChanged(), updateDelayMilliseconds);
    this.registerDisposer(state.changed.add(throttledHandleStateChanged));
    this.registerDisposer(() => throttledHandleStateChanged.cancel());
  }

  private handleStateChanged () {
    const alreadyHasOperationToSubmit = this.hasOperationToSubmit;
    this.updateLastSeenState();
    if (alreadyHasOperationToSubmit !== this.hasOperationToSubmit) {
      this.operationToSubmitPending.dispatch();
    }
  }

  /**
   * Update `lastSeenStateInformation` to reflect the current `state`.  If any changes have
   * occurred, update `pendingOperation` to reflect the changes.
   */
  private updateLastSeenState() {
    const {state} = this;
    const op = makeOperation(state, this.lastSeenState);
    if (op !== null) {
      this.pendingOperation = combineOperations(this.pendingOperation, op);
    }
  }

  /**
   * Apply an operation to the state, and update `lastSeenStateInformation` accordingly.
   */
  private applyOperation(op: Operation) {
    const {state} = this;
    // Make sure we capture any state changes not yet seen before applying the op.
    this.updateLastSeenState();
    applyOperation(state, op, this.lastSeenState);
  }

  applyChange(
      newServerGeneration: number, serverOp: Operation|null,
      acknowledgedOperationId: string|undefined) {
    const alreadyHasOperationToSubmit = this.hasOperationToSubmit;

    // Make sure we capture any state changes not yet seen.
    this.updateLastSeenState();

    const {submittedOperation} = this;
    if (submittedOperation !== undefined) {
      [submittedOperation.operation, serverOp] =
          transformOperations(submittedOperation.operation, serverOp);
    }

    [this.pendingOperation, serverOp] = transformOperations(this.pendingOperation, serverOp);

    applyOperation(this.state, serverOp, this.lastSeenState);

    if (acknowledgedOperationId !== undefined) {
      if (submittedOperation === undefined || submittedOperation.id !== acknowledgedOperationId) {
        throw new Error(`Unexpected acknowledgement.`);
      }
      this.submittedOperation = undefined;
    }
    this.serverGeneration = newServerGeneration;

    if (this.hasOperationToSubmit !== alreadyHasOperationToSubmit) {
      this.operationToSubmitPending.dispatch();
    }
  }

  /**
   * Resets `state` and then applies `serverOp` to it.
   */
  initialize(newServerGeneration: number, serverOp: Operation|null) {
    this.state.reset();
    this.updateLastSeenState();
    this.pendingOperation = null;
    this.submittedOperation = undefined;
    applyOperation(this.state, serverOp, this.lastSeenState);
    this.serverGeneration = newServerGeneration;
  }
}


interface CompoundOperation {
  t: 'compound';
  children: {[key: string]: Operation};
}

interface CompoundTrackableEntryCache {
  obj: Trackable;
  lastSeenState: LastSeenState;
}

function applyCompoundTrackableOperation(
    state: CompoundTrackable, operation: CompoundOperation,
    lastSeenState: {info: Map<string, CompoundTrackableEntryCache>| undefined}) {
  const children = operation['children'];
  let entryCache = lastSeenState.info;
  if (entryCache === undefined) {
    entryCache = lastSeenState.info = new Map<string, CompoundTrackableEntryCache>();
  }
  for (let key in children) {
    let child = state.children.get(key);
    if (child === undefined) {
      throw new Error(`Child not defined: ${JSON.stringify(key)}.`);
    }
    // FIXME: Handle add/deletes?
    let entryData = entryCache.get(key);
    if (entryData === undefined) {
      entryData = {obj: child, lastSeenState: {generation: -1, info: undefined}};
      entryCache.set(key, entryData);
    }
    try {
      applyOperation(child, children[key], entryData.lastSeenState);
    } catch (error) {
      throw new Error(
          `Failed to apply operation to child ${JSON.stringify(key)}: ${error.message}.`);
    }
  }
}

function combineCompoundTrackableOperations(
    a: CompoundOperation, b: CompoundOperation): CompoundOperation|null {
  const aChildren = a['children'];
  const bChildren = b['children'];
  const result: {[key: string]: Operation} = {};
  for (const key in aChildren) {
    const op = combineOperations(aChildren[key], bChildren[key]);
    if (op !== null) {
      result[key] = op;
    }
  }
  for (const key in bChildren) {
    if (aChildren[key] === undefined) {
      result[key] = bChildren[key];
    }
  }
  return constructCompoundOperation(result);
}

function constructCompoundOperation(children: {[key: string]: Operation}): CompoundOperation|null {
  for (const _ in children) {
    return {'t': 'compound', 'children': children};
  }
  return null;
}


function transformCompoundOperations(clientOp: CompoundOperation, serverOp: CompoundOperation):
    [CompoundOperation | null, CompoundOperation | null] {
  const clientChildren = clientOp['children'], serverChildren = serverOp['children'];
  const newClientChildren: {[key: string]: Operation} = {};
  const newServerChildren: {[key: string]: Operation} = {};
  for (const key in clientChildren) {
    const [newClientChild, newServerChild] =
        transformOperations(clientChildren[key], serverChildren[key]);
    if (newClientChild !== null) {
      newClientChildren[key] = newClientChild;
    }
    if (newServerChild !== null) {
      newServerChildren[key] = newServerChild;
    }
    // FIXME: handle add/delete
  }
  return [
    constructCompoundOperation(newClientChildren), constructCompoundOperation(newServerChildren)
  ];
}

function makeCompoundTrackableOperation(
    state: CompoundTrackable,
    lastSeenState: {info: Map<string, CompoundTrackableEntryCache>| undefined}): CompoundOperation {
  let entryCache = lastSeenState.info;
  if (entryCache === undefined) {
    entryCache = lastSeenState.info = new Map<string, CompoundTrackableEntryCache>();
  }
  const childOps: {[key: string]: any} = {};
  for (let [key, child] of state.children) {
    let entryData = entryCache.get(key);
    if (entryData === undefined) {
      entryData = {obj: child, lastSeenState: {generation: -1, info: undefined}};
      entryCache.set(key, entryData);
    } else if (entryData.obj !== child) {
      entryData.obj = child;
      const entryLastState = entryData.lastSeenState;
      entryLastState.generation = -1;
      entryLastState.info = undefined;
    }
    let op = makeOperation(child, entryData.lastSeenState);
    if (op !== null) {
      childOps[key] = op;
    }
  }
  // FIXME: handle deletes
  return {'t': 'compound', 'children': childOps};
}

registerType({
  type: CompoundTrackable,
  id: 'compound',
  combineOperations: combineCompoundTrackableOperations,
  transformOperations: transformCompoundOperations,
  makeOperation: makeCompoundTrackableOperation,
  applyOperation: applyCompoundTrackableOperation,
  makeValue: (operation, lastSeenState) => {
    const value = new CompoundTrackable();
    applyCompoundTrackableOperation(value, operation, lastSeenState);
    return value;
  },
});

interface ListRetainOperation {
  t: 'retain';
  count: number;
}

interface ListDeleteOperation {
  t: 'delete';
  count: number;
}

interface ListMoveOperation {
  t: 'move';
  skip: number;
  child: Operation;
}

interface ListInsertOperation {
  t: 'insert';
  init: any;
  child: Operation;
}

interface ListOperation {
  t: 'list';
  children: (ListRetainOperation|ListDeleteOperation|ListMoveOperation|ListInsertOperation)[];
}

function combineListOperations(a: ListOperation, b: ListOperation) {
  const aChildren = a['children'], bChildren = b['children'];
  let aIndex = 0, bIndex = 0;
}

registerType({
  type: TrackableValue,
  id: 'value',
  combineOperations: (_a: ValueOperation, b: ValueOperation) => b,
  transformOperations: (_clientOp: ValueOperation, serverOp: ValueOperation) => [null, serverOp],
  makeOperation: state => (<ValueOperation>{'t': 'value', 'value': state.toJSON()}),
  applyOperation: (state, operation) => {
    state.restoreState(operation['value']);
  },
  makeValue: () => {
    throw new Error(`Not supported`);
  },
});
