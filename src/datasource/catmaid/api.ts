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
  SpatialSkeletonBounds,
  SpatialSkeletonSpatialIndexLevel,
  SpatialSkeletonVector,
  SpatiallyIndexedSkeletonMetadata,
  SpatiallyIndexedSkeletonNode,
  SpatiallyIndexedSkeletonNodeBase,
} from "#src/skeleton/api.js";
import { SpatialSkeletonEditConflictError } from "#src/skeleton/edit_errors.js";
import { validateSpatialSkeletonLimitZeroOnlyFinest } from "#src/skeleton/source_selection.js";
import {
  getDefaultSpatiallyIndexedSkeletonChunkSize,
  sortSpatialSkeletonGridSizes,
} from "#src/skeleton/spatial_chunk_sizing.js";
import { HttpError } from "#src/util/http_request.js";

interface CatmaidStackInfo {
  dimension: { x: number; y: number; z: number };
  resolution: { x: number; y: number; z: number };
  translation: { x: number; y: number; z: number };
  metadata?: {
    cache_provider?: string;
    read_only?: boolean;
    spatial?: Array<{
      chunk_size: SpatialSkeletonVector;
      limit: number;
    }>;
  };
}

export interface CatmaidToken {
  token: string;
  kind: "anonymous" | "personal";
}

export const credentialsKey = "CATMAID";
const CATMAID_NO_MATCHING_NODE_PROVIDER_ERROR =
  "Could not find matching node provider for request";
const CATMAID_STATE_MATCHING_ERROR_TYPE = "StateMatchingError";

type CatmaidFetchPriority = "high" | "low" | "auto";
type CatmaidRequestInit = RequestInit & { priority?: CatmaidFetchPriority };
export type CatmaidRank3Vector = readonly [number, number, number];

export interface CatmaidAddNodeResult {
  nodeId: number;
  segmentId: number;
}

export type CatmaidInsertNodeResult = CatmaidAddNodeResult;

export interface CatmaidDescriptionUpdateResult {
  description?: string;
}

export interface CatmaidDescriptionUpdateOptions {
  isTrueEnd?: boolean;
}

export interface CatmaidMergeResult {
  resultSegmentId: number | undefined;
  deletedSegmentId: number | undefined;
  directionAdjusted: boolean;
}

export interface CatmaidSplitResult {
  existingSegmentId: number | undefined;
  newSegmentId: number | undefined;
}

export interface CatmaidSpatialSkeletonEditApi {
  addNode(
    x: number,
    y: number,
    z: number,
    parentId?: number,
  ): Promise<CatmaidAddNodeResult>;
  deleteNode(nodeId: number): Promise<void>;
  moveNode(nodeId: number, x: number, y: number, z: number): Promise<void>;
  splitSkeleton(nodeId: number): Promise<CatmaidSplitResult>;
  mergeSkeletons(
    fromNodeId: number,
    toNodeId: number,
  ): Promise<CatmaidMergeResult>;
  toggleTrueEnd(nodeId: number, nextIsTrueEnd: boolean): Promise<void>;
  insertNode(
    x: number,
    y: number,
    z: number,
    parentId: number,
    childNodeIds: readonly number[],
  ): Promise<CatmaidInsertNodeResult>;
  rerootSkeleton(nodeId: number): Promise<void>;
  updateDescription(
    nodeId: number,
    description: string,
    options?: CatmaidDescriptionUpdateOptions,
  ): Promise<CatmaidDescriptionUpdateResult>;
  updateRadius(nodeId: number, radius: number): Promise<void>;
  updateConfidence(nodeId: number, confidence: number): Promise<void>;
}

class CatmaidNotFoundError extends Error {
  constructor(detail?: string) {
    super(detail ?? "CATMAID resource not found.");
    this.name = "CatmaidNotFoundError";
  }
}

export class CatmaidStateValidationError extends SpatialSkeletonEditConflictError {
  constructor(detail?: string) {
    super(
      detail === undefined
        ? "CATMAID rejected the edit because the inspected skeleton is out of date. Refresh the skeleton and try again."
        : `CATMAID rejected the edit because the inspected skeleton is out of date. Refresh the skeleton and try again. ${detail}`,
    );
    this.name = "CatmaidStateValidationError";
  }
}

export const CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES = [
  0, 25, 50, 75, 100,
] as const;

const CATMAID_TRUE_END_LABEL = "ends";
const CATMAID_ENCODED_DESCRIPTION_LABEL_PREFIX = "neuroglancer-description:v1:";
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
  const value = payload as { error?: unknown; detail?: unknown };
  // CATMAID's exception middleware uses detail for a traceback, even when error is blank.
  const message = Object.hasOwn(value, "error") ? value.error : value.detail;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : undefined;
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

function decodeCatmaidDescriptionLabel(label: string): string | undefined {
  const trimmed = label.trim();
  if (!trimmed.startsWith(CATMAID_ENCODED_DESCRIPTION_LABEL_PREFIX)) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(
      trimmed.substring(CATMAID_ENCODED_DESCRIPTION_LABEL_PREFIX.length),
    ).trim();
    return decoded.length === 0 ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function makeCatmaidEncodedDescriptionLabel(description: string) {
  return `${CATMAID_ENCODED_DESCRIPTION_LABEL_PREFIX}${encodeURIComponent(
    description,
  )}`;
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
  if (currentDescriptionLabels.length === 0) {
    return undefined;
  }
  const decodedDescriptionLabels = currentDescriptionLabels
    .map(({ label }) => decodeCatmaidDescriptionLabel(label))
    .filter((label): label is string => label !== undefined);
  const visibleDescriptionLabels =
    decodedDescriptionLabels.length === 0
      ? currentDescriptionLabels.map(({ label }) => label)
      : decodedDescriptionLabels;
  return visibleDescriptionLabels.length === 0
    ? undefined
    : visibleDescriptionLabels.join("\n");
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
    ? getCatmaidLabelTimestamp(entry[1])
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
      CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES.length,
      Math.round(confidence),
    ),
  );
  return CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES[normalized - 1];
}

function mapPercentConfidenceToCatmaid(confidence: number) {
  const normalized = Math.max(
    CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES[0],
    Math.min(
      CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES[
        CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES.length - 1
      ],
      confidence,
    ),
  );
  let bestIndex = 0;
  let bestDistance = Math.abs(
    CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES[0] - normalized,
  );
  for (let i = 1; i < CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES.length; ++i) {
    const candidate = CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES[i];
    const distance = Math.abs(candidate - normalized);
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        candidate > CATMAID_SPATIAL_SKELETON_CONFIDENCE_VALUES[bestIndex])
    ) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex + 1;
}

function getCatmaidProjectSpaceBounds(
  info: CatmaidStackInfo,
): SpatialSkeletonBounds {
  const { dimension, resolution, translation } = info;
  const offsetX = translation?.x ?? 0;
  const offsetY = translation?.y ?? 0;
  const offsetZ = translation?.z ?? 0;

  // CATMAID treenode coordinates and grid cache cell sizes are in project-space nanometers.
  return {
    lowerBounds: [offsetX, offsetY, offsetZ],
    upperBounds: [
      offsetX + dimension.x * resolution.x,
      offsetY + dimension.y * resolution.y,
      offsetZ + dimension.z * resolution.z,
    ],
  };
}

function getCatmaidSpatialSkeletonGridShape(
  chunkSize: readonly [number, number, number],
  extents: readonly [number, number, number],
): number[] {
  return chunkSize.map((size, dim) =>
    Math.max(1, Math.ceil(extents[dim] / size)),
  );
}

function getDefaultCatmaidSpatialIndexLevel(
  bounds: SpatialSkeletonBounds,
  extents: readonly [number, number, number],
): SpatialSkeletonSpatialIndexLevel {
  const chunkSize = requireCatmaidPositiveRank3Vector(
    getDefaultSpatiallyIndexedSkeletonChunkSize(bounds),
    "default spatial skeleton chunk_size",
  );
  return {
    chunkSize,
    gridShape: getCatmaidSpatialSkeletonGridShape(chunkSize, extents),
    limit: 0,
  };
}

function validateCatmaidSpatialSkeletonLimitZeroOnlyFinest(
  levels: readonly SpatialSkeletonSpatialIndexLevel[],
) {
  const sortedLevels = sortSpatialSkeletonGridSizes(
    levels.map((level) => ({
      x: level.chunkSize[0],
      y: level.chunkSize[1],
      z: level.chunkSize[2],
      limit: level.limit,
    })),
  );
  validateSpatialSkeletonLimitZeroOnlyFinest(sortedLevels);
}

export function requireCatmaidRank3Vector(
  vector: SpatialSkeletonVector,
  label: string,
): CatmaidRank3Vector {
  if (vector.length < 3) {
    throw new Error(`CATMAID ${label} requires at least 3 coordinates.`);
  }
  const values = [
    Number(vector[0]),
    Number(vector[1]),
    Number(vector[2]),
  ] as const;
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`CATMAID ${label} coordinates must be finite.`);
  }
  return values;
}

export function requireCatmaidPositiveRank3Vector(
  value: unknown,
  label: string,
): CatmaidRank3Vector {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`CATMAID ${label} must be a rank-3 array.`);
  }
  const values = [
    Number(value[0]),
    Number(value[1]),
    Number(value[2]),
  ] as const;
  if (values.some((x) => !Number.isFinite(x) || x <= 0)) {
    throw new Error(
      `CATMAID ${label} coordinates must be finite and positive.`,
    );
  }
  return values;
}

export function toCatmaidPositionInModelSpace(
  position: SpatialSkeletonVector,
  label: string,
) {
  return new Float32Array(requireCatmaidRank3Vector(position, label));
}

function requireCatmaidNonNegativeInt(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new Error(`CATMAID ${label} must be a non-negative integer.`);
  }
  return numberValue;
}

function parseOptionalCatmaidBoolean(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`CATMAID ${label} must be a boolean.`);
  }
  return value;
}

function normalizeBoundingBoxForNodeList(bounds: SpatialSkeletonBounds) {
  const [minX, minY, minZ] = requireCatmaidRank3Vector(
    bounds.lowerBounds,
    "node-list lower bound",
  );
  const [maxX, maxY, maxZ] = requireCatmaidRank3Vector(
    bounds.upperBounds,
    "node-list upper bound",
  );
  const left = Math.floor(minX);
  const top = Math.floor(minY);
  const z1 = Math.floor(minZ);

  // CATMAID node-list bounds are half-open: [left,right) x [top,bottom) x [z1,z2).
  // Use ceil for exclusive upper bounds and ensure a positive extent on each axis.
  const right = Math.max(left + 1, Math.ceil(maxX));
  const bottom = Math.max(top + 1, Math.ceil(maxY));
  const z2 = Math.max(z1 + 1, Math.ceil(maxZ));

  return { left, top, z1, right, bottom, z2 };
}

export function getCatmaidSpatialSkeletonGridCellBounds(
  cellIndex: SpatialSkeletonVector,
  chunkSize: SpatialSkeletonVector,
): SpatialSkeletonBounds {
  const [cellX, cellY, cellZ] = requireCatmaidRank3Vector(
    cellIndex,
    "spatial skeleton grid cell index",
  );
  const [sizeX, sizeY, sizeZ] = requireCatmaidRank3Vector(
    chunkSize,
    "spatial skeleton grid cell size",
  );
  return {
    lowerBounds: [cellX * sizeX, cellY * sizeY, cellZ * sizeZ],
    upperBounds: [
      (cellX + 1) * sizeX,
      (cellY + 1) * sizeY,
      (cellZ + 1) * sizeZ,
    ],
  };
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

function appendUncheckedCatmaidState(body: URLSearchParams) {
  // CATMAID requires an explicit state policy. Queue ordering and local cache
  // revisions do not depend on server edition timestamps.
  body.append("state", JSON.stringify({ nocheck: true }));
}

const CATMAID_LABEL_TIMESTAMP_WITH_SPACE_PATTERN =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})$/;

function getCatmaidLabelTimestamp(value: unknown) {
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
    normalizedValue.replace(
      CATMAID_LABEL_TIMESTAMP_WITH_SPACE_PATTERN,
      "$1T$2$3",
    ),
  );
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function fetchWithCatmaidCredentials(
  credentialsProvider: CredentialsProvider<CatmaidToken>,
  input: string,
  init: CatmaidRequestInit,
): Promise<Response> {
  return fetchOkWithCredentials(
    credentialsProvider,
    input,
    init,
    (credentials: CatmaidToken, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Token ${credentials.token}`);
      return { ...init, headers };
    },
    (error, credentials) => {
      const { status } = error;
      if (
        status === 401 ||
        (status === 403 && credentials.kind === "anonymous")
      ) {
        // Anonymous credentials may not have access to private projects. A
        // 401 also indicates that a personal token must be replaced.
        return "refresh";
      }
      throw error;
    },
  );
}

export class CatmaidClient implements CatmaidSpatialSkeletonEditApi {
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
    let payload: unknown;
    try {
      payload = await tryReadJsonPayload(error.response.clone());
    } catch {
      // Optional message enrichment must preserve the original HTTP diagnostics.
      return error;
    }
    if (isCatmaidStateMatchingErrorPayload(payload)) {
      return new CatmaidStateValidationError(getCatmaidErrorMessage(payload));
    }
    if (error.status === 404 && isCatmaidNotFoundPayload(payload)) {
      return new CatmaidNotFoundError(getCatmaidErrorMessage(payload));
    }
    const message = getCatmaidErrorMessage(payload);
    if (message !== undefined) {
      error.message = `${error.message} ${message}`;
    }
    return error;
  }

  private async fetchProjectEndpoint(
    endpoint: string,
    options: CatmaidRequestInit = {},
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
    return this.fetchProjectEndpoint("skeletons/");
  }

  private async listStacks(): Promise<{ id: number }[]> {
    return this.fetchProjectEndpoint("stacks");
  }

  private async getStackInfo(stackId: number): Promise<CatmaidStackInfo> {
    return this.fetchProjectEndpoint(`stack/${stackId}/info`);
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

  private getSpatialIndexLevelsFromSpatialMetadata(
    metadata: CatmaidStackInfo["metadata"],
    bounds: SpatialSkeletonBounds,
    extents: readonly [number, number, number],
  ): SpatialSkeletonSpatialIndexLevel[] {
    const spatial = metadata?.spatial;
    if (spatial == null) {
      return [getDefaultCatmaidSpatialIndexLevel(bounds, extents)];
    }
    if (!Array.isArray(spatial)) {
      throw new Error(
        "CATMAID stack metadata.spatial must be a spatial skeleton metadata array.",
      );
    }
    if (spatial.length === 0) {
      return [getDefaultCatmaidSpatialIndexLevel(bounds, extents)];
    }
    const levels = spatial.map((level, index) => {
      const chunkSize = requireCatmaidPositiveRank3Vector(
        level?.chunk_size,
        `spatial skeleton metadata spatial[${index}].chunk_size`,
      );
      const limit = requireCatmaidNonNegativeInt(
        level?.limit,
        `spatial skeleton metadata spatial[${index}].limit`,
      );
      return {
        chunkSize,
        gridShape: getCatmaidSpatialSkeletonGridShape(chunkSize, extents),
        limit,
      };
    });
    validateCatmaidSpatialSkeletonLimitZeroOnlyFinest(levels);
    return levels;
  }

  private getSpatialIndexLevelsFromMetadataInfo(
    info: CatmaidStackInfo,
    bounds = getCatmaidProjectSpaceBounds(info),
  ): SpatialSkeletonSpatialIndexLevel[] {
    const [lowerX, lowerY, lowerZ] = requireCatmaidRank3Vector(
      bounds.lowerBounds,
      "spatial metadata lower bound",
    );
    const [upperX, upperY, upperZ] = requireCatmaidRank3Vector(
      bounds.upperBounds,
      "spatial metadata upper bound",
    );
    const extents = [
      upperX - lowerX,
      upperY - lowerY,
      upperZ - lowerZ,
    ] as const;
    return this.getSpatialIndexLevelsFromSpatialMetadata(
      info.metadata,
      bounds,
      extents,
    );
  }

  private getSpatialSkeletonReadonlyFromMetadataInfo(
    info: CatmaidStackInfo,
  ): boolean {
    const metadata = info.metadata;
    return (
      parseOptionalCatmaidBoolean(
        metadata?.read_only,
        "spatial skeleton metadata read_only",
      ) ?? true
    );
  }

  async getSpatialIndexMetadata(): Promise<SpatiallyIndexedSkeletonMetadata | null> {
    const info = await this.tryGetMetadataInfo();
    if (info === null) {
      return null;
    }
    const bounds = getCatmaidProjectSpaceBounds(info);
    return {
      ...bounds,
      spatial: this.getSpatialIndexLevelsFromMetadataInfo(info, bounds),
      readonly: this.getSpatialSkeletonReadonlyFromMetadataInfo(info),
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
    const { signal } = options;
    let data: any;
    try {
      data = await this.fetchProjectEndpoint(
        `skeletons/${skeletonId}/compact-detail?with_tags=true`,
        {
          signal,
        },
      );
    } catch (error) {
      if (
        error instanceof CatmaidNotFoundError ||
        (error instanceof HttpError && error.status === 404)
      ) {
        // A compact-detail 404 is authoritative absence regardless of which
        // CATMAID error payload (or empty body) accompanied it.  Keep this
        // endpoint-specific instead of treating every CATMAID 404 as an
        // empty resource.
        return [];
      } else {
        throw error;
      }
    }
    const rawNodes = Array.isArray(data?.[0]) ? data[0] : [];
    const labelsByNodeId = parseCatmaidNodeLabels(data?.[2]);
    const descriptionByNodeId = getCatmaidNodeDescriptions(labelsByNodeId);
    const trueEndByNodeId = getCatmaidTrueEndNodes(labelsByNodeId);
    const currentNodes = rawNodes.filter(
      (node): node is any[] => Array.isArray(node) && node.length >= 8,
    );
    return currentNodes.map((n) => ({
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
    }));
  }

  async fetchNodes(
    bounds: SpatialSkeletonBounds,
    lod: number = 0,
    options: {
      cacheProvider?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<SpatiallyIndexedSkeletonNodeBase[]> {
    const { cacheProvider, signal } = options;
    const normalizedBoundingBox = normalizeBoundingBoxForNodeList(bounds);
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
      data = await this.fetchProjectEndpoint(
        `node/list?${params.toString()}`,
        { signal, priority: "low" },
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
  ): Promise<void> {
    const body = new URLSearchParams();
    appendNodeUpdateRows(body, "t", [[nodeId, x, y, z]]);
    appendUncheckedCatmaidState(body);

    await this.fetchProjectEndpoint(`node/update`, {
      method: "POST",
      body: body,
    });
  }

  async rerootSkeleton(nodeId: number): Promise<void> {
    const body = new URLSearchParams({
      treenode_id: nodeId.toString(),
    });
    appendUncheckedCatmaidState(body);
    const response = await this.fetchProjectEndpoint(`skeleton/reroot`, {
      method: "POST",
      body,
    });
    if (Number(response?.newroot) !== nodeId) {
      throw new Error(
        "CATMAID skeleton/reroot did not return the requested new root.",
      );
    }
  }

  async deleteNode(nodeId: number): Promise<void> {
    const body = new URLSearchParams({
      treenode_id: nodeId.toString(),
    });
    appendUncheckedCatmaidState(body);
    const response = await this.fetchProjectEndpoint(`treenode/delete`, {
      method: "POST",
      body: body,
    });
    if (response?.success === undefined) {
      throw new Error("Delete endpoint returned an unexpected response.");
    }
  }

  async addNode(
    x: number,
    y: number,
    z: number,
    parentId?: number,
  ): Promise<CatmaidAddNodeResult> {
    const body = new URLSearchParams({
      x: x.toString(),
      y: y.toString(),
      z: z.toString(),
      parent_id: (parentId ?? -1).toString(),
    });
    appendUncheckedCatmaidState(body);

    const res = await this.fetchProjectEndpoint(`treenode/create`, {
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
      nodeId: Math.round(treenodeId),
      segmentId: Math.round(nextSkeletonId),
    };
  }

  async insertNode(
    x: number,
    y: number,
    z: number,
    parentId: number,
    childNodeIds: readonly number[],
  ): Promise<CatmaidInsertNodeResult> {
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
    appendScalarList(body, "takeover_child_ids", normalizedChildIds.slice(1));
    appendUncheckedCatmaidState(body);

    const response = await this.fetchProjectEndpoint(`treenode/insert`, {
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
      nodeId: Math.round(treenodeId),
      segmentId: Math.round(nextSkeletonId),
    };
  }

  private async updateNodeLabel(
    nodeId: number,
    endpoint: "update" | "remove",
    body: URLSearchParams,
  ) {
    return this.fetchProjectEndpoint(`label/treenode/${nodeId}/${endpoint}`, {
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

  private normalizeDescriptionLabels(description: string) {
    const normalizedLabels: string[] = [];
    const seen = new Set<string>();
    for (const label of description.split(/\r?\n/)) {
      const trimmed = label.trim();
      if (trimmed.length === 0 || isCatmaidClosedEndLabel(trimmed)) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalizedLabels.push(trimmed);
    }
    return normalizedLabels;
  }

  private buildDescriptionUpdate(description: string) {
    const normalizedDescriptionLabels =
      this.normalizeDescriptionLabels(description);
    if (normalizedDescriptionLabels.length === 0) {
      return { labels: [], description: undefined };
    }
    const normalizedDescription = normalizedDescriptionLabels.join("\n");
    const requiresEncodedDescription =
      normalizedDescription.includes(",") ||
      normalizedDescriptionLabels.some((label) =>
        label.startsWith(CATMAID_ENCODED_DESCRIPTION_LABEL_PREFIX),
      );
    return {
      labels: requiresEncodedDescription
        ? [makeCatmaidEncodedDescriptionLabel(normalizedDescription)]
        : normalizedDescriptionLabels,
      description: normalizedDescription,
    };
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
    options: CatmaidDescriptionUpdateOptions = {},
  ): Promise<CatmaidDescriptionUpdateResult> {
    const descriptionUpdate = this.buildDescriptionUpdate(description);
    const labels =
      options.isTrueEnd === true
        ? [...descriptionUpdate.labels, CATMAID_TRUE_END_LABEL]
        : descriptionUpdate.labels;
    await this.replaceNodeLabels(nodeId, labels);
    return {
      description: descriptionUpdate.description,
    };
  }

  async toggleTrueEnd(nodeId: number, nextIsTrueEnd: boolean): Promise<void> {
    if (nextIsTrueEnd) {
      await this.addNodeLabel(nodeId, CATMAID_TRUE_END_LABEL);
    } else {
      await this.removeNodeLabel(nodeId, CATMAID_TRUE_END_LABEL);
    }
  }

  async updateRadius(nodeId: number, radius: number): Promise<void> {
    if (!Number.isFinite(radius)) {
      throw new Error("Radius must be a finite number.");
    }
    const body = new URLSearchParams({
      radius: radius.toString(),
    });
    appendUncheckedCatmaidState(body);
    await this.fetchProjectEndpoint(`treenode/${nodeId}/radius`, {
      method: "POST",
      body,
    });
  }

  async updateConfidence(nodeId: number, confidence: number): Promise<void> {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      throw new Error("Confidence must be between 0 and 100.");
    }
    const body = new URLSearchParams({
      new_confidence: mapPercentConfidenceToCatmaid(confidence).toString(),
    });
    appendUncheckedCatmaidState(body);
    await this.fetchProjectEndpoint(`treenodes/${nodeId}/confidence`, {
      method: "POST",
      body,
    });
  }

  async mergeSkeletons(
    fromNodeId: number,
    toNodeId: number,
  ): Promise<CatmaidMergeResult> {
    const body = new URLSearchParams({
      from_id: fromNodeId.toString(),
      to_id: toNodeId.toString(),
    });
    appendUncheckedCatmaidState(body);
    const response = await this.fetchProjectEndpoint(`skeleton/join`, {
      method: "POST",
      body,
    });
    const resultSkeletonId = Number(response?.result_skeleton_id);
    const deletedSkeletonId = Number(response?.deleted_skeleton_id);
    return {
      resultSegmentId: Number.isFinite(resultSkeletonId)
        ? Math.round(resultSkeletonId)
        : undefined,
      deletedSegmentId: Number.isFinite(deletedSkeletonId)
        ? Math.round(deletedSkeletonId)
        : undefined,
      directionAdjusted: Boolean(response?.stable_annotation_swap),
    };
  }

  async splitSkeleton(nodeId: number): Promise<CatmaidSplitResult> {
    const body = new URLSearchParams({
      treenode_id: nodeId.toString(),
      downstream_annotation_map: JSON.stringify({}),
    });
    appendUncheckedCatmaidState(body);
    const response = await this.fetchProjectEndpoint(`skeleton/split`, {
      method: "POST",
      body,
    });
    const existingSkeletonId = Number(response?.existing_skeleton_id);
    const newSkeletonId = Number(response?.new_skeleton_id);
    return {
      existingSegmentId: Number.isFinite(existingSkeletonId)
        ? Math.round(existingSkeletonId)
        : undefined,
      newSegmentId: Number.isFinite(newSkeletonId)
        ? Math.round(newSkeletonId)
        : undefined,
    };
  }
}
