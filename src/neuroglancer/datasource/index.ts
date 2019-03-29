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

import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {MeshSource, MultiscaleMeshSource} from 'neuroglancer/mesh/frontend';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {VectorGraphicsType} from 'neuroglancer/sliceview/vector_graphics/base';
import {MultiscaleVectorGraphicsChunkSource} from 'neuroglancer/sliceview/vector_graphics/frontend';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {applyCompletionOffset, CompletionWithDescription} from 'neuroglancer/util/completion';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';

export type Completion = CompletionWithDescription;

export interface CompletionResult {
  offset: number;
  completions: Completion[];
}

/**
 * Returns the length of the prefix of path that corresponds to the "group", according to the
 * specified separator.
 *
 * If the separator is not specified, gueses whether it is '/' or ':'.
 */
export function findSourceGroupBasedOnSeparator(path: string, separator?: string) {
  if (separator === undefined) {
    // Try to guess whether '/' or ':' is the separator.
    if (path.indexOf('/') === -1) {
      separator = ':';
    } else {
      separator = '/';
    }
  }
  let index = path.lastIndexOf(separator);
  if (index === -1) {
    return 0;
  }
  return index + 1;
}


/**
 * Returns the last "component" of path, according to the specified separator.
 * If the separator is not specified, gueses whether it is '/' or ':'.
 */
export function suggestLayerNameBasedOnSeparator(path: string, separator?: string) {
  let groupIndex = findSourceGroupBasedOnSeparator(path, separator);
  return path.substring(groupIndex);
}

export interface GetVolumeOptions {
  /**
   * Hint regarding the usage of the volume.
   */
  volumeType?: VolumeType;

  dataSourceProvider?: DataSourceProvider;
}

export interface GetVectorGraphicsOptions {
  vectorGraphicsType?: VectorGraphicsType;
}

export interface DataSource {
  getVolume?
      (chunkManager: ChunkManager, path: string, options: GetVolumeOptions,
       cancellationToken: CancellationToken):
          Promise<MultiscaleVolumeChunkSource>|MultiscaleVolumeChunkSource;
  getVectorGraphicsSource?
      (chunkManager: ChunkManager, path: string, options: GetVectorGraphicsOptions,
       cancellationToken: CancellationToken):
          Promise<MultiscaleVectorGraphicsChunkSource>|MultiscaleVectorGraphicsChunkSource;
  getMeshSource?(chunkManager: ChunkManager, path: string, cancellationToken: CancellationToken):
      Promise<MeshSource|MultiscaleMeshSource>|MeshSource|MultiscaleMeshSource;
  getSkeletonSource?
      (chunkManager: ChunkManager, path: string, cancellationToken: CancellationToken):
          Promise<SkeletonSource>|SkeletonSource;
  volumeCompleter?(value: string, chunkManager: ChunkManager, cancellationToken: CancellationToken):
      Promise<CompletionResult>;

  getAnnotationSource?
      (chunkManager: ChunkManager, path: string, cancellationToken: CancellationToken):
          Promise<MultiscaleAnnotationSource>|MultiscaleAnnotationSource;

  /**
   * Returns a suggested layer name for the given volume source.
   */
  suggestLayerName?(path: string): string;

  /**
   * Returns the length of the prefix of path that is its 'group'.  This is used for suggesting a
   * default URL for adding a new layer.
   */
  findSourceGroup?(path: string): number;
}

export class DataSource extends RefCounted {
  description?: string;
}

const protocolPattern = /^(?:([a-zA-Z][a-zA-Z0-9-+_]*):\/\/)?(.*)$/;

export class DataSourceProvider extends RefCounted {
  dataSources = new Map<string, Owned<DataSource>>();

  register(name: string, dataSource: Owned<DataSource>) {
    this.dataSources.set(name, this.registerDisposer(dataSource));
  }

  getDataSource(url: string): [DataSource, string, string] {
    let m = url.match(protocolPattern);
    if (m === null || m[1] === undefined) {
      throw new Error(`Data source URL must have the form "<protocol>://<path>".`);
    }
    let dataSource = m[1];
    let factory = this.dataSources.get(dataSource);
    if (factory === undefined) {
      throw new Error(`Unsupported data source: ${JSON.stringify(dataSource)}.`);
    }
    return [factory, m[2], dataSource];
  }

  getVolume(
      chunkManager: ChunkManager, url: string, options: GetVolumeOptions = {},
      cancellationToken = uncancelableToken) {
    let [dataSource, path] = this.getDataSource(url);
    if (options === undefined) {
      options = {};
    }
    options.dataSourceProvider = this;
    return new Promise<MultiscaleVolumeChunkSource>(resolve => {
      resolve(dataSource.getVolume!(chunkManager, path, options, cancellationToken));
    });
  }

  getAnnotationSource(
      chunkManager: ChunkManager, url: string, cancellationToken = uncancelableToken) {
    let [dataSource, path] = this.getDataSource(url);
    return new Promise<MultiscaleAnnotationSource>(resolve => {
      resolve(dataSource.getAnnotationSource!(chunkManager, path, cancellationToken));
    });
  }

  getVectorGraphicsSource(
      chunkManager: ChunkManager, url: string, options: GetVectorGraphicsOptions = {},
      cancellationToken = uncancelableToken) {
    let [dataSource, path] = this.getDataSource(url);
    return new Promise<MultiscaleVectorGraphicsChunkSource>(resolve => {
      resolve(dataSource.getVectorGraphicsSource!(chunkManager, path, options, cancellationToken));
    });
  }

  getMeshSource(chunkManager: ChunkManager, url: string, cancellationToken = uncancelableToken) {
    let [dataSource, path] = this.getDataSource(url);
    return new Promise<MeshSource|MultiscaleMeshSource>(resolve => {
      resolve(dataSource.getMeshSource!(chunkManager, path, cancellationToken));
    });
  }

  getSkeletonSource(
      chunkManager: ChunkManager, url: string, cancellationToken = uncancelableToken) {
    let [dataSource, path] = this.getDataSource(url);
    return new Promise<SkeletonSource>(resolve => {
      resolve(dataSource.getSkeletonSource!(chunkManager, path, cancellationToken));
    });
  }

  volumeCompleter(url: string, chunkManager: ChunkManager, cancellationToken = uncancelableToken):
      Promise<CompletionResult> {
    // Check if url matches a protocol.  Note that protocolPattern always matches.
    let protocolMatch = url.match(protocolPattern)!;
    let protocol = protocolMatch[1];
    if (protocol === undefined) {
      // Return protocol completions.
      let completions: Completion[] = [];
      for (let [name, factory] of this.dataSources) {
        name = name + '://';
        if (name.startsWith(url)) {
          completions.push({value: name, description: factory.description});
        }
      }
      return Promise.resolve({offset: 0, completions});
    } else {
      const factory = this.dataSources.get(protocol);
      if (factory !== undefined) {
        if (factory.volumeCompleter !== undefined) {
          return factory.volumeCompleter!(protocolMatch[2], chunkManager, cancellationToken)
              .then(completions => applyCompletionOffset(protocol.length + 3, completions));
        }
      }
      return Promise.reject<CompletionResult>(null);
    }
  }

  suggestLayerName(url: string) {
    let [dataSource, path] = this.getDataSource(url);
    let suggestor = dataSource.suggestLayerName;
    if (suggestor !== undefined) {
      return suggestor(path);
    }
    return suggestLayerNameBasedOnSeparator(path);
  }

  findSourceGroup(url: string) {
    let [dataSource, path, dataSourceName] = this.getDataSource(url);
    let helper = dataSource.findSourceGroup || findSourceGroupBasedOnSeparator;
    return helper(path) + dataSourceName.length + 3;
  }
}
