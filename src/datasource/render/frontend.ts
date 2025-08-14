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
 * @file
 * Support for Render (https://github.com/saalfeldlab/render) servers.
 */

import { makeDataBoundsBoundingBoxAnnotationSet } from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type {
  CompleteUrlOptions,
  CompletionResult,
  DataSource,
  GetDataSourceOptions,
  DataSourceProvider,
} from "#src/datasource/index.js";
import { TileChunkSourceParameters } from "#src/datasource/render/base.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeVolumeChunkSpecification,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import {
  applyCompletionOffset,
  getPrefixMatchesWithDescriptions,
} from "#src/util/completion.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { fetchOk } from "#src/util/http_request.js";
import {
  parseArray,
  parseQueryStringParameters,
  verifyFloat,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalInt,
  verifyOptionalString,
  verifyString,
} from "#src/util/json.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

const VALID_ENCODINGS = new Set<string>(["jpg", "raw16", "png", "png16"]);
const RESERVED_PARAMETERS = [
  { name: "minX", type: "number" },
  { name: "minY", type: "number" },
  { name: "minZ", type: "number" },
  { name: "maxX", type: "number" },
  { name: "maxY", type: "number" },
  { name: "maxZ", type: "number" },
  { name: "encoding", type: Array.from(VALID_ENCODINGS).join(" | ") },
  { name: "numLevels", type: "integer" },
  { name: "tileSize", type: "number" },
  { name: "channel", type: "string" },
];

const TileChunkSourceBase = WithParameters(
  VolumeChunkSource,
  TileChunkSourceParameters,
);
class TileChunkSource extends TileChunkSourceBase {}

const VALID_STACK_STATES = new Set<string>(["COMPLETE", "READ_ONLY"]);
const PARTIAL_STACK_STATES = new Set<string>(["LOADING"]);

interface OwnerInfo {
  owner: string;
  projects: Map<string, ProjectInfo>;
}

interface ProjectInfo {
  stacks: Map<string, StackInfo>;
}

interface StackInfo {
  lowerVoxelBound: vec3;
  upperVoxelBound: vec3;
  voxelResolution: vec3 /* in nm */;
  project: string;
  channels: string[];
}

interface QueryParameterInfo {
  name: string;
  type: string;
  required?: boolean;
}

function parseOwnerInfo(obj: any): OwnerInfo {
  const stackObjs = parseArray(obj, verifyObject);

  if (stackObjs.length < 1) {
    throw new Error("No stacks found for owner object.");
  }

  const projects = new Map<string, ProjectInfo>();
  // Get the owner from the first stack
  const owner = verifyObjectProperty(stackObjs[0], "stackId", parseStackOwner);

  for (const stackObj of stackObjs) {
    const stackName = verifyObjectProperty(stackObj, "stackId", parseStackName);
    let stackInfo: StackInfo | undefined;
    try {
      stackInfo = parseStackInfo(stackObj);
    } catch (e) {
      console.warn(
        `Failed to parse stack info for stack ${stackName} in owner ${owner}:`,
        e,
      );
      continue;
    }
    if (stackInfo !== undefined) {
      const projectName = stackInfo.project;
      let projectInfo = projects.get(projectName);

      if (projectInfo === undefined) {
        const stacks = new Map<string, StackInfo>();
        projects.set(projectName, { stacks });
        projectInfo = projects.get(projectName);
      }

      projectInfo!.stacks.set(stackName, stackInfo);
    }
  }

  return { owner, projects };
}

function parseStackName(stackIdObj: any): string {
  verifyObject(stackIdObj);
  return verifyObjectProperty(stackIdObj, "stack", verifyString);
}

function parseStackOwner(stackIdObj: any): string {
  verifyObject(stackIdObj);
  return verifyObjectProperty(stackIdObj, "owner", verifyString);
}

function parseStackInfo(obj: any): StackInfo | undefined {
  verifyObject(obj);

  const state = verifyObjectProperty(obj, "state", verifyString);

  let channels: string[] = [];
  let lowerVoxelBound: vec3 = vec3.create();
  let upperVoxelBound: vec3 = vec3.create();

  if (VALID_STACK_STATES.has(state)) {
    const stackStatsObj = verifyObjectProperty(obj, "stats", verifyObject);

    lowerVoxelBound = parseLowerVoxelBounds(stackStatsObj);
    upperVoxelBound = parseUpperVoxelBounds(stackStatsObj);

    if (Object.prototype.hasOwnProperty.call(stackStatsObj, "channelNames")) {
      channels = parseChannelNames(stackStatsObj);
    }
  } else if (PARTIAL_STACK_STATES.has(state)) {
    // Stacks in LOADING state will not have a 'stats' object.
    // Values will be populated from command arguments in MultiscaleVolumeChunkSource()
  } else {
    return undefined;
  }

  const voxelResolution: vec3 = verifyObjectProperty(
    obj,
    "currentVersion",
    parseStackVersionInfo,
  );

  const project: string = verifyObjectProperty(
    obj,
    "stackId",
    parseStackProject,
  );

  return {
    lowerVoxelBound,
    upperVoxelBound,
    voxelResolution,
    project,
    channels,
  };
}

function parseUpperVoxelBounds(stackStatsObj: any): vec3 {
  verifyObject(stackStatsObj);
  const stackBounds = verifyObjectProperty(
    stackStatsObj,
    "stackBounds",
    verifyObject,
  );

  const upperVoxelBound: vec3 = vec3.create();

  upperVoxelBound[0] =
    verifyObjectProperty(stackBounds, "maxX", verifyFloat) + 1;
  upperVoxelBound[1] =
    verifyObjectProperty(stackBounds, "maxY", verifyFloat) + 1;
  upperVoxelBound[2] =
    verifyObjectProperty(stackBounds, "maxZ", verifyFloat) + 1;

  return upperVoxelBound;
}

function parseLowerVoxelBounds(stackStatsObj: any): vec3 {
  verifyObject(stackStatsObj);
  const stackBounds = verifyObjectProperty(
    stackStatsObj,
    "stackBounds",
    verifyObject,
  );

  const lowerVoxelBound: vec3 = vec3.create();

  lowerVoxelBound[0] = verifyObjectProperty(stackBounds, "minX", verifyFloat);
  lowerVoxelBound[1] = verifyObjectProperty(stackBounds, "minY", verifyFloat);
  lowerVoxelBound[2] = verifyObjectProperty(stackBounds, "minZ", verifyFloat);

  return lowerVoxelBound;
}

function parseChannelNames(stackStatsObj: any): string[] {
  verifyObject(stackStatsObj);

  return verifyObjectProperty(
    stackStatsObj,
    "channelNames",
    (channelNamesObj) => {
      return parseArray(channelNamesObj, verifyString);
    },
  );
}

function parseStackVersionInfo(stackVersionObj: any): vec3 {
  verifyObject(stackVersionObj);
  const voxelResolution: vec3 = vec3.create();
  try {
    voxelResolution[0] = verifyObjectProperty(
      stackVersionObj,
      "stackResolutionX",
      verifyFloat,
    );
    voxelResolution[1] = verifyObjectProperty(
      stackVersionObj,
      "stackResolutionY",
      verifyFloat,
    );
    voxelResolution[2] = verifyObjectProperty(
      stackVersionObj,
      "stackResolutionZ",
      verifyFloat,
    );
  } catch {
    // default is 1, 1, 1
    voxelResolution[0] = 1;
    voxelResolution[1] = 1;
    voxelResolution[2] = 1;
  }

  return voxelResolution;
}

function parseStackProject(stackIdObj: any): string {
  verifyObject(stackIdObj);
  return verifyObjectProperty(stackIdObj, "project", verifyString);
}

function parseQueryParameterInfo(obj: any): QueryParameterInfo[] {
  const boxImageApiKey =
    "/v1/owner/{owner}/project/{project}/stack/{stack}/z/{z}/box/{x},{y},{width},{height},{scale}/raw-image";
  const boxImageApi = obj.paths[boxImageApiKey];
  if (boxImageApi === undefined) {
    console.warn(
      "Could not retrieve API schema, skipping dynamic parameter hints",
    );
    return RESERVED_PARAMETERS;
  }

  const boxImageParameters = boxImageApi.get.parameters as QueryParameterInfo[];

  // Return optional parameters from render API and extend list with hardcoded options
  return boxImageParameters
    .filter(({ required }) => required === false)
    .filter(({ name }) => name !== "scale")
    .concat(RESERVED_PARAMETERS);
}

class RenderMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    if (
      this.parameters.encoding === "raw16" ||
      this.parameters.encoding === "png16"
    ) {
      return DataType.UINT16;
    }
    // 8-bit (JPEG or PNG)
    return DataType.UINT8;
  }
  get volumeType() {
    return VolumeType.IMAGE;
  }

  channel: string | undefined;
  stack: string;
  stackInfo: StackInfo;

  dims: vec3;

  encoding: string;
  numLevels: number | undefined;

  // Bounding box override parameters
  minX: number | undefined;
  minY: number | undefined;
  minZ: number | undefined;
  maxX: number | undefined;
  maxY: number | undefined;
  maxZ: number | undefined;

  // Key-value pairs to forward to the render webservice
  renderArgs: { [index: string]: string };

  get rank() {
    return 3;
  }

  constructor(
    chunkManager: ChunkManager,
    public baseUrl: string,
    public ownerInfo: OwnerInfo,
    stack: string | undefined,
    public project: string,
    channel: string | undefined,
    public parameters: { [index: string]: any },
  ) {
    super(chunkManager);
    const projectInfo = ownerInfo.projects.get(project);
    if (projectInfo === undefined) {
      throw new Error(
        `Specified project ${JSON.stringify(project)} does not exist for ` +
          `specified owner ${JSON.stringify(ownerInfo.owner)}`,
      );
    }

    if (stack === undefined) {
      const stackNames = Array.from(projectInfo.stacks.keys());
      if (stackNames.length !== 1) {
        throw new Error(
          `Dataset contains multiple stacks: ${JSON.stringify(stackNames)}`,
        );
      }
      stack = stackNames[0];
    }
    const stackInfo = projectInfo.stacks.get(stack);
    if (stackInfo === undefined) {
      throw new Error(
        `Specified stack ${JSON.stringify(
          stack,
        )} is not one of the supported stacks: ` +
          JSON.stringify(Array.from(projectInfo.stacks.keys())),
      );
    }
    this.stack = stack;
    this.stackInfo = stackInfo;

    if (channel !== undefined && channel.length > 0) {
      this.channel = channel;
    }

    const reservedKeys = new Set(RESERVED_PARAMETERS.map(({ name }) => name));

    this.renderArgs = {};
    for (const [key, value] of Object.entries(parameters)) {
      if (reservedKeys.has(key)) continue;

      this.renderArgs[key] = value;
    }

    this.minX = verifyOptionalInt(parameters.minX);
    this.minY = verifyOptionalInt(parameters.minY);
    this.minZ = verifyOptionalInt(parameters.minZ);
    this.maxX = verifyOptionalInt(parameters.maxX);
    this.maxY = verifyOptionalInt(parameters.maxY);
    this.maxZ = verifyOptionalInt(parameters.maxZ);

    if (this.minX !== undefined) {
      stackInfo.lowerVoxelBound[0] = this.minX;
    }
    if (this.minY !== undefined) {
      stackInfo.lowerVoxelBound[1] = this.minY;
    }
    if (this.minZ !== undefined) {
      stackInfo.lowerVoxelBound[2] = this.minZ;
    }
    if (this.maxX !== undefined) {
      stackInfo.upperVoxelBound[0] = this.maxX;
    }
    if (this.maxY !== undefined) {
      stackInfo.upperVoxelBound[1] = this.maxY;
    }
    if (this.maxZ !== undefined) {
      stackInfo.upperVoxelBound[2] = this.maxZ;
    }

    let encoding = verifyOptionalString(parameters.encoding);
    if (encoding === undefined) {
      encoding = "jpg";
    } else {
      if (!VALID_ENCODINGS.has(encoding)) {
        throw new Error(`Invalid encoding: ${JSON.stringify(encoding)}.`);
      }
    }
    this.encoding = encoding;

    this.numLevels = verifyOptionalInt(parameters.numlevels);

    this.dims = vec3.create();

    let tileSize = verifyOptionalInt(parameters.tilesize);
    if (tileSize === undefined) {
      tileSize = 1024; // Default tile size is 1024 x 1024
    }
    this.dims[0] = tileSize;
    this.dims[1] = tileSize;
    this.dims[2] = 1;
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    volumeSourceOptions;
    const sources: SliceViewSingleResolutionSource<VolumeChunkSource>[][] = [];

    let numLevels = this.numLevels;
    if (numLevels === undefined) {
      numLevels = computeStackHierarchy(this.stackInfo, this.dims[0]);
    }

    const {
      lowerVoxelBound: baseLowerVoxelBound,
      upperVoxelBound: baseUpperVoxelBound,
    } = this.stackInfo;

    for (let level = 0; level < numLevels; level++) {
      const chunkToMultiscaleTransform = mat4.create();
      const chunkDataSize = Uint32Array.of(1, 1, 1);
      // tiles are NxMx1
      for (let i = 0; i < 2; ++i) {
        chunkToMultiscaleTransform[5 * i] = 2 ** level;
        chunkDataSize[i] = this.dims[i];
      }

      const lowerVoxelBound = vec3.create();
      const upperVoxelBound = vec3.create();
      const lowerClipBound = vec3.create();
      const upperClipBound = vec3.create();

      for (let i = 0; i < 3; i++) {
        const downsampleFactor = chunkToMultiscaleTransform[5 * i];
        const lower = (lowerClipBound[i] =
          baseLowerVoxelBound[i] / downsampleFactor);
        const upper = (upperClipBound[i] =
          baseUpperVoxelBound[i] / downsampleFactor);
        lowerVoxelBound[i] = Math.floor(lower);
        upperVoxelBound[i] = Math.ceil(upper);
      }

      const spec = makeVolumeChunkSpecification({
        rank: 3,
        chunkDataSize,
        dataType: this.dataType,
        lowerVoxelBound,
        upperVoxelBound,
      });

      const source = this.chunkManager.getChunkSource(TileChunkSource, {
        spec,
        parameters: {
          baseUrl: this.baseUrl,
          owner: this.ownerInfo.owner,
          project: this.stackInfo.project,
          stack: this.stack,
          channel: this.channel,
          renderArgs: this.renderArgs,
          dims: `${this.dims[0]}_${this.dims[1]}`,
          level: level,
          encoding: this.encoding,
        },
      });

      sources.push([
        {
          chunkSource: source,
          chunkToMultiscaleTransform,
          lowerClipBound,
          upperClipBound,
        },
      ]);
    }
    return transposeNestedArrays(sources);
  }
}

export function computeStackHierarchy(stackInfo: StackInfo, tileSize: number) {
  let maxBound = 0;
  for (let i = 0; i < 2; i++) {
    maxBound = Math.max(maxBound, stackInfo.upperVoxelBound[i]);
  }

  if (tileSize >= maxBound) {
    return 1;
  }

  let counter = 0;
  while (maxBound > tileSize) {
    maxBound = maxBound / 2;
    counter++;
  }

  return counter;
}

export async function getOwnerInfo(
  chunkManager: ChunkManager,
  hostname: string,
  owner: string,
  options: Partial<ProgressOptions>,
): Promise<OwnerInfo> {
  return chunkManager.memoize.getAsync(
    { type: "render:getOwnerInfo", hostname, owner },
    options,
    (progressOptions) =>
      fetchOk(`${hostname}/render-ws/v1/owner/${owner}/stacks`, progressOptions)
        .then((response) => response.json())
        .then(parseOwnerInfo),
  );
}

export async function getQueryParameterInfo(
  chunkManager: ChunkManager,
  hostname: string,
  options: Partial<ProgressOptions>,
): Promise<QueryParameterInfo[]> {
  return chunkManager.memoize.getAsync(
    { type: "render:getQueryParameterInfo", hostname },
    options,
    (progressOptions) =>
      fetchOk(`${hostname}/render-ws/swagger.json`, progressOptions)
        .then((response) => response.json())
        .then(parseQueryParameterInfo),
  );
}

const pathPattern =
  /^([^/?]+)(?:\/([^/?]+))?(?:\/([^/?]+))(?:\/([^/?]*))?(?:\?(.*))?$/;
const urlPattern = /^((?:(?:(?:http|https):\/\/[^,/]+)[^/?]))\/(.*)$/;

function getVolume(
  chunkManager: ChunkManager,
  datasourcePath: string,
  options: Partial<ProgressOptions>,
) {
  let hostname: string;
  let path: string;
  {
    const match = datasourcePath.match(urlPattern);
    if (match === null) {
      throw new Error(
        `Invalid render volume path: ${JSON.stringify(datasourcePath)}`,
      );
    }
    hostname = match[1];
    path = match[2];
  }
  const match = path.match(pathPattern);
  if (match === null) {
    throw new Error(`Invalid volume path ${JSON.stringify(path)}`);
  }
  const owner = match[1];
  const project = match[2];
  const stack = match[3];
  const channel = match[4];

  const parameters = parseQueryStringParameters(match[5] || "");

  return chunkManager.memoize.getAsync(
    { type: "render:MultiscaleVolumeChunkSource", hostname, path },
    options,
    async (progressOptions) => {
      const ownerInfo = await getOwnerInfo(
        chunkManager,
        hostname,
        owner,
        progressOptions,
      );
      const volume = new RenderMultiscaleVolumeChunkSource(
        chunkManager,
        hostname,
        ownerInfo,
        stack,
        project,
        channel,
        parameters,
      );
      const modelSpace = makeCoordinateSpace({
        rank: 3,
        names: ["x", "y", "z"],
        units: ["m", "m", "m"],
        scales: Float64Array.from(
          volume.stackInfo.voxelResolution,
          (x) => x / 1e9,
        ),
        boundingBoxes: [
          makeIdentityTransformedBoundingBox({
            lowerBounds: new Float64Array(volume.stackInfo.lowerVoxelBound),
            upperBounds: new Float64Array(volume.stackInfo.upperVoxelBound),
          }),
        ],
      });
      const dataSource: DataSource = {
        modelTransform: makeIdentityTransform(modelSpace),
        subsources: [
          {
            id: "default",
            default: true,
            subsource: { volume },
          },
          {
            id: "bounds",
            default: true,
            subsource: {
              staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(
                modelSpace.bounds,
              ),
            },
          },
        ],
      };
      return dataSource;
    },
  );
}

export async function stackAndProjectCompleter(
  chunkManager: ChunkManager,
  hostname: string,
  path: string,
  options: Partial<ProgressOptions>,
): Promise<CompletionResult> {
  const stackMatch = path.match(
    /^(?:([^/]+)(?:\/([^/]*))?(?:\/([^/]*))?(\/.*?)?)?$/,
  );
  if (stackMatch === null) {
    // URL has incorrect format, don't return any results.
    throw null;
  }
  if (stackMatch[2] === undefined) {
    // Don't autocomplete the owner
    throw null;
  }

  // Autocomplete the project
  let offset = stackMatch[1].length + 1;
  if (stackMatch[3] === undefined) {
    const projectPrefix = stackMatch[2] || "";
    const ownerInfo = await getOwnerInfo(
      chunkManager,
      hostname,
      stackMatch[1],
      options,
    );
    const completions = getPrefixMatchesWithDescriptions(
      projectPrefix,
      ownerInfo.projects,
      (x) => x[0] + "/",
      () => undefined,
    );
    return { offset, completions };
  }

  // Autocomplete the stack name
  offset += stackMatch[2].length + 1;
  if (stackMatch[4] === undefined) {
    const stackPrefix = stackMatch[3] || "";
    const ownerInfo = await getOwnerInfo(
      chunkManager,
      hostname,
      stackMatch[1],
      options,
    );
    const projectInfo = ownerInfo.projects.get(stackMatch[2]);
    if (projectInfo === undefined) {
      throw null;
    }
    const completions = getPrefixMatchesWithDescriptions(
      stackPrefix,
      projectInfo.stacks,
      (x) => x[0] + "/",
      (x) => {
        return x[1].project;
      },
    );
    return { offset, completions };
  }

  // Autocomplete the channel
  offset += stackMatch[3].length + 1;
  const channelPrefix = stackMatch[4].substr(1) || "";
  const ownerInfo = await getOwnerInfo(
    chunkManager,
    hostname,
    stackMatch[1],
    options,
  );
  const projectInfo = ownerInfo.projects.get(stackMatch[2]);
  if (projectInfo === undefined) {
    throw null;
  }
  const stackInfo = projectInfo.stacks.get(stackMatch[3]);
  if (stackInfo === undefined) {
    throw null;
  }
  const channels = stackInfo.channels;
  if (channels.length === 0) {
    throw null;
  }
  // Try and complete the channel
  const completions = getPrefixMatchesWithDescriptions(
    channelPrefix,
    channels,
    (x) => x,
    () => undefined,
  );
  return { offset, completions };
}

export async function queryParameterCompleter(
  chunkManager: ChunkManager,
  hostname: string,
  query: string,
  options: Partial<ProgressOptions>,
): Promise<CompletionResult> {
  const queryParameterInfo = await getQueryParameterInfo(
    chunkManager,
    hostname,
    options,
  );

  const idx = query.lastIndexOf("&");
  const offset = idx === -1 ? 0 : idx + 1;
  const keyValuePair = query.slice(offset);

  const [key] = keyValuePair.split("=");

  const completions = getPrefixMatchesWithDescriptions(
    key,
    queryParameterInfo,
    (x) => x.name,
    (x) => x.type,
  );
  return { offset, completions };
}

export async function volumeCompleter(
  url: string,
  chunkManager: ChunkManager,
  options: Partial<ProgressOptions>,
): Promise<CompletionResult> {
  const match = url.match(urlPattern);
  if (match === null) {
    // We don't yet have a full hostname.
    throw null;
  }
  const hostname = match[1];
  const path = match[2];

  const [volume, query] = path.split("?");

  let offset = match![1].length + 1;
  if (query === undefined) {
    // Still typing the volume path, no query parameters yet
    const completions = await stackAndProjectCompleter(
      chunkManager,
      hostname,
      volume,
      options,
    );
    return applyCompletionOffset(offset, completions);
  }

  // Typing query parameters now
  offset += volume.length + 1;
  const completions = await queryParameterCompleter(
    chunkManager,
    hostname,
    query,
    options,
  );
  return applyCompletionOffset(offset, completions);
}

export class RenderDataSource implements DataSourceProvider {
  get scheme() {
    return "render";
  }
  get description() {
    return "Render";
  }
  get(options: GetDataSourceOptions): Promise<DataSource> {
    return getVolume(
      options.registry.chunkManager,
      options.providerUrl,
      options,
    );
  }
  completeUrl(options: CompleteUrlOptions) {
    return volumeCompleter(
      options.providerUrl,
      options.registry.chunkManager,
      options,
    );
  }
}
