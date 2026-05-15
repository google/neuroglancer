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

import { describe, expect, test } from "vitest";
import { getS3BucketListing } from "#src/kvstore/s3/list.js";

describe("s3 xml parsing (browser)", () => {
  test("parses default-namespace ListBucketResult prefixes and keys", async () => {
    const listBucketResultXml = `<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Name>example-public-dataset</Name>
      <Prefix></Prefix>
      <KeyCount>5</KeyCount>
      <MaxKeys>1000</MaxKeys>
      <Delimiter>/</Delimiter>
      <EncodingType>url</EncodingType>
      <IsTruncated>false</IsTruncated>
      <Contents>
        <Key>catalog.csv</Key>
        <LastModified>2026-01-15T10:00:00.000Z</LastModified>
        <ETag>&quot;11111111111111111111111111111111-10&quot;</ETag>
        <Size>102400</Size>
        <StorageClass>INTELLIGENT_TIERING</StorageClass>
      </Contents>
      <Contents>
        <Key>readme.txt</Key>
        <LastModified>2026-02-20T08:30:00.000Z</LastModified>
        <ETag>&quot;22222222222222222222222222222222&quot;</ETag>
        <ChecksumAlgorithm>CRC64NVME</ChecksumAlgorithm>
        <ChecksumType>FULL_OBJECT</ChecksumType>
        <Size>256</Size>
        <StorageClass>STANDARD</StorageClass>
      </Contents>
      <CommonPrefixes><Prefix>dataset-alpha/</Prefix></CommonPrefixes>
      <CommonPrefixes><Prefix>dataset-beta/</Prefix></CommonPrefixes>
      <CommonPrefixes><Prefix>archive-2026/</Prefix></CommonPrefixes>
    </ListBucketResult>`;

    const response = await getS3BucketListing(
      "https://example.com/example-public-dataset/",
      "",
      async () =>
        new Response(listBucketResultXml, {
          headers: { "content-type": "application/xml; charset=UTF-8" },
        }),
      {},
    );

    expect(response).toEqual({
      directories: ["dataset-alpha", "dataset-beta", "archive-2026"],
      entries: [{ key: "catalog.csv" }, { key: "readme.txt" }],
    });
  });
});
