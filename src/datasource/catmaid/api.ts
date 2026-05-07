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

import { Unpackr } from "msgpackr";
import { fetchOkWithCredentials } from "#src/credentials_provider/http_request.js";
import type { CredentialsProvider } from "#src/credentials_provider/index.js";
import type {
  EditableSpatiallyIndexedSkeletonSource,
  SpatiallyIndexedSkeletonAddNodeResult,
  SpatiallyIndexedSkeletonDeleteNodeResult,
  SpatiallyIndexedSkeletonDescriptionUpdateResult,
  SpatiallyIndexedSkeletonEditContext,
  SpatiallyIndexedSkeletonInsertNodeResult,
  SpatiallyIndexedSkeletonMergeResult,
  SpatiallyIndexedSkeletonMetadata,
  SpatiallyIndexedSkeletonNavigationTarget,
  SpatiallyIndexedSkeletonNode,
  SpatiallyIndexedSkeletonNodeRevisionResult,
  SpatiallyIndexedSkeletonNodeRevisionUpdate,
  SpatiallyIndexedSkeletonNodeBase,
  SpatiallyIndexedSkeletonRerootResult,
  SpatiallyIndexedSkeletonSplitResult,
} from "#src/skeleton/api.js";
import { SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES } from "#src/skeleton/api.js";
import { getDefaultSpatiallyIndexedSkeletonChunkSize } from "#src/skeleton/spatial_chunk_sizing.js";
import { HttpError } from "#src/util/http_request.js";

interface CatmaidStackInfo {
  dimension: { x: number; y: number; z: number };
  resolution: { x: number; y: number; z: number };
  translation: { x: number; y: number; z: number };
  metadata?: {
    cache_provider?: string;
    spatial_skeleton_chunk_sizes?: Array<readonly [number, number, number]>;
  };
}

export interface CatmaidToken {
  token?: string;
}

export const credentialsKey = "CATMAID";
const CATMAID_NO_MATCHING_NODE_PROVIDER_ERROR =
  "Could not find matching node provider for request";
const CATMAID_STATE_MATCHING_ERROR_TYPE = "StateMatchingError";

type CatmaidStatePayload = object;

interface CatmaidDeleteNodeOptions {
  childNodeIds?: readonly number[];
  editContext?: SpatiallyIndexedSkeletonEditContext;
}

class CatmaidNotFoundError extends Error {
  constructor(detail?: string) {
    super(detail ?? "CATMAID resource not found.");
    this.name = "CatmaidNotFoundError";
  }
}

export class CatmaidStateValidationError extends Error {
  constructor(detail?: string) {
    super(
      detail === undefined
        ? "CATMAID rejected the edit because the inspected skeleton is out of date. Refresh the skeleton and try again."
        : `CATMAID rejected the edit because the inspected skeleton is out of date. Refresh the skeleton and try again. ${detail}`,
    );
    this.name = "CatmaidStateValidationError";
  }
}

const CATMAID_TRUE_END_LABEL = "ends";
const CATMAID_CLOSED_END_LABEL_PATTERNS = [
  /^uncertain continuation$/i,
  /^not a branch$/i,
  /^soma$/i,
  /^(really|uncertain|anterior|posterior)?\s?ends?$/i,
];

function isCatmaidClosedEndLabel(label: string) {
  const normalized = label.trim();
  return (
    normalized.length > 0 &&
    CATMAID_CLOSED_END_LABEL_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    )
  );
}

function includesNoMatchingNodeProviderError(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.includes(CATMAID_NO_MATCHING_NODE_PROVIDER_ERROR)
  );
}

function isNoMatchingNodeProviderErrorPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const value = payload as { error?: unknown; detail?: unknown };
  return (
    includesNoMatchingNodeProviderError(value.error) ||
    includesNoMatchingNodeProviderError(value.detail)
  );
}

function getCatmaidErrorMessage(payload: unknown): string | undefined {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const value = payload as { error?: unknown };
  return typeof value.error === "string" ? value.error.trim() : undefined;
}

function isCatmaidNotFoundPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return false;
  const value = payload as { detail?: unknown };
  return (
    typeof value.detail === "string" && value.detail.includes("doesn't exist")
  );
}

function isCatmaidStateMatchingErrorPayload(payload: unknown): boolean {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return false;
  }
  const value = payload as { type?: unknown };
  return value.type === CATMAID_STATE_MATCHING_ERROR_TYPE;
}

interface ParsedCatmaidNodeLabel {
  label: string;
  time?: number;
}

function normalizeCatmaidDescription(
  labels: readonly ParsedCatmaidNodeLabel[] | undefined,
): string | undefined {
  if (labels === undefined || labels.length === 0) {
    return undefined;
  }
  const descriptionLabels = labels.filter(
    ({ label }) =>
      label.trim().length > 0 &&
      label.trim().toLowerCase() !== CATMAID_TRUE_END_LABEL &&
      !isCatmaidClosedEndLabel(label),
  );
  const timedDescriptionLabels = descriptionLabels.filter(
    ({ time }) => time !== undefined,
  );
  const currentDescriptionLabels =
    timedDescriptionLabels.length === 0
      ? descriptionLabels
      : (() => {
          const latestTime = Math.max(
            ...timedDescriptionLabels.map(({ time }) => time!),
          );
          return timedDescriptionLabels.filter(
            ({ time }) => time === latestTime,
          );
        })();
  return currentDescriptionLabels.length === 0
    ? undefined
    : currentDescriptionLabels.map(({ label }) => label).join("\n");
}

function parseCatmaidLabelNodeReference(entry: unknown):
  | {
      nodeId: number;
      time?: number;
    }
  | undefined {
  const rawNodeId = Array.isArray(entry) ? entry[0] : entry;
  const nodeId = Math.round(Number(rawNodeId));
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return undefined;
  const time = Array.isArray(entry)
    ? getComparableCatmaidRevisionTime(entry[1])
    : undefined;
  return { nodeId, time };
}

function addParsedCatmaidNodeLabel(
  labelsByNodeId: Map<number, ParsedCatmaidNodeLabel[]>,
  nodeId: number,
  label: ParsedCatmaidNodeLabel,
) {
  const existingLabels = labelsByNodeId.get(nodeId);
  if (existingLabels === undefined) {
    labelsByNodeId.set(nodeId, [label]);
    return;
  }
  if (
    !existingLabels.some(
      (existingLabel) =>
        existingLabel.label === label.label &&
        existingLabel.time === label.time,
    )
  ) {
    existingLabels.push(label);
  }
}

function parseCatmaidNodeLabels(
  rawLabels: unknown,
): Map<number, ParsedCatmaidNodeLabel[]> {
  const labelsByNodeId = new Map<number, ParsedCatmaidNodeLabel[]>();
  if (rawLabels === null || typeof rawLabels !== "object") {
    return labelsByNodeId;
  }
  for (const [key, value] of Object.entries(
    rawLabels as Record<string, unknown>,
  )) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const stringValues = value.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (stringValues.length === value.length) {
      const nodeId = Number(key);
      if (!Number.isFinite(nodeId)) continue;
      const labels = stringValues
        .map((label) => label.trim())
        .filter((label) => label.length > 0);
      if (labels.length === 0) continue;
      labelsByNodeId.set(
        Math.round(nodeId),
        labels.map((label) => ({ label })),
      );
      continue;
    }
    const nodeReferences = value.map(parseCatmaidLabelNodeReference);
    if (nodeReferences.some((nodeReference) => nodeReference === undefined))
      continue;
    const label = key.trim();
    if (label.length === 0) continue;
    for (const nodeReference of nodeReferences) {
      if (nodeReference === undefined) continue;
      addParsedCatmaidNodeLabel(labelsByNodeId, nodeReference.nodeId, {
        label,
        time: nodeReference.time,
      });
    }
  }
  return labelsByNodeId;
}

function getCatmaidNodeDescriptions(
  labelsByNodeId: ReadonlyMap<number, readonly ParsedCatmaidNodeLabel[]>,
) {
  const descriptionsByNodeId = new Map<number, string>();
  for (const [nodeId, labels] of labelsByNodeId) {
    const description = normalizeCatmaidDescription(labels);
    if (description !== undefined) {
      descriptionsByNodeId.set(nodeId, description);
    }
  }
  return descriptionsByNodeId;
}

function getCatmaidTrueEndNodes(
  labelsByNodeId: ReadonlyMap<number, readonly ParsedCatmaidNodeLabel[]>,
) {
  const trueEndByNodeId = new Map<number, true>();
  for (const [nodeId, labels] of labelsByNodeId) {
    const isTrueEnd = labels.some(
      ({ label }) => label.trim().toLowerCase() === CATMAID_TRUE_END_LABEL,
    );
    if (isTrueEnd) {
      trueEndByNodeId.set(nodeId, true);
    }
  }
  return trueEndByNodeId;
}

async function tryReadJsonPayload(
  response: Response,
): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function tryReadErrorPayload(
  response: Response,
): Promise<unknown | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return tryReadJsonPayload(response);
  }
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  } catch {
    return undefined;
  }
}

function mapCatmaidConfidenceToPercent(confidence: number | undefined) {
  if (confidence === undefined) return undefined;
  const normalized = Math.max(
    1,
    Math.min(
      SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES.length,
      Math.round(confidence),
    ),
  );
  return SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES[normalized - 1];
}

function mapPercentConfidenceToCatmaid(confidence: number) {
  const normalized = Math.max(
    SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES[0],
    Math.min(
      SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES[
        SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES.length - 1
      ],
      confidence,
    ),
  );
  let bestIndex = 0;
  let bestDistance = Math.abs(
    SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES[0] - normalized,
  );
  for (
    let i = 1;
    i < SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES.length;
    ++i
  ) {
    const candidate = SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES[i];
    const distance = Math.abs(candidate - normalized);
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        candidate > SPATIALLY_INDEXED_SKELETON_CONFIDENCE_VALUES[bestIndex])
    ) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex + 1;
}

function getCatmaidProjectSpaceBounds(info: CatmaidStackInfo): {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
} {
  const { dimension, resolution, translation } = info;
  const offsetX = translation?.x ?? 0;
  const offsetY = translation?.y ?? 0;
  const offsetZ = translation?.z ?? 0;

  // CATMAID treenode coordinates and grid cache cell sizes are in project-space nanometers.
  return {
    min: { x: offsetX, y: offsetY, z: offsetZ },
    max: {
      x: offsetX + dimension.x * resolution.x,
      y: offsetY + dimension.y * resolution.y,
      z: offsetZ + dimension.z * resolution.z,
    },
  };
}

function normalizeBoundingBoxForNodeList(boundingBox: {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}) {
  const left = Math.floor(boundingBox.min.x);
  const top = Math.floor(boundingBox.min.y);
  const z1 = Math.floor(boundingBox.min.z);

  // CATMAID treats right/bottom as inclusive and z2 as exclusive for grid-cell index filtering.
  // Use ceil and ensure a positive extent on each axis.
  const right = Math.max(left + 1, Math.ceil(boundingBox.max.x));
  const bottom = Math.max(top + 1, Math.ceil(boundingBox.max.y));
  const z2 = Math.max(z1 + 1, Math.ceil(boundingBox.max.z));

  return { left, top, z1, right, bottom, z2 };
}

function appendNodeUpdateRows(
  body: URLSearchParams,
  key: string,
  rows: Array<[number, number, number, number]>,
) {
  // CATMAID get_request_list parses nested lists from bracketed keys
  // (e.g. t[0][0]=id, t[0][1]=x, ...), not from a JSON string.
  for (let rowIndex = 0; rowIndex < rows.length; ++rowIndex) {
    const row = rows[rowIndex];
    for (let colIndex = 0; colIndex < row.length; ++colIndex) {
      body.append(`${key}[${rowIndex}][${colIndex}]`, row[colIndex].toString());
    }
  }
}

function appendScalarList(
  body: URLSearchParams,
  key: string,
  values: readonly number[],
) {
  for (let index = 0; index < values.length; ++index) {
    body.append(`${key}[${index}]`, values[index].toString());
  }
}

function appendCatmaidState(
  body: URLSearchParams,
  state?: CatmaidStatePayload,
) {
  if (state === undefined) {
    return;
  }
  body.append("state", JSON.stringify(state));
}

function normalizeCatmaidRevisionToken(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 1e12 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string") {
    const normalizedValue = value.trim();
    if (normalizedValue.length > 0) {
      return normalizedValue;
    }
  }
  return undefined;
}

const CATMAID_TIMESTAMP_WITH_SPACE_PATTERN =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})$/;

function getComparableCatmaidRevisionTime(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    return undefined;
  }
  const parsedValue = Date.parse(
    normalizedValue.replace(CATMAID_TIMESTAMP_WITH_SPACE_PATTERN, "$1T$2$3"),
  );
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function isCatmaidLiveHistoryRow(row: readonly unknown[]) {
  const ordering = Number(row[10]);
  if (Number.isFinite(ordering)) {
    return Math.round(ordering) === 1;
  }
  if (row.length < 10) {
    return true;
  }
  const lowerBound = getComparableCatmaidRevisionTime(row[8]);
  const upperBound = getComparableCatmaidRevisionTime(row[9]);
  if (lowerBound === undefined || upperBound === undefined) {
    return true;
  }
  return upperBound <= lowerBound;
}

function getCatmaidHistoryRevisionToken(
  row: readonly unknown[],
): string | undefined {
  return normalizeCatmaidRevisionToken(row[8]);
}

function parseCatmaidSkeletonRootTarget(
  response: any,
): SpatiallyIndexedSkeletonNavigationTarget {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(
      "CATMAID skeleton root endpoint returned an unexpected response format.",
    );
  }

  const { root_id, x, y, z } = response as Record<string, unknown>;
  const nodeId = Number(root_id);
  const px = Number(x);
  const py = Number(y);
  const pz = Number(z);

  if (
    Number.isSafeInteger(nodeId) &&
    nodeId > 0 &&
    Number.isFinite(px) &&
    Number.isFinite(py) &&
    Number.isFinite(pz)
  ) {
    return { nodeId, x: px, y: py, z: pz };
  }

  throw new Error(
    "CATMAID skeleton root endpoint returned an unexpected response format.",
  );
}

function requireCatmaidRevisionToken(
  revisionToken: string | undefined,
  operation: string,
  role: string,
) {
  if (revisionToken === undefined) {
    throw new Error(
      `CATMAID ${operation} is missing the required ${role} revision state.`,
    );
  }
  return revisionToken;
}

function buildCatmaidNodeState(
  operation: string,
  editContext?: SpatiallyIndexedSkeletonEditContext,
  expectedNodeId?: number,
) {
  const node = editContext?.node;
  if (node === undefined) {
    throw new Error(`CATMAID ${operation} requires inspected node state.`);
  }
  if (expectedNodeId !== undefined && node.nodeId !== expectedNodeId) {
    throw new Error(
      `CATMAID ${operation} node state does not match requested node id ${expectedNodeId}.`,
    );
  }
  return {
    edition_time: requireCatmaidRevisionToken(
      node.revisionToken,
      operation,
      "node",
    ),
  };
}

function buildCatmaidMultiNodeState(
  operation: string,
  editContext?: SpatiallyIndexedSkeletonEditContext,
  expectedNodeIds?: readonly number[],
) {
  const nodes =
    editContext?.nodes ??
    (editContext?.node === undefined ? undefined : [editContext.node]);
  if (nodes === undefined || nodes.length === 0) {
    throw new Error(`CATMAID ${operation} requires inspected node state.`);
  }
  if (
    expectedNodeIds !== undefined &&
    (nodes.length !== expectedNodeIds.length ||
      nodes.some((node, index) => node.nodeId !== expectedNodeIds[index]))
  ) {
    throw new Error(
      `CATMAID ${operation} node state does not match the requested node ids.`,
    );
  }
  return nodes.map((node): [number, string] => [
    node.nodeId,
    requireCatmaidRevisionToken(node.revisionToken, operation, "node"),
  ]);
}

function buildCatmaidAddNodeState(
  parentId: number | undefined,
  editContext?: SpatiallyIndexedSkeletonEditContext,
) {
  if (parentId === undefined) {
    return {
      parent: [-1, ""],
    };
  }
  const parentNode = editContext?.node;
  if (parentNode === undefined) {
    throw new Error(
      "CATMAID add-node with a parent requires inspected parent state.",
    );
  }
  if (parentNode.nodeId !== parentId) {
    throw new Error(
      `CATMAID add-node parent state does not match requested parent id ${parentId}.`,
    );
  }
  return {
    parent: [
      parentNode.nodeId,
      requireCatmaidRevisionToken(
        parentNode.revisionToken,
        "add-node",
        "parent",
      ),
    ],
  };
}

function buildCatmaidNeighborhoodState(
  operation: string,
  editContext?: SpatiallyIndexedSkeletonEditContext,
  options: {
    expectedNodeId?: number;
    expectedChildIds?: readonly number[];
  } = {},
) {
  const node = editContext?.node;
  if (node === undefined) {
    throw new Error(`CATMAID ${operation} requires inspected node state.`);
  }
  if (
    options.expectedNodeId !== undefined &&
    node.nodeId !== options.expectedNodeId
  ) {
    throw new Error(
      `CATMAID ${operation} node state does not match requested node id ${options.expectedNodeId}.`,
    );
  }
  if (
    node.parentNodeId === undefined
      ? editContext?.parent !== undefined
      : editContext?.parent === undefined
  ) {
    throw new Error(
      `CATMAID ${operation} parent state does not match the cached skeleton neighborhood.`,
    );
  }
  if (
    editContext?.parent !== undefined &&
    node.parentNodeId !== editContext.parent.nodeId
  ) {
    throw new Error(
      `CATMAID ${operation} parent state does not match the cached skeleton neighborhood.`,
    );
  }
  const childStates = editContext?.children ?? [];
  const expectedChildIds = options.expectedChildIds;
  if (
    expectedChildIds !== undefined &&
    childStates.length !== expectedChildIds.length
  ) {
    throw new Error(
      `CATMAID ${operation} requires revision state for all direct child nodes.`,
    );
  }
  if (
    expectedChildIds !== undefined &&
    childStates.some((child, index) => child.nodeId !== expectedChildIds[index])
  ) {
    throw new Error(
      `CATMAID ${operation} child state does not match the cached skeleton neighborhood.`,
    );
  }
  return {
    edition_time: requireCatmaidRevisionToken(
      node.revisionToken,
      operation,
      "node",
    ),
    ...(editContext?.parent === undefined
      ? {}
      : {
          parent: [
            editContext.parent.nodeId,
            requireCatmaidRevisionToken(
              editContext.parent.revisionToken,
              operation,
              "parent",
            ),
          ],
        }),
    children: childStates.map((child): [number, string] => [
      child.nodeId,
      requireCatmaidRevisionToken(child.revisionToken, operation, "child"),
    ]),
    links: [],
  };
}

function buildCatmaidInsertNodeState(
  parentId: number,
  childNodeIds: readonly number[],
  editContext?: SpatiallyIndexedSkeletonEditContext,
) {
  const parentNode = editContext?.node;
  if (parentNode === undefined) {
    throw new Error("CATMAID insert-node requires inspected parent state.");
  }
  if (parentNode.nodeId !== parentId) {
    throw new Error(
      `CATMAID insert-node parent state does not match requested parent id ${parentId}.`,
    );
  }
  const childStates = editContext?.children ?? [];
  if (childStates.length !== childNodeIds.length) {
    throw new Error(
      "CATMAID insert-node requires revision state for all reattached child nodes.",
    );
  }
  if (
    childStates.some((child, index) => child.nodeId !== childNodeIds[index])
  ) {
    throw new Error(
      "CATMAID insert-node child state does not match the requested child ids.",
    );
  }
  return {
    edition_time: requireCatmaidRevisionToken(
      parentNode.revisionToken,
      "insert-node",
      "parent",
    ),
    children: childStates.map((child): [number, string] => [
      child.nodeId,
      requireCatmaidRevisionToken(child.revisionToken, "insert-node", "child"),
    ]),
    links: [],
  };
}

function getCatmaidSingleNodeRevisionResult(
  revisionToken: string | undefined,
): SpatiallyIndexedSkeletonNodeRevisionResult {
  return revisionToken === undefined ? {} : { revisionToken };
}

function parseCatmaidNodeRevisionUpdates(
  rows: unknown,
): SpatiallyIndexedSkeletonNodeRevisionUpdate[] {
  if (!Array.isArray(rows)) {
    throw new Error(
      "CATMAID treenodes/compact-detail endpoint returned an unexpected response format.",
    );
  }
  const revisionUpdates: SpatiallyIndexedSkeletonNodeRevisionUpdate[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 9) continue;
    const nodeId = Number(row[0]);
    const revisionToken = normalizeCatmaidRevisionToken(row[8]);
    if (!Number.isFinite(nodeId) || revisionToken === undefined) continue;
    revisionUpdates.push({
      nodeId: Math.round(nodeId),
      revisionToken,
    });
  }
  return revisionUpdates;
}

function parseCatmaidMoveRevisionToken(
  response: any,
  nodeId: number,
): string | undefined {
  const updatedRows = Array.isArray(response?.old_treenodes)
    ? response.old_treenodes
    : [];
  for (const row of updatedRows) {
    if (!Array.isArray(row) || Number(row[0]) !== nodeId) continue;
    return normalizeCatmaidRevisionToken(row[1]);
  }
  return normalizeCatmaidRevisionToken(response?.edition_time);
}

function parseCatmaidUpdatedNodesRevisionToken(
  response: any,
  nodeId: number,
): string | undefined {
  const updatedNodes = response?.updated_nodes;
  if (updatedNodes !== null && typeof updatedNodes === "object") {
    const directMatch = (updatedNodes as Record<string, any>)[nodeId];
    const directRevision = normalizeCatmaidRevisionToken(
      directMatch?.edition_time,
    );
    if (directRevision !== undefined) {
      return directRevision;
    }
  }
  return normalizeCatmaidRevisionToken(response?.edition_time);
}

function parseCatmaidConfidenceRevisionToken(
  response: any,
  nodeId: number,
): string | undefined {
  const directRevision = parseCatmaidUpdatedNodesRevisionToken(
    response,
    nodeId,
  );
  if (directRevision !== undefined) {
    return directRevision;
  }
  const updatedPartners = response?.updated_partners;
  if (updatedPartners === null || typeof updatedPartners !== "object") {
    return undefined;
  }
  for (const value of Object.values(updatedPartners as Record<string, any>)) {
    const revisionToken = normalizeCatmaidRevisionToken(value?.edition_time);
    if (revisionToken !== undefined) {
      return revisionToken;
    }
  }
  return undefined;
}

function parseCatmaidChildRevisionUpdates(
  value: unknown,
): readonly SpatiallyIndexedSkeletonNodeRevisionUpdate[] {
  const revisionUpdates: SpatiallyIndexedSkeletonNodeRevisionUpdate[] = [];
  const children = Array.isArray(value) ? value : [];
  for (const child of children) {
    if (!Array.isArray(child) || child.length < 2) continue;
    const nodeId = Number(child[0]);
    const revisionToken = normalizeCatmaidRevisionToken(child[1]);
    if (!Number.isFinite(nodeId) || revisionToken === undefined) continue;
    revisionUpdates.push({
      nodeId: Math.round(nodeId),
      revisionToken,
    });
  }
  return revisionUpdates;
}

function parseCatmaidDeleteRevisionUpdates(
  response: any,
): readonly SpatiallyIndexedSkeletonNodeRevisionUpdate[] {
  return parseCatmaidChildRevisionUpdates(response?.children);
}

function fetchWithCatmaidCredentials(
  credentialsProvider: CredentialsProvider<CatmaidToken>,
  input: string,
  init: RequestInit,
): Promise<Response> {
  return fetchOkWithCredentials(
    credentialsProvider,
    input,
    init,
    (credentials: CatmaidToken, init: RequestInit) => {
      const newInit: RequestInit = { ...init };
      if (credentials.token) {
        newInit.headers = {
          ...newInit.headers,
          Authorization: `Token ${credentials.token}`,
        };
      }
      return newInit;
    },
    (error) => {
      const { status } = error;
      if (status === 403 || status === 401) {
        // Authorization needed.  Retry with refreshed token.
        return "refresh";
      }
      throw error;
    },
  );
}

export class CatmaidClient implements EditableSpatiallyIndexedSkeletonSource {
  private metadataInfoPromise: Promise<CatmaidStackInfo | null> | undefined;
  private readonly msgpackUnpackr = new Unpackr({
    mapsAsObjects: false,
    int64AsType: "number",
  });

  constructor(
    public baseUrl: string,
    public projectId: number,
    public credentialsProvider?: CredentialsProvider<CatmaidToken>,
  ) {}

  private async normalizeFetchError(error: unknown): Promise<unknown> {
    if (!(error instanceof HttpError) || error.response === undefined) {
      return error;
    }
    const payload = await tryReadErrorPayload(error.response.clone());
    if (isCatmaidStateMatchingErrorPayload(payload)) {
      return new CatmaidStateValidationError(getCatmaidErrorMessage(payload));
    }
    if (error.status === 404 && isCatmaidNotFoundPayload(payload)) {
      const detail = (payload as { detail: string }).detail;
      return new CatmaidNotFoundError(detail);
    }
    return error;
  }

  private async fetch(
    endpoint: string,
    options: RequestInit = {},
    expectMsgpack: boolean = false,
  ): Promise<any> {
    // Ensure baseUrl doesn't have trailing slash and endpoint doesn't have leading slash
    const baseUrl = this.baseUrl.replace(/\/$/, "");
    const url = `${baseUrl}/${this.projectId}/${endpoint}`;
    const headers = new Headers(options.headers);
    // CATMAID API often expects form-encoded data for POST
    if (options.method === "POST" && options.body instanceof URLSearchParams) {
      headers.append("Content-Type", "application/x-www-form-urlencoded");
    }

    let response: Response;
    try {
      if (this.credentialsProvider) {
        response = await fetchWithCatmaidCredentials(
          this.credentialsProvider,
          url,
          { ...options, headers },
        );
      } else {
        response = await fetch(url, { ...options, headers });
        if (!response.ok) {
          throw HttpError.fromResponse(response);
        }
      }
    } catch (error) {
      throw await this.normalizeFetchError(error);
    }

    if (expectMsgpack) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return response.json();
      }
      const buffer = await response.arrayBuffer();
      try {
        return this.msgpackUnpackr.unpack(new Uint8Array(buffer));
      } catch (error) {
        // Some CATMAID deployments return a JSON error body with a msgpack request.
        try {
          return JSON.parse(new TextDecoder().decode(buffer));
        } catch {
          throw error;
        }
      }
    }

    return response.json();
  }

  private async isNoMatchingNodeProviderHttpError(
    error: unknown,
  ): Promise<boolean> {
    if (!(error instanceof HttpError) || error.response === undefined) {
      return false;
    }
    const payload = await tryReadErrorPayload(error.response.clone());
    return isNoMatchingNodeProviderErrorPayload(payload);
  }

  async listSkeletons(): Promise<number[]> {
    return this.fetch("skeletons/");
  }

  private async listStacks(): Promise<{ id: number }[]> {
    return this.fetch("stacks");
  }

  private async getStackInfo(stackId: number): Promise<CatmaidStackInfo> {
    return this.fetch(`stack/${stackId}/info`);
  }

  private async loadMetadataInfo(): Promise<CatmaidStackInfo | null> {
    const stacks = await this.listStacks();
    if (!stacks || stacks.length === 0) return null;
    return this.getStackInfo(stacks[0].id);
  }

  private getMetadataInfo(): Promise<CatmaidStackInfo | null> {
    let promise = this.metadataInfoPromise;
    if (promise === undefined) {
      promise = this.loadMetadataInfo();
      this.metadataInfoPromise = promise;
      promise.catch(() => {
        if (this.metadataInfoPromise === promise) {
          this.metadataInfoPromise = undefined;
        }
      });
    }
    return promise;
  }

  private async tryGetMetadataInfo(): Promise<CatmaidStackInfo | null> {
    try {
      return await this.getMetadataInfo();
    } catch (e) {
      console.warn("Failed to fetch stack info:", e);
      return null;
    }
  }

  private getGridCellSizesFromMetadataInfo(
    info: CatmaidStackInfo,
    bounds = getCatmaidProjectSpaceBounds(info),
  ): Array<{ x: number; y: number; z: number }> {
    const gridSizes: Array<{ x: number; y: number; z: number }> = [];

    // Try to get all allowed spatial skeleton chunk sizes from metadata.
    if (info.metadata?.spatial_skeleton_chunk_sizes) {
      for (const chunkSize of info.metadata.spatial_skeleton_chunk_sizes) {
        if (
          chunkSize.length === 3 &&
          Number.isFinite(chunkSize[0]) &&
          Number.isFinite(chunkSize[1]) &&
          Number.isFinite(chunkSize[2])
        ) {
          gridSizes.push({
            x: chunkSize[0],
            y: chunkSize[1],
            z: chunkSize[2],
          });
        }
      }
    }

    // If no chunk sizes are specified, use the bounds-derived default.
    if (gridSizes.length === 0) {
      gridSizes.push(getDefaultSpatiallyIndexedSkeletonChunkSize(bounds));
    }

    return gridSizes;
  }

  async getSpatialIndexMetadata(): Promise<SpatiallyIndexedSkeletonMetadata | null> {
    const info = await this.tryGetMetadataInfo();
    if (info === null) {
      return null;
    }
    const bounds = getCatmaidProjectSpaceBounds(info);
    return {
      bounds,
      resolution: info.resolution,
      gridCellSizes: this.getGridCellSizesFromMetadataInfo(info, bounds),
    };
  }

  async getCacheProvider(): Promise<string | undefined> {
    const info = await this.tryGetMetadataInfo();
    return info?.metadata?.cache_provider;
  }

  async getSkeleton(
    skeletonId: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<SpatiallyIndexedSkeletonNode[]> {
    let data: any;
    try {
      data = await this.fetch(
        `skeletons/${skeletonId}/compact-detail?with_tags=true&with_history=true`,
        { signal: options.signal },
      );
    } catch (error) {
      if (error instanceof CatmaidNotFoundError) {
        return [];
      } else {
        throw error;
      }
    }
    const rawNodes = Array.isArray(data?.[0]) ? data[0] : [];
    const labelsByNodeId = parseCatmaidNodeLabels(data?.[2]);
    const descriptionByNodeId = getCatmaidNodeDescriptions(labelsByNodeId);
    const trueEndByNodeId = getCatmaidTrueEndNodes(labelsByNodeId);
    const liveNodes = new Map<number, any[]>();
    for (const node of rawNodes) {
      if (
        !Array.isArray(node) ||
        node.length < 8 ||
        !isCatmaidLiveHistoryRow(node)
      ) {
        continue;
      }
      const nodeId = Number(node[0]);
      if (!Number.isFinite(nodeId) || liveNodes.has(Math.round(nodeId))) {
        continue;
      }
      liveNodes.set(Math.round(nodeId), node);
    }
    return [...liveNodes.values()].map((n) => ({
      nodeId: n[0],
      parentNodeId: n[1] ?? undefined,
      position: new Float32Array([n[3], n[4], n[5]]),
      segmentId: skeletonId,
      radius: Number.isFinite(n[6]) ? n[6] : undefined,
      confidence: Number.isFinite(n[7])
        ? mapCatmaidConfidenceToPercent(n[7])
        : undefined,
      description: descriptionByNodeId.get(Number(n[0])),
      isTrueEnd: trueEndByNodeId.has(Number(n[0])),
      revisionToken: getCatmaidHistoryRevisionToken(n),
    }));
  }

  async fetchNodes(
    boundingBox: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
    },
    lod: number = 0,
    options: {
      cacheProvider?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<SpatiallyIndexedSkeletonNodeBase[]> {
    const { cacheProvider, signal } = options;
    const normalizedBoundingBox = normalizeBoundingBoxForNodeList(boundingBox);
    const params = new URLSearchParams({
      left: normalizedBoundingBox.left.toString(),
      top: normalizedBoundingBox.top.toString(),
      z1: normalizedBoundingBox.z1.toString(),
      right: normalizedBoundingBox.right.toString(),
      bottom: normalizedBoundingBox.bottom.toString(),
      z2: normalizedBoundingBox.z2.toString(),
      lod_type: "percent",
      lod: lod.toString(),
      format: "msgpack",
    });

    // Add cache provider if available
    if (cacheProvider) {
      params.append("src", cacheProvider);
    }

    let data: any;
    try {
      data = await this.fetch(
        `node/list?${params.toString()}`,
        { signal },
        true,
      );
    } catch (error) {
      if (await this.isNoMatchingNodeProviderHttpError(error)) {
        return [];
      }
      throw error;
    }

    if (isNoMatchingNodeProviderErrorPayload(data)) {
      return [];
    }

    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new Error(
        "CATMAID node/list endpoint returned an unexpected response format.",
      );
    }

    // Check if limit was reached for the first LOD level
    if (data[3]) {
      console.warn(
        "CATMAID node/list endpoint returned limit_reached=true. Some nodes may be missing.",
      );
    }

    // Process first LOD level (data[0])
    const nodes: SpatiallyIndexedSkeletonNodeBase[] = data[0].map(
      (n: any[]) => ({
        nodeId: n[0],
        parentNodeId: n[1] ?? undefined,
        position: new Float32Array([n[2], n[3], n[4]]),
        segmentId: n[7],
        revisionToken: normalizeCatmaidRevisionToken(n[8]),
      }),
    );

    // Process additional LOD levels.
    const extraNodes = data[5];
    if (Array.isArray(extraNodes)) {
      for (const lodLevel of extraNodes) {
        if (lodLevel[3]) {
          console.warn(
            "CATMAID node/list endpoint returned limit_reached=true for an extra LOD level. Some nodes may be missing.",
          );
        }
        const treenodes = lodLevel[0];
        if (Array.isArray(treenodes)) {
          for (const n of treenodes) {
            nodes.push({
              nodeId: n[0],
              parentNodeId: n[1] ?? undefined,
              position: new Float32Array([n[2], n[3], n[4]]),
              segmentId: n[7],
              revisionToken: normalizeCatmaidRevisionToken(n[8]),
            });
          }
        }
      }
    }

    return nodes;
  }

  async moveNode(
    nodeId: number,
    x: number,
    y: number,
    z: number,
    editContext?: SpatiallyIndexedSkeletonEditContext,
  ): Promise<SpatiallyIndexedSkeletonNodeRevisionResult> {
    const body = new URLSearchParams();
    appendNodeUpdateRows(body, "t", [[nodeId, x, y, z]]);
    appendCatmaidState(
      body,
      buildCatmaidMultiNodeState("move-node", editContext, [nodeId]),
    );

    const response = await this.fetch(`node/update`, {
      method: "POST",
      body: body,
    });
    return getCatmaidSingleNodeRevisionResult(
      parseCatmaidMoveRevisionToken(response, nodeId),
    );
  }

  async getSkeletonRootNode(
    skeletonId: number,
  ): Promise<SpatiallyIndexedSkeletonNavigationTarget> {
    const response = await this.fetch(`skeletons/${skeletonId}/root`);
    return parseCatmaidSkeletonRootTarget(response);
  }

  async rerootSkeleton(
    nodeId: number,
    editContext?: SpatiallyIndexedSkeletonEditContext,
  ): Promise<SpatiallyIndexedSkeletonRerootResult> {
    const body = new URLSearchParams({
      treenode_id: nodeId.toString(),
    });
    appendCatmaidState(
      body,
      buildCatmaidNeighborhoodState("reroot-skeleton", editContext, {
        expectedNodeId: nodeId,
      }),
    );
    await this.fetch(`skeleton/reroot`, {
      method: "POST",
      body,
    });
    const rerootedNodeIds =
      editContext?.nodes
        ?.map((value) => Number(value.nodeId))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.round(value)) ?? [];
    return {
      nodeRevisionUpdates: await this.fetchNodeRevisionUpdates(rerootedNodeIds),
    };
  }

  private async fetchNodeRevisionUpdates(
    nodeIds: readonly number[],
  ): Promise<readonly SpatiallyIndexedSkeletonNodeRevisionUpdate[]> {
    const normalizedNodeIds = [
      ...new Set(
        nodeIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .map((value) => Math.round(value)),
      ),
    ].sort((a, b) => a - b);
    if (normalizedNodeIds.length === 0) {
      return [];
    }
    const body = new URLSearchParams();
    appendScalarList(body, "treenode_ids", normalizedNodeIds);
    const response = await this.fetch(`treenodes/compact-detail`, {
      method: "POST",
      body,
    });
    const revisionUpdates = parseCatmaidNodeRevisionUpdates(response);
    const returnedNodeIds = new Set(
      revisionUpdates.map((update) => update.nodeId),
    );
    const missingNodeIds = normalizedNodeIds.filter(
      (nodeId) => !returnedNodeIds.has(nodeId),
    );
    if (missingNodeIds.length > 0) {
      throw new Error(
        `CATMAID treenodes/compact-detail did not return revision metadata for node(s) ${missingNodeIds.join(", ")}.`,
      );
    }
    return revisionUpdates;
  }

  async deleteNode(
    nodeId: number,
    options: CatmaidDeleteNodeOptions = {},
  ): Promise<SpatiallyIndexedSkeletonDeleteNodeResult> {
    const { childNodeIds = [], editContext } = options;
    const normalizedChildIds = [
      ...new Set(
        childNodeIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .map((value) => Math.round(value)),
      ),
    ].sort((a, b) => a - b);
    const body = new URLSearchParams({
      treenode_id: nodeId.toString(),
    });
    appendCatmaidState(
      body,
      buildCatmaidNeighborhoodState("delete-node", editContext, {
        expectedNodeId: nodeId,
        expectedChildIds: normalizedChildIds,
      }),
    );
    const response = await this.fetch(`treenode/delete`, {
      method: "POST",
      body: body,
    });
    if (response?.success === undefined) {
      throw new Error("Delete endpoint returned an unexpected response.");
    }
    return {
      nodeRevisionUpdates: parseCatmaidDeleteRevisionUpdates(response),
    };
  }

  async addNode(
    skeletonId: number,
    x: number,
    y: number,
    z: number,
    parentId?: number,
    editContext?: SpatiallyIndexedSkeletonEditContext,
  ): Promise<SpatiallyIndexedSkeletonAddNodeResult> {
    const body = new URLSearchParams({
      x: x.toString(),
      y: y.toString(),
      z: z.toString(),
      parent_id: (parentId ?? -1).toString(),
    });
    if (Number.isSafeInteger(skeletonId) && skeletonId > 0) {
      body.append("skeleton_id", skeletonId.toString());
    }
    appendCatmaidState(body, buildCatmaidAddNodeState(parentId, editContext));

    const res = await this.fetch(`treenode/create`, {
      method: "POST",
      body: body,
    });
    const treenodeId = Number(res?.treenode_id);
    const nextSkeletonId = Number(res?.skeleton_id);
    if (!Number.isFinite(treenodeId)) {
      throw new Error(
        "CATMAID treenode/create did not return a valid treenode_id.",
      );
    }
    if (!Number.isFinite(nextSkeletonId)) {
      throw new Error(
        "CATMAID treenode/create did not return a valid skeleton_id.",
      );
    }
    return {
      treenodeId,
      skeletonId: nextSkeletonId,
      revisionToken: normalizeCatmaidRevisionToken(res?.edition_time),
      parentRevisionToken: normalizeCatmaidRevisionToken(
        res?.parent_edition_time,
      ),
    };
  }

  async insertNode(
    skeletonId: number,
    x: number,
    y: number,
    z: number,
    parentId: number,
    childNodeIds: readonly number[],
    editContext?: SpatiallyIndexedSkeletonEditContext,
  ): Promise<SpatiallyIndexedSkeletonInsertNodeResult> {
    const normalizedChildIds = [
      ...new Set(
        childNodeIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .map((value) => Math.round(value)),
      ),
    ].sort((a, b) => a - b);
    if (normalizedChildIds.length === 0) {
      throw new Error(
        "CATMAID insert-node requires at least one child node to reattach.",
      );
    }
    const body = new URLSearchParams({
      x: x.toString(),
      y: y.toString(),
      z: z.toString(),
      parent_id: parentId.toString(),
      child_id: normalizedChildIds[0].toString(),
    });
    if (Number.isSafeInteger(skeletonId) && skeletonId > 0) {
      body.append("skeleton_id", skeletonId.toString());
    }
    appendScalarList(body, "takeover_child_ids", normalizedChildIds.slice(1));
    appendCatmaidState(
      body,
      buildCatmaidInsertNodeState(parentId, normalizedChildIds, editContext),
    );

    const response = await this.fetch(`treenode/insert`, {
      method: "POST",
      body,
    });
    const treenodeId = Number(response?.treenode_id);
    const nextSkeletonId = Number(response?.skeleton_id);
    if (!Number.isFinite(treenodeId)) {
      throw new Error(
        "CATMAID treenode/insert did not return a valid treenode_id.",
      );
    }
    if (!Number.isFinite(nextSkeletonId)) {
      throw new Error(
        "CATMAID treenode/insert did not return a valid skeleton_id.",
      );
    }
    return {
      treenodeId: Math.round(treenodeId),
      skeletonId: Math.round(nextSkeletonId),
      revisionToken: normalizeCatmaidRevisionToken(response?.edition_time),
      parentRevisionToken: normalizeCatmaidRevisionToken(
        response?.parent_edition_time,
      ),
      nodeRevisionUpdates: parseCatmaidChildRevisionUpdates(
        response?.child_edition_times,
      ),
    };
  }

  private async updateNodeLabel(
    nodeId: number,
    endpoint: "update" | "remove",
    body: URLSearchParams,
  ) {
    return this.fetch(`label/treenode/${nodeId}/${endpoint}`, {
      method: "POST",
      body,
    });
  }

  private normalizeNodeLabels(labels: readonly string[]) {
    const normalizedLabels: string[] = [];
    const seen = new Set<string>();
    for (const label of labels) {
      const trimmed = label.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.includes(",")) {
        throw new Error(
          "Node labels containing commas are not supported by the CATMAID label update endpoint.",
        );
      }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalizedLabels.push(trimmed);
    }
    return normalizedLabels;
  }

  private buildDescriptionLabels(description: string) {
    return this.normalizeNodeLabels(
      description
        .split(/\r?\n/)
        .map((label) => label.trim())
        .filter((label) => label.length > 0 && !isCatmaidClosedEndLabel(label)),
    );
  }

  private async replaceNodeLabels(nodeId: number, labels: readonly string[]) {
    const normalizedLabels = this.normalizeNodeLabels(labels);
    return this.updateNodeLabel(
      nodeId,
      "update",
      new URLSearchParams({
        tags: normalizedLabels.join(","),
        delete_existing: "true",
      }),
    );
  }

  private async addNodeLabel(nodeId: number, label: string) {
    const normalizedLabel = label.trim();
    if (normalizedLabel.length === 0) {
      throw new Error("Node label must not be empty.");
    }
    return this.updateNodeLabel(
      nodeId,
      "update",
      new URLSearchParams({
        tags: normalizedLabel,
        delete_existing: "false",
      }),
    );
  }

  private async removeNodeLabel(nodeId: number, label: string) {
    const normalizedLabel = label.trim();
    if (normalizedLabel.length === 0) {
      throw new Error("Node label must not be empty.");
    }
    return this.updateNodeLabel(
      nodeId,
      "remove",
      new URLSearchParams({ tag: normalizedLabel }),
    );
  }

  async updateDescription(
    nodeId: number,
    description: string,
  ): Promise<SpatiallyIndexedSkeletonDescriptionUpdateResult> {
    const normalizedLabels = this.buildDescriptionLabels(description);
    const response = await this.replaceNodeLabels(nodeId, normalizedLabels);
    return {
      ...getCatmaidSingleNodeRevisionResult(
        normalizeCatmaidRevisionToken(response?.edition_time),
      ),
      description:
        normalizedLabels.length === 0 ? undefined : normalizedLabels.join("\n"),
    };
  }

  async setTrueEnd(
    nodeId: number,
  ): Promise<SpatiallyIndexedSkeletonNodeRevisionResult> {
    const response = await this.addNodeLabel(nodeId, CATMAID_TRUE_END_LABEL);
    return getCatmaidSingleNodeRevisionResult(
      normalizeCatmaidRevisionToken((response as any)?.edition_time),
    );
  }

  async removeTrueEnd(
    nodeId: number,
  ): Promise<SpatiallyIndexedSkeletonNodeRevisionResult> {
    const response = await this.removeNodeLabel(nodeId, CATMAID_TRUE_END_LABEL);
    return getCatmaidSingleNodeRevisionResult(
      normalizeCatmaidRevisionToken((response as any)?.edition_time),
    );
  }

  async updateRadius(
    nodeId: number,
    radius: number,
    editContext?: SpatiallyIndexedSkeletonEditContext,
  ): Promise<SpatiallyIndexedSkeletonNodeRevisionResult> {
    if (!Number.isFinite(radius)) {
      throw new Error("Radius must be a finite number.");
    }
    const body = new URLSearchParams({
      radius: radius.toString(),
    });
    appendCatmaidState(
      body,
      buildCatmaidNodeState("update-radius", editContext, nodeId),
    );
    const response = await this.fetch(`treenode/${nodeId}/radius`, {
      method: "POST",
      body,
    });
    return getCatmaidSingleNodeRevisionResult(
      parseCatmaidUpdatedNodesRevisionToken(response, nodeId),
    );
  }

  async updateConfidence(
    nodeId: number,
    confidence: number,
    editContext?: SpatiallyIndexedSkeletonEditContext,
  ): Promise<SpatiallyIndexedSkeletonNodeRevisionResult> {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      throw new Error("Confidence must be between 0 and 100.");
    }
    const body = new URLSearchParams({
      new_confidence: mapPercentConfidenceToCatmaid(confidence).toString(),
    });
    appendCatmaidState(
      body,
      buildCatmaidNodeState("update-confidence", editContext, nodeId),
    );
    const response = await this.fetch(`treenodes/${nodeId}/confidence`, {
      method: "POST",
      body,
    });
    return getCatmaidSingleNodeRevisionResult(
      parseCatmaidConfidenceRevisionToken(response, nodeId),
    );
  }

  async mergeSkeletons(
    fromNodeId: number,
    toNodeId: number,
    editContext?: SpatiallyIndexedSkeletonEditContext,
  ): Promise<SpatiallyIndexedSkeletonMergeResult> {
    const body = new URLSearchParams({
      from_id: fromNodeId.toString(),
      to_id: toNodeId.toString(),
    });
    appendCatmaidState(
      body,
      buildCatmaidMultiNodeState("merge-skeleton", editContext, [
        fromNodeId,
        toNodeId,
      ]),
    );
    const response = await this.fetch(`skeleton/join`, {
      method: "POST",
      body,
    });
    const resultSkeletonId = Number(response?.result_skeleton_id);
    const deletedSkeletonId = Number(response?.deleted_skeleton_id);
    return {
      resultSkeletonId: Number.isFinite(resultSkeletonId)
        ? Math.round(resultSkeletonId)
        : undefined,
      deletedSkeletonId: Number.isFinite(deletedSkeletonId)
        ? Math.round(deletedSkeletonId)
        : undefined,
      stableAnnotationSwap: Boolean(response?.stable_annotation_swap),
    };
  }

  async splitSkeleton(
    nodeId: number,
    editContext?: SpatiallyIndexedSkeletonEditContext,
  ): Promise<SpatiallyIndexedSkeletonSplitResult> {
    const body = new URLSearchParams({
      treenode_id: nodeId.toString(),
    });
    appendCatmaidState(
      body,
      buildCatmaidNeighborhoodState("split-skeleton", editContext, {
        expectedNodeId: nodeId,
      }),
    );
    const response = await this.fetch(`skeleton/split`, {
      method: "POST",
      body,
    });
    const existingSkeletonId = Number(response?.existing_skeleton_id);
    const newSkeletonId = Number(response?.new_skeleton_id);
    return {
      existingSkeletonId: Number.isFinite(existingSkeletonId)
        ? Math.round(existingSkeletonId)
        : undefined,
      newSkeletonId: Number.isFinite(newSkeletonId)
        ? Math.round(newSkeletonId)
        : undefined,
    };
  }
}
