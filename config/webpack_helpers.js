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

'use strict';

const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const ExtractTextPlugin = require('extract-text-webpack-plugin');
const webpack = require('webpack');
const ClosureCompilerPlugin = require('webpack-closure-compiler');

const DEFAULT_BABEL_PLUGINS = exports.DEFAULT_BABEL_PLUGINS = [
  // Needed until Firefox implements proper handling of default values in
  // destructuring expressions.
  'transform-es2015-destructuring',
  'transform-es2015-parameters',

  // Needed until Firefox implements proper for loop scoping of let, which is
  // not fixed as of Firefox 46.
  'transform-es2015-block-scoping',

  // This is needed in order to avoid transform-es2015-block-scoping generating invalid code.
  'transform-es2015-classes',
];

const DEFAULT_DATA_SOURCES = exports.DEFAULT_DATA_SOURCES = [
  'neuroglancer/datasource/brainmaps',
  'neuroglancer/datasource/ndstore',
  'neuroglancer/datasource/dvid',
  'neuroglancer/datasource/openconnectome',
  'neuroglancer/datasource/precomputed',
];

function getTypescriptLoaderEntry(options) {
  if (options === undefined) {
    options = {};
  }
  const useBabel = options.useBabel !== undefined ? options.useBabel : true;
  const babelPlugins = options.babelPlugins !== undefined ? options.babelPlugins : DEFAULT_BABEL_PLUGINS;
  const babelConfig = {
    cacheDirectory: true,
    plugins: babelPlugins,
  };

  let tsLoaderPrefix = '';
  tsLoaderPrefix = `babel?${JSON.stringify(babelConfig)}!`;
  return { test: /\.ts$/, loader: tsLoaderPrefix + 'ts' };
}

/**
 * Returns an array containing the main and worker bundle configurations.
 */
function getBaseConfig(options) {
  options = options || {};
  let tsconfigPath = options.tsconfigPath || path.resolve(__dirname, '../tsconfig.json');
  let baseConfig = {
    resolveLoader: {
      alias: {
        'raw-data$': path.resolve(__dirname, 'raw-data-loader.js'),
      },
    },
    resolve: {
      extensions: ['', '.ts', '.js'],
      alias: {
        'neuroglancer': path.resolve(__dirname, '../src/neuroglancer'),
        'neuroglancer-testdata': path.resolve(__dirname, '../testdata'),

        // Patched version of jpgjs.
        'jpgjs': path.resolve(__dirname, '../third_party/jpgjs/jpg.js'),
      }
    },
    devtool: 'source-map',
    module: {
      loaders: [
        getTypescriptLoaderEntry(options.typescriptLoaderOptions),
        {
          test: /\.css$/,
          loader: ExtractTextPlugin.extract('style-loader', 'css-loader')
        },
      ],
    },
    node: {'Buffer': false},
    ts: {
      configFileName: tsconfigPath,
      instance: 'main',
    },
  };
  if (!options.noOutput) {
    if (options.outputPath === undefined) {
      throw new Error('options.outputPath must be specified.');
    }
    baseConfig.output = {
      filename: '[name].bundle.js',
      path: options.outputPath,
      sourcePrefix: ''
    };
  }
  return baseConfig;
}

function getViewerConfig(options) {
  options = options || {};
  let minify = options.minify;
  if (minify && options.useBabel === undefined) {
    options.useBabel = false;
  }
  let baseConfig = getBaseConfig(options);
  if (options.modifyBaseConfig) {
    options.modifyBaseConfig(baseConfig);
  }
  let dataSources = options.dataSources || DEFAULT_DATA_SOURCES;
  let frontendDataSourceModules = [];
  let backendDataSourceModules = [];
  for (let datasource of dataSources) {
    frontendDataSourceModules.push(`${datasource}/frontend`);
    backendDataSourceModules.push(`${datasource}/backend`);
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
    'BRAINMAPS_CLIENT_ID': JSON.stringify(
        '639403125587-4k5hgdfumtrvur8v48e3pr7oo91d765k.apps.googleusercontent.com'),
  };
  let extraDefines = options.defines || {};
  let srcDir = path.resolve(__dirname, '../src');
  let commonPlugins = [];
  if (minify) {
    commonPlugins.push(new ClosureCompilerPlugin({
      compiler: {
        language_in: 'ECMASCRIPT6',
        language_out: 'ECMASCRIPT5',
        compilation_level: 'SIMPLE',
      },
    }));
  }
  let extraChunkWorkerModules = options.chunkWorkerModules || [];
  let extraCommonPlugins = options.commonPlugins || [];
  let extraFrontendPlugins = options.frontendPlugins || [];
  let extraChunkWorkerPlugins = options.chunkWorkerPlugins || [];
  let chunkWorkerModules = [
    'neuroglancer/worker_rpc_context',
    'neuroglancer/chunk_manager/backend',
    'neuroglancer/sliceview/backend',
    ...backendDataSourceModules,
    ...extraChunkWorkerModules,
  ];
  let frontendMain = options.frontendMain || path.resolve(srcDir, 'main.ts');
  let htmlPlugin = options.htmlPlugin || new HtmlWebpackPlugin({template: path.resolve(srcDir, 'index.html')});
  let cssPlugin = options.cssPlugin || new ExtractTextPlugin('styles.css', {allChunks: true});
  return [
    Object.assign(
        {
          entry: {'main': [...frontendDataSourceModules, frontendMain]},
          plugins: [
            htmlPlugin,
            cssPlugin,
            new webpack.DefinePlugin(
                Object.assign({}, defaultDefines, extraDefines, {
                  'WORKER': false,
                })),
            ...extraFrontendPlugins,
            ...commonPlugins,
            ...extraCommonPlugins,
          ],
        },
        baseConfig),
    Object.assign(
        {
          entry: {'chunk_worker': [...chunkWorkerModules]},
          plugins: [
            new webpack.DefinePlugin(Object.assign(
                {}, defaultDefines, extraDefines, {'WORKER': true})),
            ...extraChunkWorkerPlugins,
            ...commonPlugins,
            ...extraCommonPlugins,
          ],
        },
        baseConfig),
  ];
}

exports.getTypescriptLoaderEntry = getTypescriptLoaderEntry;
exports.getBaseConfig = getBaseConfig;
exports.getViewerConfig = getViewerConfig;
