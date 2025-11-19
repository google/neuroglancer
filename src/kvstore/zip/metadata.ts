/**
 * @license
 * Copyright 2025 Google Inc.
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
 * Derived from https://github.com/greggman/unzipit/blob/4d94c9b77f7815062ff4460311e8b3ce4f7d5deb/src/unzipit.js
 *
 * Includes only parsing of raw entries.
 *
 * @license
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Josh Wolfe
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * MIT License
 *
 * Copyright (c) 2019 Gregg Tavares
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { buf as crc32buf } from "crc-32";
import type { ProgressOptions } from "#src/util/progress_listener.js";

export interface ZipEntry {
  versionMadeBy: number;
  versionNeededToExtract: number;
  generalPurposeBitFlag: number;
  compressionMethod: number;
  lastModFileTime: number;
  lastModFileDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  nameBytes: Uint8Array<ArrayBuffer>;
  commentBytes: Uint8Array<ArrayBuffer>;
  internalFileAttributes: number;
  externalFileAttributes: number;
  relativeOffsetOfLocalHeader: number;
  fileName: string;
}

export interface ZipMetadata {
  entries: ZipEntry[];
  commentBytes: Uint8Array<ArrayBuffer>;
  // Estimated size in bytes of metadata.
  sizeEstimate: number;
}

export const EOCDR_WITHOUT_COMMENT_SIZE = 22;
export const MAX_COMMENT_SIZE = 0xffff; // 2-byte size
const EOCDR_SIGNATURE = 0x06054b50;
const ZIP64_EOCDR_SIGNATURE = 0x06064b50;

export interface Reader {
  (
    offset: number,
    length: number,
    progressOptions: Partial<ProgressOptions>,
  ): Promise<Uint8Array<ArrayBuffer>>;
}

function lastReadCachingReader(base: Reader) {
  let lastReadOffset: number = 0;
  let lastReadBuffer: Uint8Array<ArrayBuffer> | undefined;

  return async function lastReadCachingRead(
    offset: number,
    length: number,
    progressOptions: Partial<ProgressOptions>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (lastReadBuffer !== undefined) {
      if (
        offset > lastReadOffset &&
        offset + length <= lastReadOffset + lastReadBuffer.length
      ) {
        return lastReadBuffer.subarray(
          offset - lastReadOffset,
          offset + length - lastReadOffset,
        );
      }
    }

    const newBuffer = await base(offset, length, progressOptions);
    lastReadOffset = offset;
    lastReadBuffer = newBuffer;
    return newBuffer;
  };
}

export function parseEndOfCentralDirectoryRecord(data: Uint8Array):
  | {
      eocdrOffset: number;
      diskNumber: number;
      entryCount: number;
      centralDirectorySize: number;
      centralDirectoryOffset: number;
    }
  | undefined {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = data.length;
  for (let i = size - EOCDR_WITHOUT_COMMENT_SIZE; i >= 0; --i) {
    // 0 - End of central directory signature
    if (dv.getUint32(i, /*littleEndian=*/ true) !== EOCDR_SIGNATURE) {
      continue;
    }

    // 20 - Comment length
    const commentLength = dv.getUint16(i + 20, /*littleEndian=*/ true);
    const expectedCommentLength = size - i - EOCDR_WITHOUT_COMMENT_SIZE;
    if (commentLength !== expectedCommentLength) {
      continue;
    }

    // 4 - Number of this disk
    const diskNumber = dv.getUint16(i + 4, /*littleEndian=*/ true);

    // 6 - Disk where central directory starts
    // 8 - Number of central directory records on this disk
    // 10 - Total number of central directory records
    const entryCount = dv.getUint16(i + 10, /*littleEndian=*/ true);
    // 12 - Size of central directory (bytes)
    const centralDirectorySize = dv.getUint32(i + 12, /*littleEndian=*/ true);
    // 16 - Offset of start of central directory, relative to start of archive
    const centralDirectoryOffset = dv.getUint32(i + 16, /*littleEndian=*/ true);

    return {
      eocdrOffset: i,
      diskNumber,
      entryCount,
      centralDirectorySize,
      centralDirectoryOffset,
    };
  }

  return undefined;
}

async function findEndOfCentralDirectory(
  reader: Reader,
  totalLength: number,
  options: Partial<ProgressOptions>,
) {
  const size = Math.min(
    EOCDR_WITHOUT_COMMENT_SIZE + MAX_COMMENT_SIZE,
    totalLength,
  );
  const readStart = totalLength - size;
  const data = await reader(readStart, size, options);
  const record = parseEndOfCentralDirectoryRecord(data);
  if (record === undefined) {
    throw new Error(
      "End of central directory record signature not found; either not a zip file or file is truncated.",
    );
  }
  const {
    eocdrOffset,
    diskNumber,
    entryCount,
    centralDirectorySize,
    centralDirectoryOffset,
  } = record;
  if (diskNumber !== 0) {
    throw new Error(
      `Multi-volume zip files are not supported. This is volume: ${diskNumber}`,
    );
  }

  // 22 - Comment
  // the encoding is always cp437.
  const commentBytes = data.slice(eocdrOffset + 22, data.length);

  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    return await readZip64CentralDirectory(
      reader,
      readStart + eocdrOffset,
      commentBytes,
      options,
    );
  } else {
    return await readEntries(
      reader,
      centralDirectoryOffset,
      centralDirectorySize,
      entryCount,
      commentBytes,
      options,
    );
  }
}

const END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;

async function readZip64CentralDirectory(
  reader: Reader,
  eocdrOffset: number,
  commentBytes: Uint8Array<ArrayBuffer>,
  progressOptions: Partial<ProgressOptions>,
) {
  // ZIP64 Zip64 end of central directory locator
  const zip64EocdlOffset = eocdrOffset - 20;
  const eocdl = await reader(zip64EocdlOffset, 20, progressOptions);

  const eocdlDv = new DataView(
    eocdl.buffer,
    eocdl.byteOffset,
    eocdl.byteLength,
  );

  // 0 - zip64 end of central dir locator signature
  if (
    eocdlDv.getUint32(0, /*littleEndian=*/ true) !==
    END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE
  ) {
    throw new Error("invalid zip64 end of central directory locator signature");
  }

  // 4 - number of the disk with the start of the zip64 end of central directory
  // 8 - relative offset of the zip64 end of central directory record
  const zip64EocdrOffset = eocdlDv.getBigUint64(8, /*littleEndian=*/ true);
  // 16 - total number of disks

  // ZIP64 end of central directory record
  const zip64Eocdr = await reader(
    Number(zip64EocdrOffset),
    56,
    progressOptions,
  );

  const zip64EocdrDv = new DataView(
    zip64Eocdr.buffer,
    zip64Eocdr.byteOffset,
    zip64Eocdr.byteLength,
  );

  // 0 - zip64 end of central dir signature                           4 bytes  (0x06064b50)
  if (
    zip64EocdrDv.getUint32(0, /*littleEndian=*/ true) !== ZIP64_EOCDR_SIGNATURE
  ) {
    throw new Error("invalid zip64 end of central directory record signature");
  }
  // 4 - size of zip64 end of central directory record                8 bytes
  // 12 - version made by                                             2 bytes
  // 14 - version needed to extract                                   2 bytes
  // 16 - number of this disk                                         4 bytes
  // 20 - number of the disk with the start of the central directory  4 bytes
  // 24 - total number of entries in the central directory on this disk         8 bytes
  // 32 - total number of entries in the central directory            8 bytes
  const entryCount = zip64EocdrDv.getBigUint64(32, /*littleEndian=*/ true);
  // 40 - size of the central directory                               8 bytes
  const centralDirectorySize = zip64EocdrDv.getBigUint64(
    40,
    /*littleEndian=*/ true,
  );
  // 48 - offset of start of central directory with respect to the starting disk number     8 bytes
  const centralDirectoryOffset = zip64EocdrDv.getBigUint64(
    48,
    /*littleEndian=*/ true,
  );
  // 56 - zip64 extensible data sector                                (variable size)
  return readEntries(
    reader,
    Number(centralDirectoryOffset),
    Number(centralDirectorySize),
    Number(entryCount),
    commentBytes,
    progressOptions,
  );
}

const CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;

async function readEntries(
  reader: Reader,
  centralDirectoryOffset: number,
  centralDirectorySize: number,
  rawEntryCount: number,
  commentBytes: Uint8Array<ArrayBuffer>,
  progressOptions: Partial<ProgressOptions>,
): Promise<ZipMetadata> {
  let readEntryCursor = 0;
  const allEntriesBuffer = await reader(
    centralDirectoryOffset,
    centralDirectorySize,
    progressOptions,
  );
  const rawEntries = [];

  const dv = new DataView(
    allEntriesBuffer.buffer,
    allEntriesBuffer.byteOffset,
    allEntriesBuffer.byteLength,
  );

  const textDecoder = new TextDecoder();

  for (let e = 0; e < rawEntryCount; ++e) {
    // 0 - Central directory file header signature
    const signature = dv.getUint32(readEntryCursor + 0, /*littleEndian=*/ true);
    if (signature !== CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE) {
      throw new Error(
        `invalid central directory file header signature: 0x${signature.toString(16)}`,
      );
    }
    // 4 - Version made by
    const versionMadeBy = dv.getUint16(
      readEntryCursor + 4,
      /*littleEndian=*/ true,
    );
    // 6 - Version needed to extract (minimum)
    const versionNeededToExtract = dv.getUint16(
      readEntryCursor + 6,
      /*littleEndian=*/ true,
    );
    // 8 - General purpose bit flag
    const generalPurposeBitFlag = dv.getUint16(
      readEntryCursor + 8,
      /*littleEndian=*/ true,
    );
    // 10 - Compression method
    const compressionMethod = dv.getUint16(
      readEntryCursor + 10,
      /*littleEndian=*/ true,
    );
    // 12 - File last modification time
    const lastModFileTime = dv.getUint16(
      readEntryCursor + 12,
      /*littleEndian=*/ true,
    );
    // 14 - File last modification date
    const lastModFileDate = dv.getUint16(
      readEntryCursor + 14,
      /*littleEndian=*/ true,
    );
    // 16 - CRC-32
    const crc32 = dv.getUint32(readEntryCursor + 16, /*littleEndian=*/ true);
    // 20 - Compressed size
    let compressedSize = dv.getUint32(
      readEntryCursor + 20,
      /*littleEndian=*/ true,
    );
    // 24 - Uncompressed size
    let uncompressedSize = dv.getUint32(
      readEntryCursor + 24,
      /*littleEndian=*/ true,
    );
    // 28 - File name length (n)
    const fileNameLength = dv.getUint16(
      readEntryCursor + 28,
      /*littleEndian=*/ true,
    );
    // 30 - Extra field length (m)
    const extraFieldLength = dv.getUint16(
      readEntryCursor + 30,
      /*littleEndian=*/ true,
    );
    // 32 - File comment length (k)
    const fileCommentLength = dv.getUint16(
      readEntryCursor + 32,
      /*littleEndian=*/ true,
    );
    // 34 - Disk number where file starts
    // 36 - Internal file attributes
    const internalFileAttributes = dv.getUint16(
      readEntryCursor + 36,
      /*littleEndian=*/ true,
    );
    // 38 - External file attributes
    const externalFileAttributes = dv.getUint32(
      readEntryCursor + 38,
      /*littleEndian=*/ true,
    );
    // 42 - Relative offset of local file header
    let relativeOffsetOfLocalHeader = dv.getUint32(
      readEntryCursor + 42,
      /*littleEndian=*/ true,
    );

    if (generalPurposeBitFlag & 0x40) {
      throw new Error("strong encryption is not supported");
    }

    readEntryCursor += 46;

    // 46 - File name
    let nameBytes = allEntriesBuffer.subarray(
      readEntryCursor,
      (readEntryCursor += fileNameLength),
    );

    let isUTF8 = (generalPurposeBitFlag & 0x800) !== 0;

    // 46+n - Extra field
    const extraFields = [];
    for (let i = 0; i < extraFieldLength - 3; ) {
      const headerId = dv.getUint16(
        readEntryCursor + i + 0,
        /*littleEndian=*/ true,
      );
      const dataSize = dv.getUint16(
        readEntryCursor + i + 2,
        /*littleEndian=*/ true,
      );
      const dataStart = i + 4;
      const dataEnd = dataStart + dataSize;
      if (dataEnd > extraFieldLength) {
        throw new Error("extra field length exceeds extra field buffer size");
      }
      extraFields.push({
        id: headerId,
        offset: readEntryCursor + dataStart,
        length: dataSize,
      });
      i = dataEnd;
    }
    readEntryCursor += extraFieldLength;

    // 46+n+m - File comment
    const commentBytes = allEntriesBuffer.slice(
      readEntryCursor,
      (readEntryCursor += fileCommentLength),
    );

    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      relativeOffsetOfLocalHeader === 0xffffffff
    ) {
      // ZIP64 format
      // find the Zip64 Extended Information Extra Field
      const zip64ExtraField = extraFields.find((e) => e.id === 0x0001);
      if (zip64ExtraField === undefined) {
        throw new Error("expected zip64 extended information extra field");
      }
      const { offset: zip64EiefBufferOffset, length: zip64EiefBufferLength } =
        zip64ExtraField;
      let index = 0;
      // 0 - Original Size          8 bytes
      if (uncompressedSize === 0xffffffff) {
        if (index + 8 > zip64EiefBufferLength) {
          throw new Error(
            "zip64 extended information extra field does not include uncompressed size",
          );
        }
        uncompressedSize = Number(
          dv.getBigUint64(
            zip64EiefBufferOffset + index,
            /*littleEndian=*/ true,
          ),
        );
        index += 8;
      }
      // 8 - Compressed Size        8 bytes
      if (compressedSize === 0xffffffff) {
        if (index + 8 > zip64EiefBufferLength) {
          throw new Error(
            "zip64 extended information extra field does not include compressed size",
          );
        }
        compressedSize = Number(
          dv.getBigUint64(
            zip64EiefBufferOffset + index,
            /*littleEndian=*/ true,
          ),
        );
        index += 8;
      }
      // 16 - Relative Header Offset 8 bytes
      if (relativeOffsetOfLocalHeader === 0xffffffff) {
        if (index + 8 > zip64EiefBufferLength) {
          throw new Error(
            "zip64 extended information extra field does not include relative header offset",
          );
        }
        relativeOffsetOfLocalHeader = Number(
          dv.getBigUint64(
            zip64EiefBufferOffset + index,
            /*littleEndian=*/ true,
          ),
        );
        index += 8;
      }
      // 24 - Disk Start Number      4 bytes
    }

    // check for Info-ZIP Unicode Path Extra Field (0x7075)
    // see https://github.com/thejoshwolfe/yauzl/issues/33
    const nameField = extraFields.find(
      (e) =>
        e.id === 0x7075 &&
        e.length >= 6 && // too short to be meaningful
        allEntriesBuffer[e.offset] === 1 && // Version       1 byte      version of this extra field, currently 1
        dv.getInt32(e.offset + 1, /*littleEndian=*/ true) ===
          crc32buf(nameBytes),
    ); // NameCRC32     4 bytes     File Name Field CRC32 Checksum
    // > If the CRC check fails, this UTF-8 Path Extra Field should be
    // > ignored and the File Name field in the header should be used instead.
    if (nameField) {
      nameBytes = allEntriesBuffer.slice(
        nameField.offset + 5,
        nameField.offset + nameField.length,
      );
      isUTF8 = true;
    }

    // validate file size
    if (compressionMethod === 0) {
      let expectedCompressedSize = uncompressedSize;
      if ((generalPurposeBitFlag & 0x1) !== 0) {
        // traditional encryption prefixes the file data with a header
        expectedCompressedSize += 12;
      }
      if (compressedSize !== expectedCompressedSize) {
        throw new Error(
          `compressed/uncompressed size mismatch for stored file: ${compressedSize} != ${expectedCompressedSize}`,
        );
      }
    }

    // Just decode as UTF-8 regardless of `isUTF8`, because the non-UTF8
    // encoding is difficult/impossible to determine correctly.
    let fileName = textDecoder.decode(nameBytes);
    fileName = fileName.replaceAll("\\", "/");
    isUTF8;

    const rawEntry: ZipEntry = {
      versionMadeBy,
      versionNeededToExtract,
      generalPurposeBitFlag,
      compressionMethod,
      lastModFileTime,
      lastModFileDate,
      crc32,
      compressedSize,
      uncompressedSize,
      nameBytes,
      commentBytes,
      internalFileAttributes,
      externalFileAttributes,
      relativeOffsetOfLocalHeader,
      fileName,
    };
    rawEntries.push(rawEntry);
  }
  return {
    commentBytes,
    entries: rawEntries,
    // Estimate that the JavaScript representation consumes twice the memory of
    // the encoded representation.
    sizeEstimate: commentBytes.length + allEntriesBuffer.length * 2,
  };
}

export async function readEntryDataHeader(
  reader: Reader,
  rawEntry: ZipEntry,
  options: Partial<ProgressOptions>,
) {
  if (rawEntry.generalPurposeBitFlag & 0x1) {
    throw new Error("encrypted entries not supported");
  }
  const data = await reader(rawEntry.relativeOffsetOfLocalHeader, 30, options);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // 0 - Local file header signature = 0x04034b50
  const signature = dv.getUint32(0, /*littleEndian=*/ true);
  if (signature !== 0x04034b50) {
    throw new Error(
      `invalid local file header signature: 0x${signature.toString(16)}`,
    );
  }

  // all this should be redundant
  // 4 - Version needed to extract (minimum)
  // 6 - General purpose bit flag
  // 8 - Compression method
  // 10 - File last modification time
  // 12 - File last modification date
  // 14 - CRC-32
  // 18 - Compressed size
  // 22 - Uncompressed size
  // 26 - File name length (n)
  const fileNameLength = dv.getUint16(26, /*littleEndian=*/ true);
  // 28 - Extra field length (m)
  const extraFieldLength = dv.getUint16(28, /*littleEndian=*/ true);
  // 30 - File name
  // 30+n - Extra field
  const localFileHeaderEnd =
    rawEntry.relativeOffsetOfLocalHeader +
    data.length +
    fileNameLength +
    extraFieldLength;

  return localFileHeaderEnd;
}

export async function readZipMetadata(
  reader: Reader,
  totalLength: number,
  options: Partial<ProgressOptions>,
): Promise<ZipMetadata> {
  return await findEndOfCentralDirectory(
    lastReadCachingReader(reader),
    totalLength,
    options,
  );
}

export enum ZipCompressionMethod {
  STORE = 0,
  DEFLATE = 8,
}
