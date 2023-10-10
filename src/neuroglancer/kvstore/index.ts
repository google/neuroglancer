/**
 * @license
 * Copyright 2023 Google Inc.
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

import {CancellationToken} from 'neuroglancer/util/cancellation';

export interface ByteRange {
  offset: number;
  length: number;
}

export function composeByteRangeRequest(
    outer: ByteRange, inner: ByteRangeRequest|undefined): {outer: ByteRange, inner: ByteRange} {
  if (inner == undefined) {
    return {outer, inner: {offset: 0, length: outer.length}};
  }
  if ('suffixLength' in inner) {
    const length = Math.min(outer.length, inner.suffixLength);
    return {
      outer: {offset: outer.offset + (outer.length - length), length},
      inner: {offset: outer.length - length, length}
    };
  }
  if (inner.offset + inner.length > outer.length) {
    throw new Error(`Requested byte range ${JSON.stringify(inner)} not valid for value of length ${
        outer.length}`);
  }
  return {outer: {offset: outer.offset + inner.offset, length: inner.length}, inner};
}

export type ByteRangeRequest = ByteRange|{
  suffixLength: number;
};

export interface ReadResponse {
  data: Uint8Array;
  dataRange: ByteRange;
  totalSize: number|undefined;
}

export interface ReadOptions {
  byteRange?: ByteRangeRequest;
  cancellationToken?: CancellationToken;
}

export interface ListOptions {
  prefix: string;
  cancellationToken?: CancellationToken;
}

export interface ListEntry {
  key: string;
}

export interface ListResponse {
  entries: ListEntry[];
  directories: string[];
}


export interface ReadableKvStore<Key = string> {
  read(key: Key, options: ReadOptions): Promise<ReadResponse|undefined>;
}

export interface ListableKvStore {
  list(options: ListOptions): Promise<ListResponse>;
}

export interface KvStore extends ReadableKvStore, ListableKvStore {}
