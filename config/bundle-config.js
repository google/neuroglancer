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

'use strict';

const resolveReal = require('./resolve_real');

const DEFAULT_DATA_SOURCES = exports.DEFAULT_DATA_SOURCES = [
  {
    source: 'neuroglancer/datasource/brainmaps',
    registerCredentials: 'neuroglancer/datasource/brainmaps/register_credentials_provider',
    asyncComputation: [
      'neuroglancer/async_computation/decode_jpeg',
    ],
  },
  {
    source: 'neuroglancer/datasource/boss',
    registerCredentials: 'neuroglancer/datasource/boss/register_credentials_provider',
    asyncComputation: [
      'neuroglancer/async_computation/decode_jpeg',
      'neuroglancer/async_computation/decode_gzip',
    ],
  },
  {
    source: 'neuroglancer/datasource/dvid',
    registerCredentials: 'neuroglancer/datasource/dvid/register_credentials_provider',
    asyncComputation: [
      'neuroglancer/async_computation/decode_jpeg',
    ],
  },
  {
    source: 'neuroglancer/datasource/render',
    asyncComputation: [
      'neuroglancer/async_computation/decode_jpeg',
    ],
  },
  {
    source: 'neuroglancer/datasource/precomputed',
    asyncComputation: [
      'neuroglancer/async_computation/decode_jpeg',
      'neuroglancer/async_computation/decode_gzip',
      'neuroglancer/async_computation/decode_compresso',
    ],
  },
  {
    source: 'neuroglancer/datasource/nifti',
    asyncComputation: [
      'neuroglancer/async_computation/decode_gzip',
    ],
  },
  {
    source: 'neuroglancer/datasource/n5',
    asyncComputation: [
      'neuroglancer/async_computation/decode_gzip',
      'neuroglancer/async_computation/decode_blosc',
    ],
  },
  {
    source: 'neuroglancer/datasource/zarr',
    asyncComputation: [
      'neuroglancer/async_computation/decode_gzip',
      'neuroglancer/async_computation/decode_blosc',
    ],
  },
  // 'neuroglancer/datasource/computed',
  // 'neuroglancer/datasource/computed/example',
  // 'neuroglancer/datasource/computed/tensorflow',
  {
    source: 'neuroglancer/datasource/vtk',
    asyncComputation: [
      'neuroglancer/async_computation/vtk_mesh',
    ],
  },
  {
    source: 'neuroglancer/datasource/obj',
    asyncComputation: [
      'neuroglancer/async_computation/obj_mesh',
    ],
  },
  {
    source: 'neuroglancer/datasource/ngauth',
    frontend: null,
    backend: null,
    register: null,
    registerCredentials: 'neuroglancer/datasource/ngauth/register_credentials_provider',
  },
  {
    source: 'neuroglancer/datasource/middleauth',
    frontend: null,
    backend: null,
    register: null,
    registerCredentials: 'neuroglancer/datasource/middleauth/register_credentials_provider',
  },
  {
    source: 'neuroglancer/datasource/nggraph',
  },
];

const DEFAULT_SUPPORTED_LAYERS = exports.DEFAULT_SUPPORTED_LAYERS = [
  'neuroglancer/image_user_layer',
  'neuroglancer/segmentation_user_layer',
  'neuroglancer/single_mesh_user_layer',
  'neuroglancer/annotation/user_layer',
];

function getBundleSources(options) {
  let dataSources =
      [...(options.dataSources || DEFAULT_DATA_SOURCES), ...(options.extraDataSources || [])];
  let supportedLayers = options.supportedLayers || DEFAULT_SUPPORTED_LAYERS;
  let frontendDataSourceModules = [];
  let backendDataSourceModules = [];
  let asyncComputationDataSourceModules = new Set();
  const registerCredentials =
      options.registerCredentials !== undefined ? options.registerCredentials : !options.python;
  for (let datasource of dataSources) {
    if (typeof datasource === 'string') {
      datasource = {source: datasource};
    }
    if (datasource.frontend !== null) {
      frontendDataSourceModules.push(datasource.frontend || `${datasource.source}/frontend`);
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
      backendDataSourceModules.push(datasource.backend || `${datasource.source}/backend`);
    }
    if (datasource.asyncComputation !== undefined) {
      for (const m of datasource.asyncComputation) {
        asyncComputationDataSourceModules.add(m);
      }
    }
  }
  let defaultDefines = {
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
    'BRAINMAPS_CLIENT_ID':
        JSON.stringify('639403125587-4k5hgdfumtrvur8v48e3pr7oo91d765k.apps.googleusercontent.com'),

    'process.env.NODE_ENV': JSON.stringify('production'),

    'global': 'window',
  };
  let extraDefines = options.defines || {};
  let srcDir = resolveReal(__dirname, '..', 'src');
  let extraChunkWorkerModules = options.chunkWorkerModules || [];
  let extraAsyncComputationModules = options.asyncComputationModules || [];
  let chunkWorkerModules = [
    'neuroglancer/worker_rpc_context',
    'neuroglancer/chunk_manager/backend',
    'neuroglancer/sliceview/backend',
    'neuroglancer/perspective_view/backend',
    'neuroglancer/volume_rendering/backend',
    'neuroglancer/annotation/backend',
    ...backendDataSourceModules,
    ...extraChunkWorkerModules,
  ];
  let asyncComputationModules = [
    'neuroglancer/async_computation/handler',
    'neuroglancer/async_computation/encode_compressed_segmentation',
    ...asyncComputationDataSourceModules,
    ...extraAsyncComputationModules,
  ];
  let frontendModules = options.frontendModules || [resolveReal(srcDir, 'main.ts')];
  let frontendLayerModules = [];
  for (let name of supportedLayers) {
    frontendLayerModules.push(name);
  }

  return {
    main: [...frontendDataSourceModules, ...frontendLayerModules, ...frontendModules],
    workers: {
      'chunk_worker': chunkWorkerModules,
      'async_computation': asyncComputationModules,
    },
    defines: {...defaultDefines, ...extraDefines},
  };
}
exports.getBundleSources = getBundleSources;

function makePythonClientOptions(options) {
  const srcDir = resolveReal(__dirname, '..', 'src');
  options = Object.assign({}, options);
  options.extraDataSources = [
    ...(options.extraDataSources || []),
    {source: 'neuroglancer/datasource/python', register: null},
  ];
  options.frontendModules = options.frontendModules || [resolveReal(srcDir, 'main_python.ts')];
  options.registerCredentials = false;
  options.defines = Object.assign(options.defines || {}, {NEUROGLANCER_PYTHON_INTEGRATION: 'true'});
  return options;
}

exports.makePythonClientOptions = makePythonClientOptions;

exports.getViewerOptions = function (baseConfig, options = {}) {
  if (options.python) {
    baseConfig = makePythonClientOptions(baseConfig);
  }
  if (options.module) {
    const srcDir = resolveReal(__dirname, '..', 'src');
    baseConfig.frontendModules = [resolveReal(srcDir, 'main_module.ts')];
  }
  return baseConfig;
};
