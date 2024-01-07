/**
 * @license
 * Copyright 2016-2020 Google LLC
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

"use strict";

const resolveReal = require("./resolve_real");

const DEFAULT_DATA_SOURCES = (exports.DEFAULT_DATA_SOURCES = [
  {
    source: "#/datasource/brainmaps",
    registerCredentials: "#/datasource/brainmaps/register_credentials_provider",
    asyncComputation: ["#/async_computation/decode_jpeg"],
  },
  {
    source: "#/datasource/boss",
    registerCredentials: "#/datasource/boss/register_credentials_provider",
    asyncComputation: [
      "#/async_computation/decode_jpeg",
      "#/async_computation/decode_gzip",
    ],
  },
  {
    source: "#/datasource/deepzoom",
    asyncComputation: [
      "#/async_computation/decode_jpeg",
      "#/async_computation/decode_png",
    ],
  },
  {
    source: "#/datasource/dvid",
    registerCredentials: "#/datasource/dvid/register_credentials_provider",
    asyncComputation: ["#/async_computation/decode_jpeg"],
  },
  {
    source: "#/datasource/render",
    asyncComputation: ["#/async_computation/decode_jpeg"],
  },
  {
    source: "#/datasource/precomputed",
    asyncComputation: [
      "#/async_computation/decode_jpeg",
      "#/async_computation/decode_gzip",
      "#/async_computation/decode_compresso",
      "#/async_computation/decode_png",
    ],
  },
  {
    source: "#/datasource/nifti",
    asyncComputation: ["#/async_computation/decode_gzip"],
  },
  {
    source: "#/datasource/n5",
    asyncComputation: [
      "#/async_computation/decode_gzip",
      "#/async_computation/decode_blosc",
    ],
  },
  {
    source: "#/datasource/zarr",
    asyncComputation: [
      "#/async_computation/decode_gzip",
      "#/async_computation/decode_blosc",
      "#/async_computation/decode_zstd",
    ],
  },
  // '#/datasource/computed',
  // '#/datasource/computed/example',
  // '#/datasource/computed/tensorflow',
  {
    source: "#/datasource/vtk",
    asyncComputation: ["#/async_computation/vtk_mesh"],
  },
  {
    source: "#/datasource/obj",
    asyncComputation: ["#/async_computation/obj_mesh"],
  },
  {
    source: "#/datasource/ngauth",
    frontend: null,
    backend: null,
    register: null,
    registerCredentials: "#/datasource/ngauth/register_credentials_provider",
  },
  {
    source: "#/datasource/middleauth",
    frontend: null,
    backend: null,
    register: null,
    registerCredentials:
      "#/datasource/middleauth/register_credentials_provider",
  },
  {
    source: "#/datasource/nggraph",
  },
  {
    source: "#/datasource/graphene",
    asyncComputation: [
      "#/async_computation/decode_jpeg",
      "#/async_computation/decode_gzip",
    ],
  },
]);

const DEFAULT_SUPPORTED_LAYERS = (exports.DEFAULT_SUPPORTED_LAYERS = [
  "#/image_user_layer",
  "#/segmentation_user_layer",
  "#/single_mesh_user_layer",
  "#/annotation/user_layer",
]);

function getBundleSources(options) {
  const dataSources = [
    ...(options.dataSources || DEFAULT_DATA_SOURCES),
    ...(options.extraDataSources || []),
  ];
  const supportedLayers = options.supportedLayers || DEFAULT_SUPPORTED_LAYERS;
  const frontendDataSourceModules = [];
  const backendDataSourceModules = [];
  const asyncComputationDataSourceModules = new Set();
  const registerCredentials =
    options.registerCredentials !== undefined
      ? options.registerCredentials
      : !options.python;
  for (let datasource of dataSources) {
    if (typeof datasource === "string") {
      datasource = { source: datasource };
    }
    if (datasource.frontend !== null) {
      frontendDataSourceModules.push(
        datasource.frontend || `${datasource.source}/frontend`,
      );
    }
    if (registerCredentials && datasource.registerCredentials) {
      frontendDataSourceModules.push(datasource.registerCredentials);
    }
    if (datasource.register === undefined) {
      frontendDataSourceModules.push(`${datasource.source}/register_default`);
    } else if (datasource.register !== null) {
      frontendDataSourceModules.push(datasource.register);
    }
    if (datasource.backend !== null) {
      backendDataSourceModules.push(
        datasource.backend || `${datasource.source}/backend`,
      );
    }
    if (datasource.asyncComputation !== undefined) {
      for (const m of datasource.asyncComputation) {
        asyncComputationDataSourceModules.add(m);
      }
    }
  }
  const defaultDefines = {
    // This is the default client ID used for the hosted neuroglancer.
    // In addition to the hosted neuroglancer origin, it is valid for
    // the origins:
    //
    //   localhost:8000
    //   127.0.0.1:8000
    //   localhost:8080
    //   127.0.0.1:8080
    //
    // To deploy to a different origin, you will need to generate your
    // own client ID from on the Google Developer Console and substitute
    // it in.
    BRAINMAPS_CLIENT_ID: JSON.stringify(
      "639403125587-4k5hgdfumtrvur8v48e3pr7oo91d765k.apps.googleusercontent.com",
    ),

    "process.env.NODE_ENV": JSON.stringify("production"),

    global: "window",
  };
  const extraDefines = options.defines || {};
  const srcDir = resolveReal(__dirname, "..", "src");
  const extraChunkWorkerModules = options.chunkWorkerModules || [];
  const extraAsyncComputationModules = options.asyncComputationModules || [];
  const chunkWorkerModules = [
    "#/worker_rpc_context",
    "#/chunk_manager/backend",
    "#/sliceview/backend",
    "#/perspective_view/backend",
    "#/volume_rendering/backend",
    "#/annotation/backend",
    ...backendDataSourceModules,
    ...extraChunkWorkerModules,
  ];
  const asyncComputationModules = [
    "#/async_computation/handler",
    "#/async_computation/encode_compressed_segmentation",
    ...asyncComputationDataSourceModules,
    ...extraAsyncComputationModules,
  ];
  const frontendModules = options.frontendModules || [
    resolveReal(srcDir, "main.ts"),
  ];
  const frontendLayerModules = [];
  for (const name of supportedLayers) {
    frontendLayerModules.push(name);
  }

  return {
    main: [
      ...frontendDataSourceModules,
      ...frontendLayerModules,
      ...frontendModules,
    ],
    workers: {
      chunk_worker: chunkWorkerModules,
      async_computation: asyncComputationModules,
    },
    defines: { ...defaultDefines, ...extraDefines },
  };
}
exports.getBundleSources = getBundleSources;

function makePythonClientOptions(options) {
  const srcDir = resolveReal(__dirname, "..", "src");
  options = Object.assign({}, options);
  options.extraDataSources = [
    ...(options.extraDataSources || []),
    { source: "#/datasource/python", register: null },
  ];
  options.frontendModules = options.frontendModules || [
    resolveReal(srcDir, "main_python.ts"),
  ];
  options.registerCredentials = false;
  options.defines = Object.assign(options.defines || {}, {
    NEUROGLANCER_PYTHON_INTEGRATION: "true",
  });
  return options;
}

exports.makePythonClientOptions = makePythonClientOptions;

exports.getViewerOptions = (baseConfig, options = {}) => {
  if (options.python) {
    baseConfig = makePythonClientOptions(baseConfig);
  }
  if (options.module) {
    const srcDir = resolveReal(__dirname, "..", "src");
    baseConfig.frontendModules = [resolveReal(srcDir, "main_module.ts")];
  }
  return baseConfig;
};
