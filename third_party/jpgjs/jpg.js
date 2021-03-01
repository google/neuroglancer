/**
 * @license
 * Copyright 2015 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function loadURLasArrayBuffer(path, callback) {
    if (path.indexOf("data:") === 0) {
        var offset = path.indexOf("base64,") + 7;
        var data = atob(path.substring(offset));
        var arr = new Uint8Array(data.length);
        for (var i = data.length - 1; i >= 0; i--) {
            arr[i] = data.charCodeAt(i);
        }
        callback(arr.buffer);
        return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open("GET", path, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = function() {
        callback(xhr.response);
    };
    xhr.send(null);
}

var JpegImage = function jpegImage() {
    function JpegImage() {
        this._src = null;
        this._parser = new PDFJS.JpegImage();
        this.onload = null;
    }
    JpegImage.prototype = {
        get src() {
            return this._src;
        },
        set src(value) {
            this.load(value);
        },
        get width() {
            return this._parser.width;
        },
        get height() {
            return this._parser.height;
        },
        load: function load(path) {
            this._src = path;
            loadURLasArrayBuffer(path, function(buffer) {
                this.parse(new Uint8Array(buffer));
                if (this.onload) {
                    this.onload();
                }
            }.bind(this));
        },
        parse: function(data) {
            this._parser.parse(data);
        },
        getData: function(width, height) {
            return this._parser.getData(width, height, false);
        },
        copyToImageData: function copyToImageData(imageData) {
            if (this._parser.numComponents === 2 || this._parser.numComponents > 4) {
                throw new Error("Unsupported amount of components");
            }
            var width = imageData.width, height = imageData.height;
            var imageDataBytes = width * height * 4;
            var imageDataArray = imageData.data;
            var i, j;
            if (this._parser.numComponents === 1) {
                var values = this._parser.getData(width, height, false);
                for (i = 0, j = 0; i < imageDataBytes; ) {
                    var value = values[j++];
                    imageDataArray[i++] = value;
                    imageDataArray[i++] = value;
                    imageDataArray[i++] = value;
                    imageDataArray[i++] = 255;
                }
                return;
            }
            var rgb = this._parser.getData(width, height, true);
            for (i = 0, j = 0; i < imageDataBytes; ) {
                imageDataArray[i++] = rgb[j++];
                imageDataArray[i++] = rgb[j++];
                imageDataArray[i++] = rgb[j++];
                imageDataArray[i++] = 255;
            }
        }
    };
    return JpegImage;
}();

var PDFJS;

(function(PDFJS) {
    "use strict";
    var JpegImage = function jpegImage() {
        var dctZigZag = new Uint8Array([ 0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63 ]);
        var dctCos1 = 4017;
        var dctSin1 = 799;
        var dctCos3 = 3406;
        var dctSin3 = 2276;
        var dctCos6 = 1567;
        var dctSin6 = 3784;
        var dctSqrt2 = 5793;
        var dctSqrt1d2 = 2896;
        function constructor() {}
        function buildHuffmanTable(codeLengths, values) {
            var k = 0, code = [], i, j, length = 16;
            while (length > 0 && !codeLengths[length - 1]) {
                length--;
            }
            code.push({
                children: [],
                index: 0
            });
            var p = code[0], q;
            for (i = 0; i < length; i++) {
                for (j = 0; j < codeLengths[i]; j++) {
                    p = code.pop();
                    p.children[p.index] = values[k];
                    while (p.index > 0) {
                        p = code.pop();
                    }
                    p.index++;
                    code.push(p);
                    while (code.length <= i) {
                        code.push(q = {
                            children: [],
                            index: 0
                        });
                        p.children[p.index] = q.children;
                        p = q;
                    }
                    k++;
                }
                if (i + 1 < length) {
                    code.push(q = {
                        children: [],
                        index: 0
                    });
                    p.children[p.index] = q.children;
                    p = q;
                }
            }
            return code[0].children;
        }
        function getBlockBufferOffset(component, row, col) {
            return 64 * ((component.blocksPerLine + 1) * row + col);
        }
        function decodeScan(data, offset, frame, components, resetInterval, spectralStart, spectralEnd, successivePrev, successive) {
            var precision = frame.precision;
            var samplesPerLine = frame.samplesPerLine;
            var scanLines = frame.scanLines;
            var mcusPerLine = frame.mcusPerLine;
            var progressive = frame.progressive;
            var maxH = frame.maxH, maxV = frame.maxV;
            var startOffset = offset, bitsData = 0, bitsCount = 0;
            function readBit() {
                if (bitsCount > 0) {
                    bitsCount--;
                    return bitsData >> bitsCount & 1;
                }
                bitsData = data[offset++];
                if (bitsData === 255) {
                    var nextByte = data[offset++];
                    if (nextByte) {
                        throw "unexpected marker: " + (bitsData << 8 | nextByte).toString(16);
                    }
                }
                bitsCount = 7;
                return bitsData >>> 7;
            }
            function decodeHuffman(tree) {
                var node = tree;
                while (true) {
                    node = node[readBit()];
                    if (typeof node === "number") {
                        return node;
                    }
                    if (typeof node !== "object") {
                        throw "invalid huffman sequence";
                    }
                }
            }
            function receive(length) {
                var n = 0;
                while (length > 0) {
                    n = n << 1 | readBit();
                    length--;
                }
                return n;
            }
            function receiveAndExtend(length) {
                if (length === 1) {
                    return readBit() === 1 ? 1 : -1;
                }
                var n = receive(length);
                if (n >= 1 << length - 1) {
                    return n;
                }
                return n + (-1 << length) + 1;
            }
            function decodeBaseline(component, offset) {
                var t = decodeHuffman(component.huffmanTableDC);
                var diff = t === 0 ? 0 : receiveAndExtend(t);
                component.blockData[offset] = component.pred += diff;
                var k = 1;
                while (k < 64) {
                    var rs = decodeHuffman(component.huffmanTableAC);
                    var s = rs & 15, r = rs >> 4;
                    if (s === 0) {
                        if (r < 15) {
                            break;
                        }
                        k += 16;
                        continue;
                    }
                    k += r;
                    var z = dctZigZag[k];
                    component.blockData[offset + z] = receiveAndExtend(s);
                    k++;
                }
            }
            function decodeDCFirst(component, offset) {
                var t = decodeHuffman(component.huffmanTableDC);
                var diff = t === 0 ? 0 : receiveAndExtend(t) << successive;
                component.blockData[offset] = component.pred += diff;
            }
            function decodeDCSuccessive(component, offset) {
                component.blockData[offset] |= readBit() << successive;
            }
            var eobrun = 0;
            function decodeACFirst(component, offset) {
                if (eobrun > 0) {
                    eobrun--;
                    return;
                }
                var k = spectralStart, e = spectralEnd;
                while (k <= e) {
                    var rs = decodeHuffman(component.huffmanTableAC);
                    var s = rs & 15, r = rs >> 4;
                    if (s === 0) {
                        if (r < 15) {
                            eobrun = receive(r) + (1 << r) - 1;
                            break;
                        }
                        k += 16;
                        continue;
                    }
                    k += r;
                    var z = dctZigZag[k];
                    component.blockData[offset + z] = receiveAndExtend(s) * (1 << successive);
                    k++;
                }
            }
            var successiveACState = 0, successiveACNextValue;
            function decodeACSuccessive(component, offset) {
                var k = spectralStart;
                var e = spectralEnd;
                var r = 0;
                var s;
                var rs;
                while (k <= e) {
                    var z = dctZigZag[k];
                    switch (successiveACState) {
                      case 0:
                        rs = decodeHuffman(component.huffmanTableAC);
                        s = rs & 15;
                        r = rs >> 4;
                        if (s === 0) {
                            if (r < 15) {
                                eobrun = receive(r) + (1 << r);
                                successiveACState = 4;
                            } else {
                                r = 16;
                                successiveACState = 1;
                            }
                        } else {
                            if (s !== 1) {
                                throw "invalid ACn encoding";
                            }
                            successiveACNextValue = receiveAndExtend(s);
                            successiveACState = r ? 2 : 3;
                        }
                        continue;

                      case 1:
                      case 2:
                        if (component.blockData[offset + z]) {
                            component.blockData[offset + z] += readBit() << successive;
                        } else {
                            r--;
                            if (r === 0) {
                                successiveACState = successiveACState === 2 ? 3 : 0;
                            }
                        }
                        break;

                      case 3:
                        if (component.blockData[offset + z]) {
                            component.blockData[offset + z] += readBit() << successive;
                        } else {
                            component.blockData[offset + z] = successiveACNextValue << successive;
                            successiveACState = 0;
                        }
                        break;

                      case 4:
                        if (component.blockData[offset + z]) {
                            component.blockData[offset + z] += readBit() << successive;
                        }
                        break;
                    }
                    k++;
                }
                if (successiveACState === 4) {
                    eobrun--;
                    if (eobrun === 0) {
                        successiveACState = 0;
                    }
                }
            }
            function decodeMcu(component, decode, mcu, row, col) {
                var mcuRow = mcu / mcusPerLine | 0;
                var mcuCol = mcu % mcusPerLine;
                var blockRow = mcuRow * component.v + row;
                var blockCol = mcuCol * component.h + col;
                var offset = getBlockBufferOffset(component, blockRow, blockCol);
                decode(component, offset);
            }
            function decodeBlock(component, decode, mcu) {
                var blockRow = mcu / component.blocksPerLine | 0;
                var blockCol = mcu % component.blocksPerLine;
                var offset = getBlockBufferOffset(component, blockRow, blockCol);
                decode(component, offset);
            }
            var componentsLength = components.length;
            var component, i, j, k, n;
            var decodeFn;
            if (progressive) {
                if (spectralStart === 0) {
                    decodeFn = successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive;
                } else {
                    decodeFn = successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
                }
            } else {
                decodeFn = decodeBaseline;
            }
            var mcu = 0, marker;
            var mcuExpected;
            if (componentsLength === 1) {
                mcuExpected = components[0].blocksPerLine * components[0].blocksPerColumn;
            } else {
                mcuExpected = mcusPerLine * frame.mcusPerColumn;
            }
            if (!resetInterval) {
                resetInterval = mcuExpected;
            }
            var h, v;
            while (mcu < mcuExpected) {
                for (i = 0; i < componentsLength; i++) {
                    components[i].pred = 0;
                }
                eobrun = 0;
                if (componentsLength === 1) {
                    component = components[0];
                    for (n = 0; n < resetInterval; n++) {
                        decodeBlock(component, decodeFn, mcu);
                        mcu++;
                    }
                } else {
                    for (n = 0; n < resetInterval; n++) {
                        for (i = 0; i < componentsLength; i++) {
                            component = components[i];
                            h = component.h;
                            v = component.v;
                            for (j = 0; j < v; j++) {
                                for (k = 0; k < h; k++) {
                                    decodeMcu(component, decodeFn, mcu, j, k);
                                }
                            }
                        }
                        mcu++;
                    }
                }
                bitsCount = 0;
                marker = data[offset] << 8 | data[offset + 1];
                if (marker <= 65280) {
                    throw "marker was not found";
                }
                if (marker >= 65488 && marker <= 65495) {
                    offset += 2;
                } else {
                    break;
                }
            }
            return offset - startOffset;
        }
        function quantizeAndInverse(component, blockBufferOffset, p) {
            var qt = component.quantizationTable, blockData = component.blockData;
            var v0, v1, v2, v3, v4, v5, v6, v7;
            var p0, p1, p2, p3, p4, p5, p6, p7;
            var t;
            for (var row = 0; row < 64; row += 8) {
                p0 = blockData[blockBufferOffset + row];
                p1 = blockData[blockBufferOffset + row + 1];
                p2 = blockData[blockBufferOffset + row + 2];
                p3 = blockData[blockBufferOffset + row + 3];
                p4 = blockData[blockBufferOffset + row + 4];
                p5 = blockData[blockBufferOffset + row + 5];
                p6 = blockData[blockBufferOffset + row + 6];
                p7 = blockData[blockBufferOffset + row + 7];
                p0 *= qt[row];
                if ((p1 | p2 | p3 | p4 | p5 | p6 | p7) === 0) {
                    t = dctSqrt2 * p0 + 512 >> 10;
                    p[row] = t;
                    p[row + 1] = t;
                    p[row + 2] = t;
                    p[row + 3] = t;
                    p[row + 4] = t;
                    p[row + 5] = t;
                    p[row + 6] = t;
                    p[row + 7] = t;
                    continue;
                }
                p1 *= qt[row + 1];
                p2 *= qt[row + 2];
                p3 *= qt[row + 3];
                p4 *= qt[row + 4];
                p5 *= qt[row + 5];
                p6 *= qt[row + 6];
                p7 *= qt[row + 7];
                v0 = dctSqrt2 * p0 + 128 >> 8;
                v1 = dctSqrt2 * p4 + 128 >> 8;
                v2 = p2;
                v3 = p6;
                v4 = dctSqrt1d2 * (p1 - p7) + 128 >> 8;
                v7 = dctSqrt1d2 * (p1 + p7) + 128 >> 8;
                v5 = p3 << 4;
                v6 = p5 << 4;
                v0 = v0 + v1 + 1 >> 1;
                v1 = v0 - v1;
                t = v2 * dctSin6 + v3 * dctCos6 + 128 >> 8;
                v2 = v2 * dctCos6 - v3 * dctSin6 + 128 >> 8;
                v3 = t;
                v4 = v4 + v6 + 1 >> 1;
                v6 = v4 - v6;
                v7 = v7 + v5 + 1 >> 1;
                v5 = v7 - v5;
                v0 = v0 + v3 + 1 >> 1;
                v3 = v0 - v3;
                v1 = v1 + v2 + 1 >> 1;
                v2 = v1 - v2;
                t = v4 * dctSin3 + v7 * dctCos3 + 2048 >> 12;
                v4 = v4 * dctCos3 - v7 * dctSin3 + 2048 >> 12;
                v7 = t;
                t = v5 * dctSin1 + v6 * dctCos1 + 2048 >> 12;
                v5 = v5 * dctCos1 - v6 * dctSin1 + 2048 >> 12;
                v6 = t;
                p[row] = v0 + v7;
                p[row + 7] = v0 - v7;
                p[row + 1] = v1 + v6;
                p[row + 6] = v1 - v6;
                p[row + 2] = v2 + v5;
                p[row + 5] = v2 - v5;
                p[row + 3] = v3 + v4;
                p[row + 4] = v3 - v4;
            }
            for (var col = 0; col < 8; ++col) {
                p0 = p[col];
                p1 = p[col + 8];
                p2 = p[col + 16];
                p3 = p[col + 24];
                p4 = p[col + 32];
                p5 = p[col + 40];
                p6 = p[col + 48];
                p7 = p[col + 56];
                if ((p1 | p2 | p3 | p4 | p5 | p6 | p7) === 0) {
                    t = dctSqrt2 * p0 + 8192 >> 14;
                    t = t < -2040 ? 0 : t >= 2024 ? 255 : t + 2056 >> 4;
                    blockData[blockBufferOffset + col] = t;
                    blockData[blockBufferOffset + col + 8] = t;
                    blockData[blockBufferOffset + col + 16] = t;
                    blockData[blockBufferOffset + col + 24] = t;
                    blockData[blockBufferOffset + col + 32] = t;
                    blockData[blockBufferOffset + col + 40] = t;
                    blockData[blockBufferOffset + col + 48] = t;
                    blockData[blockBufferOffset + col + 56] = t;
                    continue;
                }
                v0 = dctSqrt2 * p0 + 2048 >> 12;
                v1 = dctSqrt2 * p4 + 2048 >> 12;
                v2 = p2;
                v3 = p6;
                v4 = dctSqrt1d2 * (p1 - p7) + 2048 >> 12;
                v7 = dctSqrt1d2 * (p1 + p7) + 2048 >> 12;
                v5 = p3;
                v6 = p5;
                v0 = (v0 + v1 + 1 >> 1) + 4112;
                v1 = v0 - v1;
                t = v2 * dctSin6 + v3 * dctCos6 + 2048 >> 12;
                v2 = v2 * dctCos6 - v3 * dctSin6 + 2048 >> 12;
                v3 = t;
                v4 = v4 + v6 + 1 >> 1;
                v6 = v4 - v6;
                v7 = v7 + v5 + 1 >> 1;
                v5 = v7 - v5;
                v0 = v0 + v3 + 1 >> 1;
                v3 = v0 - v3;
                v1 = v1 + v2 + 1 >> 1;
                v2 = v1 - v2;
                t = v4 * dctSin3 + v7 * dctCos3 + 2048 >> 12;
                v4 = v4 * dctCos3 - v7 * dctSin3 + 2048 >> 12;
                v7 = t;
                t = v5 * dctSin1 + v6 * dctCos1 + 2048 >> 12;
                v5 = v5 * dctCos1 - v6 * dctSin1 + 2048 >> 12;
                v6 = t;
                p0 = v0 + v7;
                p7 = v0 - v7;
                p1 = v1 + v6;
                p6 = v1 - v6;
                p2 = v2 + v5;
                p5 = v2 - v5;
                p3 = v3 + v4;
                p4 = v3 - v4;
                p0 = p0 < 16 ? 0 : p0 >= 4080 ? 255 : p0 >> 4;
                p1 = p1 < 16 ? 0 : p1 >= 4080 ? 255 : p1 >> 4;
                p2 = p2 < 16 ? 0 : p2 >= 4080 ? 255 : p2 >> 4;
                p3 = p3 < 16 ? 0 : p3 >= 4080 ? 255 : p3 >> 4;
                p4 = p4 < 16 ? 0 : p4 >= 4080 ? 255 : p4 >> 4;
                p5 = p5 < 16 ? 0 : p5 >= 4080 ? 255 : p5 >> 4;
                p6 = p6 < 16 ? 0 : p6 >= 4080 ? 255 : p6 >> 4;
                p7 = p7 < 16 ? 0 : p7 >= 4080 ? 255 : p7 >> 4;
                blockData[blockBufferOffset + col] = p0;
                blockData[blockBufferOffset + col + 8] = p1;
                blockData[blockBufferOffset + col + 16] = p2;
                blockData[blockBufferOffset + col + 24] = p3;
                blockData[blockBufferOffset + col + 32] = p4;
                blockData[blockBufferOffset + col + 40] = p5;
                blockData[blockBufferOffset + col + 48] = p6;
                blockData[blockBufferOffset + col + 56] = p7;
            }
        }
        function buildComponentData(frame, component) {
            var blocksPerLine = component.blocksPerLine;
            var blocksPerColumn = component.blocksPerColumn;
            var computationBuffer = new Int16Array(64);
            for (var blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
                for (var blockCol = 0; blockCol < blocksPerLine; blockCol++) {
                    var offset = getBlockBufferOffset(component, blockRow, blockCol);
                    quantizeAndInverse(component, offset, computationBuffer);
                }
            }
            return component.blockData;
        }
        function clamp0to255(a) {
            return a <= 0 ? 0 : a >= 255 ? 255 : a;
        }
        constructor.prototype = {
            parse: function parse(data) {
                function readUint16() {
                    var value = data[offset] << 8 | data[offset + 1];
                    offset += 2;
                    return value;
                }
                function readDataBlock() {
                    var length = readUint16();
                    var array = data.subarray(offset, offset + length - 2);
                    offset += array.length;
                    return array;
                }
                function prepareComponents(frame) {
                    var mcusPerLine = Math.ceil(frame.samplesPerLine / 8 / frame.maxH);
                    var mcusPerColumn = Math.ceil(frame.scanLines / 8 / frame.maxV);
                    for (var i = 0; i < frame.components.length; i++) {
                        component = frame.components[i];
                        var blocksPerLine = Math.ceil(Math.ceil(frame.samplesPerLine / 8) * component.h / frame.maxH);
                        var blocksPerColumn = Math.ceil(Math.ceil(frame.scanLines / 8) * component.v / frame.maxV);
                        var blocksPerLineForMcu = mcusPerLine * component.h;
                        var blocksPerColumnForMcu = mcusPerColumn * component.v;
                        var blocksBufferSize = 64 * blocksPerColumnForMcu * (blocksPerLineForMcu + 1);
                        component.blockData = new Int16Array(blocksBufferSize);
                        component.blocksPerLine = blocksPerLine;
                        component.blocksPerColumn = blocksPerColumn;
                    }
                    frame.mcusPerLine = mcusPerLine;
                    frame.mcusPerColumn = mcusPerColumn;
                }
                var offset = 0, length = data.length;
                var jfif = null;
                var adobe = null;
                var pixels = null;
                var frame, resetInterval;
                var quantizationTables = [];
                var huffmanTablesAC = [], huffmanTablesDC = [];
                var fileMarker = readUint16();
                if (fileMarker !== 65496) {
                    throw "SOI not found";
                }
                fileMarker = readUint16();
                while (fileMarker !== 65497) {
                    var i, j, l;
                    switch (fileMarker) {
                      case 65504:
                      case 65505:
                      case 65506:
                      case 65507:
                      case 65508:
                      case 65509:
                      case 65510:
                      case 65511:
                      case 65512:
                      case 65513:
                      case 65514:
                      case 65515:
                      case 65516:
                      case 65517:
                      case 65518:
                      case 65519:
                      case 65534:
                        var appData = readDataBlock();
                        if (fileMarker === 65504) {
                            if (appData[0] === 74 && appData[1] === 70 && appData[2] === 73 && appData[3] === 70 && appData[4] === 0) {
                                jfif = {
                                    version: {
                                        major: appData[5],
                                        minor: appData[6]
                                    },
                                    densityUnits: appData[7],
                                    xDensity: appData[8] << 8 | appData[9],
                                    yDensity: appData[10] << 8 | appData[11],
                                    thumbWidth: appData[12],
                                    thumbHeight: appData[13],
                                    thumbData: appData.subarray(14, 14 + 3 * appData[12] * appData[13])
                                };
                            }
                        }
                        if (fileMarker === 65518) {
                            if (appData[0] === 65 && appData[1] === 100 && appData[2] === 111 && appData[3] === 98 && appData[4] === 101 && appData[5] === 0) {
                                adobe = {
                                    version: appData[6],
                                    flags0: appData[7] << 8 | appData[8],
                                    flags1: appData[9] << 8 | appData[10],
                                    transformCode: appData[11]
                                };
                            }
                        }
                        break;

                      case 65499:
                        var quantizationTablesLength = readUint16();
                        var quantizationTablesEnd = quantizationTablesLength + offset - 2;
                        var z;
                        while (offset < quantizationTablesEnd) {
                            var quantizationTableSpec = data[offset++];
                            var tableData = new Uint16Array(64);
                            if (quantizationTableSpec >> 4 === 0) {
                                for (j = 0; j < 64; j++) {
                                    z = dctZigZag[j];
                                    tableData[z] = data[offset++];
                                }
                            } else if (quantizationTableSpec >> 4 === 1) {
                                for (j = 0; j < 64; j++) {
                                    z = dctZigZag[j];
                                    tableData[z] = readUint16();
                                }
                            } else {
                                throw "DQT: invalid table spec";
                            }
                            quantizationTables[quantizationTableSpec & 15] = tableData;
                        }
                        break;

                      case 65472:
                      case 65473:
                      case 65474:
                        if (frame) {
                            throw "Only single frame JPEGs supported";
                        }
                        readUint16();
                        frame = {};
                        frame.extended = fileMarker === 65473;
                        frame.progressive = fileMarker === 65474;
                        frame.precision = data[offset++];
                        frame.scanLines = readUint16();
                        frame.samplesPerLine = readUint16();
                        frame.components = [];
                        frame.componentIds = {};
                        var componentsCount = data[offset++], componentId;
                        var maxH = 0, maxV = 0;
                        for (i = 0; i < componentsCount; i++) {
                            componentId = data[offset];
                            var h = data[offset + 1] >> 4;
                            var v = data[offset + 1] & 15;
                            if (maxH < h) {
                                maxH = h;
                            }
                            if (maxV < v) {
                                maxV = v;
                            }
                            var qId = data[offset + 2];
                            l = frame.components.push({
                                h: h,
                                v: v,
                                quantizationTable: quantizationTables[qId]
                            });
                            frame.componentIds[componentId] = l - 1;
                            offset += 3;
                        }
                        frame.maxH = maxH;
                        frame.maxV = maxV;
                        prepareComponents(frame);
                        break;

                      case 65476:
                        var huffmanLength = readUint16();
                        for (i = 2; i < huffmanLength; ) {
                            var huffmanTableSpec = data[offset++];
                            var codeLengths = new Uint8Array(16);
                            var codeLengthSum = 0;
                            for (j = 0; j < 16; j++, offset++) {
                                codeLengthSum += codeLengths[j] = data[offset];
                            }
                            var huffmanValues = new Uint8Array(codeLengthSum);
                            for (j = 0; j < codeLengthSum; j++, offset++) {
                                huffmanValues[j] = data[offset];
                            }
                            i += 17 + codeLengthSum;
                            (huffmanTableSpec >> 4 === 0 ? huffmanTablesDC : huffmanTablesAC)[huffmanTableSpec & 15] = buildHuffmanTable(codeLengths, huffmanValues);
                        }
                        break;

                      case 65501:
                        readUint16();
                        resetInterval = readUint16();
                        break;

                      case 65498:
                        var scanLength = readUint16();
                        var selectorsCount = data[offset++];
                        var components = [], component;
                        for (i = 0; i < selectorsCount; i++) {
                            var componentIndex = frame.componentIds[data[offset++]];
                            component = frame.components[componentIndex];
                            var tableSpec = data[offset++];
                            component.huffmanTableDC = huffmanTablesDC[tableSpec >> 4];
                            component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
                            components.push(component);
                        }
                        var spectralStart = data[offset++];
                        var spectralEnd = data[offset++];
                        var successiveApproximation = data[offset++];
                        var processed = decodeScan(data, offset, frame, components, resetInterval, spectralStart, spectralEnd, successiveApproximation >> 4, successiveApproximation & 15);
                        offset += processed;
                        break;

                      case 65535:
                        if (data[offset] !== 255) {
                            offset--;
                        }
                        break;

                      default:
                        if (data[offset - 3] === 255 && data[offset - 2] >= 192 && data[offset - 2] <= 254) {
                            offset -= 3;
                            break;
                        }
                        throw "unknown JPEG marker " + fileMarker.toString(16);
                    }
                    fileMarker = readUint16();
                }
                this.width = frame.samplesPerLine;
                this.height = frame.scanLines;
                this.jfif = jfif;
                this.adobe = adobe;
                this.components = [];
                for (i = 0; i < frame.components.length; i++) {
                    component = frame.components[i];
                    this.components.push({
                        output: buildComponentData(frame, component),
                        scaleX: component.h / frame.maxH,
                        scaleY: component.v / frame.maxV,
                        blocksPerLine: component.blocksPerLine,
                        blocksPerColumn: component.blocksPerColumn
                    });
                }
                this.numComponents = this.components.length;
            },
            _getLinearizedBlockData: function getLinearizedBlockData(width, height) {
                var scaleX = this.width / width, scaleY = this.height / height;
                var component, componentScaleX, componentScaleY, blocksPerScanline;
                var x, y, i, j, k;
                var index;
                var offset = 0;
                var output;
                var numComponents = this.components.length;
                var dataLength = width * height * numComponents;
                var data = new Uint8Array(dataLength);
                var xScaleBlockOffset = new Uint32Array(width);
                var mask3LSB = 4294967288;
                for (i = 0; i < numComponents; i++) {
                    component = this.components[i];
                    componentScaleX = component.scaleX * scaleX;
                    componentScaleY = component.scaleY * scaleY;
                    offset = i;
                    output = component.output;
                    blocksPerScanline = component.blocksPerLine + 1 << 3;
                    for (x = 0; x < width; x++) {
                        j = 0 | x * componentScaleX;
                        xScaleBlockOffset[x] = (j & mask3LSB) << 3 | j & 7;
                    }
                    for (y = 0; y < height; y++) {
                        j = 0 | y * componentScaleY;
                        index = blocksPerScanline * (j & mask3LSB) | (j & 7) << 3;
                        for (x = 0; x < width; x++) {
                            data[offset] = output[index + xScaleBlockOffset[x]];
                            offset += numComponents;
                        }
                    }
                }
                var transform = this.decodeTransform;
                if (transform) {
                    for (i = 0; i < dataLength; ) {
                        for (j = 0, k = 0; j < numComponents; j++, i++, k += 2) {
                            data[i] = (data[i] * transform[k] >> 8) + transform[k + 1];
                        }
                    }
                }
                return data;
            },
            _isColorConversionNeeded: function isColorConversionNeeded() {
                if (this.adobe && this.adobe.transformCode) {
                    return true;
                } else if (this.numComponents === 3) {
                    return true;
                } else {
                    return false;
                }
            },
            _convertYccToRgb: function convertYccToRgb(data) {
                var Y, Cb, Cr;
                for (var i = 0, length = data.length; i < length; i += 3) {
                    Y = data[i];
                    Cb = data[i + 1];
                    Cr = data[i + 2];
                    data[i] = clamp0to255(Y - 179.456 + 1.402 * Cr);
                    data[i + 1] = clamp0to255(Y + 135.459 - .344 * Cb - .714 * Cr);
                    data[i + 2] = clamp0to255(Y - 226.816 + 1.772 * Cb);
                }
                return data;
            },
            _convertYcckToRgb: function convertYcckToRgb(data) {
                var Y, Cb, Cr, k;
                var offset = 0;
                for (var i = 0, length = data.length; i < length; i += 4) {
                    Y = data[i];
                    Cb = data[i + 1];
                    Cr = data[i + 2];
                    k = data[i + 3];
                    var r = -122.67195406894 + Cb * (-660635669420364e-19 * Cb + .000437130475926232 * Cr - 54080610064599e-18 * Y + .00048449797120281 * k - .154362151871126) + Cr * (-.000957964378445773 * Cr + .000817076911346625 * Y - .00477271405408747 * k + 1.53380253221734) + Y * (.000961250184130688 * Y - .00266257332283933 * k + .48357088451265) + k * (-.000336197177618394 * k + .484791561490776);
                    var g = 107.268039397724 + Cb * (219927104525741e-19 * Cb - .000640992018297945 * Cr + .000659397001245577 * Y + .000426105652938837 * k - .176491792462875) + Cr * (-.000778269941513683 * Cr + .00130872261408275 * Y + .000770482631801132 * k - .151051492775562) + Y * (.00126935368114843 * Y - .00265090189010898 * k + .25802910206845) + k * (-.000318913117588328 * k - .213742400323665);
                    var b = -20.810012546947 + Cb * (-.000570115196973677 * Cb - 263409051004589e-19 * Cr + .0020741088115012 * Y - .00288260236853442 * k + .814272968359295) + Cr * (-153496057440975e-19 * Cr - .000132689043961446 * Y + .000560833691242812 * k - .195152027534049) + Y * (.00174418132927582 * Y - .00255243321439347 * k + .116935020465145) + k * (-.000343531996510555 * k + .24165260232407);
                    data[offset++] = clamp0to255(r);
                    data[offset++] = clamp0to255(g);
                    data[offset++] = clamp0to255(b);
                }
                return data;
            },
            _convertYcckToCmyk: function convertYcckToCmyk(data) {
                var Y, Cb, Cr;
                for (var i = 0, length = data.length; i < length; i += 4) {
                    Y = data[i];
                    Cb = data[i + 1];
                    Cr = data[i + 2];
                    data[i] = clamp0to255(434.456 - Y - 1.402 * Cr);
                    data[i + 1] = clamp0to255(119.541 - Y + .344 * Cb + .714 * Cr);
                    data[i + 2] = clamp0to255(481.816 - Y - 1.772 * Cb);
                }
                return data;
            },
            _convertCmykToRgb: function convertCmykToRgb(data) {
                var c, m, y, k;
                var offset = 0;
                var min = -255 * 255 * 255;
                var scale = 1 / 255 / 255;
                for (var i = 0, length = data.length; i < length; i += 4) {
                    c = data[i];
                    m = data[i + 1];
                    y = data[i + 2];
                    k = data[i + 3];
                    var r = c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k - 72734.4411664936) + m * (1.7149763477362134 * m - 5.6096736904047315 * y - 17.873870861415444 * k - 1401.7366389350734) + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 4465.541406466231) - k * (21.86122147463605 * k + 48317.86113160301);
                    var g = c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k - 20220.756542821975) + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 48691.05921601825) + y * (4.444339102852739 * y + 9.8632861493405 * k - 6341.191035517494) - k * (20.737325471181034 * k + 47890.15695978492);
                    var b = c * (.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - .23883238689178934 * k - 3616.812083916688) + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 28620.90484698408) + y * (.03296041114873217 * y + 115.60384449646641 * k - 49363.43385999684) - k * (22.33816807309886 * k + 45932.16563550634);
                    data[offset++] = r >= 0 ? 255 : r <= min ? 0 : 255 + r * scale | 0;
                    data[offset++] = g >= 0 ? 255 : g <= min ? 0 : 255 + g * scale | 0;
                    data[offset++] = b >= 0 ? 255 : b <= min ? 0 : 255 + b * scale | 0;
                }
                return data;
            },
            getData: function getData(width, height, forceRGBoutput) {
                if (this.numComponents > 4) {
                    throw "Unsupported color mode";
                }
                var data = this._getLinearizedBlockData(width, height);
                if (this.numComponents === 3) {
                    return this._convertYccToRgb(data);
                } else if (this.numComponents === 4) {
                    if (this._isColorConversionNeeded()) {
                        if (forceRGBoutput) {
                            return this._convertYcckToRgb(data);
                        } else {
                            return this._convertYcckToCmyk(data);
                        }
                    } else if (forceRGBoutput) {
                        return this._convertCmykToRgb(data);
                    }
                }
                return data;
            }
        };
        return constructor;
    }();
    "use strict";
    var ArithmeticDecoder = function ArithmeticDecoderClosure() {
        var QeTable = [ {
            qe: 22017,
            nmps: 1,
            nlps: 1,
            switchFlag: 1
        }, {
            qe: 13313,
            nmps: 2,
            nlps: 6,
            switchFlag: 0
        }, {
            qe: 6145,
            nmps: 3,
            nlps: 9,
            switchFlag: 0
        }, {
            qe: 2753,
            nmps: 4,
            nlps: 12,
            switchFlag: 0
        }, {
            qe: 1313,
            nmps: 5,
            nlps: 29,
            switchFlag: 0
        }, {
            qe: 545,
            nmps: 38,
            nlps: 33,
            switchFlag: 0
        }, {
            qe: 22017,
            nmps: 7,
            nlps: 6,
            switchFlag: 1
        }, {
            qe: 21505,
            nmps: 8,
            nlps: 14,
            switchFlag: 0
        }, {
            qe: 18433,
            nmps: 9,
            nlps: 14,
            switchFlag: 0
        }, {
            qe: 14337,
            nmps: 10,
            nlps: 14,
            switchFlag: 0
        }, {
            qe: 12289,
            nmps: 11,
            nlps: 17,
            switchFlag: 0
        }, {
            qe: 9217,
            nmps: 12,
            nlps: 18,
            switchFlag: 0
        }, {
            qe: 7169,
            nmps: 13,
            nlps: 20,
            switchFlag: 0
        }, {
            qe: 5633,
            nmps: 29,
            nlps: 21,
            switchFlag: 0
        }, {
            qe: 22017,
            nmps: 15,
            nlps: 14,
            switchFlag: 1
        }, {
            qe: 21505,
            nmps: 16,
            nlps: 14,
            switchFlag: 0
        }, {
            qe: 20737,
            nmps: 17,
            nlps: 15,
            switchFlag: 0
        }, {
            qe: 18433,
            nmps: 18,
            nlps: 16,
            switchFlag: 0
        }, {
            qe: 14337,
            nmps: 19,
            nlps: 17,
            switchFlag: 0
        }, {
            qe: 13313,
            nmps: 20,
            nlps: 18,
            switchFlag: 0
        }, {
            qe: 12289,
            nmps: 21,
            nlps: 19,
            switchFlag: 0
        }, {
            qe: 10241,
            nmps: 22,
            nlps: 19,
            switchFlag: 0
        }, {
            qe: 9217,
            nmps: 23,
            nlps: 20,
            switchFlag: 0
        }, {
            qe: 8705,
            nmps: 24,
            nlps: 21,
            switchFlag: 0
        }, {
            qe: 7169,
            nmps: 25,
            nlps: 22,
            switchFlag: 0
        }, {
            qe: 6145,
            nmps: 26,
            nlps: 23,
            switchFlag: 0
        }, {
            qe: 5633,
            nmps: 27,
            nlps: 24,
            switchFlag: 0
        }, {
            qe: 5121,
            nmps: 28,
            nlps: 25,
            switchFlag: 0
        }, {
            qe: 4609,
            nmps: 29,
            nlps: 26,
            switchFlag: 0
        }, {
            qe: 4353,
            nmps: 30,
            nlps: 27,
            switchFlag: 0
        }, {
            qe: 2753,
            nmps: 31,
            nlps: 28,
            switchFlag: 0
        }, {
            qe: 2497,
            nmps: 32,
            nlps: 29,
            switchFlag: 0
        }, {
            qe: 2209,
            nmps: 33,
            nlps: 30,
            switchFlag: 0
        }, {
            qe: 1313,
            nmps: 34,
            nlps: 31,
            switchFlag: 0
        }, {
            qe: 1089,
            nmps: 35,
            nlps: 32,
            switchFlag: 0
        }, {
            qe: 673,
            nmps: 36,
            nlps: 33,
            switchFlag: 0
        }, {
            qe: 545,
            nmps: 37,
            nlps: 34,
            switchFlag: 0
        }, {
            qe: 321,
            nmps: 38,
            nlps: 35,
            switchFlag: 0
        }, {
            qe: 273,
            nmps: 39,
            nlps: 36,
            switchFlag: 0
        }, {
            qe: 133,
            nmps: 40,
            nlps: 37,
            switchFlag: 0
        }, {
            qe: 73,
            nmps: 41,
            nlps: 38,
            switchFlag: 0
        }, {
            qe: 37,
            nmps: 42,
            nlps: 39,
            switchFlag: 0
        }, {
            qe: 21,
            nmps: 43,
            nlps: 40,
            switchFlag: 0
        }, {
            qe: 9,
            nmps: 44,
            nlps: 41,
            switchFlag: 0
        }, {
            qe: 5,
            nmps: 45,
            nlps: 42,
            switchFlag: 0
        }, {
            qe: 1,
            nmps: 45,
            nlps: 43,
            switchFlag: 0
        }, {
            qe: 22017,
            nmps: 46,
            nlps: 46,
            switchFlag: 0
        } ];
        function ArithmeticDecoder(data, start, end) {
            this.data = data;
            this.bp = start;
            this.dataEnd = end;
            this.chigh = data[start];
            this.clow = 0;
            this.byteIn();
            this.chigh = this.chigh << 7 & 65535 | this.clow >> 9 & 127;
            this.clow = this.clow << 7 & 65535;
            this.ct -= 7;
            this.a = 32768;
        }
        ArithmeticDecoder.prototype = {
            byteIn: function ArithmeticDecoder_byteIn() {
                var data = this.data;
                var bp = this.bp;
                if (data[bp] === 255) {
                    var b1 = data[bp + 1];
                    if (b1 > 143) {
                        this.clow += 65280;
                        this.ct = 8;
                    } else {
                        bp++;
                        this.clow += data[bp] << 9;
                        this.ct = 7;
                        this.bp = bp;
                    }
                } else {
                    bp++;
                    this.clow += bp < this.dataEnd ? data[bp] << 8 : 65280;
                    this.ct = 8;
                    this.bp = bp;
                }
                if (this.clow > 65535) {
                    this.chigh += this.clow >> 16;
                    this.clow &= 65535;
                }
            },
            readBit: function ArithmeticDecoder_readBit(contexts, pos) {
                var cx_index = contexts[pos] >> 1, cx_mps = contexts[pos] & 1;
                var qeTableIcx = QeTable[cx_index];
                var qeIcx = qeTableIcx.qe;
                var d;
                var a = this.a - qeIcx;
                if (this.chigh < qeIcx) {
                    if (a < qeIcx) {
                        a = qeIcx;
                        d = cx_mps;
                        cx_index = qeTableIcx.nmps;
                    } else {
                        a = qeIcx;
                        d = 1 ^ cx_mps;
                        if (qeTableIcx.switchFlag === 1) {
                            cx_mps = d;
                        }
                        cx_index = qeTableIcx.nlps;
                    }
                } else {
                    this.chigh -= qeIcx;
                    if ((a & 32768) !== 0) {
                        this.a = a;
                        return cx_mps;
                    }
                    if (a < qeIcx) {
                        d = 1 ^ cx_mps;
                        if (qeTableIcx.switchFlag === 1) {
                            cx_mps = d;
                        }
                        cx_index = qeTableIcx.nlps;
                    } else {
                        d = cx_mps;
                        cx_index = qeTableIcx.nmps;
                    }
                }
                do {
                    if (this.ct === 0) {
                        this.byteIn();
                    }
                    a <<= 1;
                    this.chigh = this.chigh << 1 & 65535 | this.clow >> 15 & 1;
                    this.clow = this.clow << 1 & 65535;
                    this.ct--;
                } while ((a & 32768) === 0);
                this.a = a;
                contexts[pos] = cx_index << 1 | cx_mps;
                return d;
            }
        };
        return ArithmeticDecoder;
    }();
    "use strict";
    var JpxImage = function JpxImageClosure() {
        var SubbandsGainLog2 = {
            LL: 0,
            LH: 1,
            HL: 1,
            HH: 2
        };
        function JpxImage() {
            this.failOnCorruptedImage = false;
        }
        JpxImage.prototype = {
            parse: function JpxImage_parse(data) {
                var head = readUint16(data, 0);
                if (head === 65359) {
                    this.parseCodestream(data, 0, data.length);
                    return;
                }
                var position = 0, length = data.length;
                while (position < length) {
                    var headerSize = 8;
                    var lbox = readUint32(data, position);
                    var tbox = readUint32(data, position + 4);
                    position += headerSize;
                    if (lbox === 1) {
                        lbox = readUint32(data, position) * 4294967296 + readUint32(data, position + 4);
                        position += 8;
                        headerSize += 8;
                    }
                    if (lbox === 0) {
                        lbox = length - position + headerSize;
                    }
                    if (lbox < headerSize) {
                        throw new Error("JPX Error: Invalid box field size");
                    }
                    var dataLength = lbox - headerSize;
                    var jumpDataLength = true;
                    switch (tbox) {
                      case 1785737832:
                        jumpDataLength = false;
                        break;

                      case 1668246642:
                        var method = data[position];
                        var precedence = data[position + 1];
                        var approximation = data[position + 2];
                        if (method === 1) {
                            var colorspace = readUint32(data, position + 3);
                            switch (colorspace) {
                              case 16:
                              case 17:
                              case 18:
                                break;

                              default:
                                warn("Unknown colorspace " + colorspace);
                                break;
                            }
                        } else if (method === 2) {
                            info("ICC profile not supported");
                        }
                        break;

                      case 1785737827:
                        this.parseCodestream(data, position, position + dataLength);
                        break;

                      case 1783636e3:
                        if (218793738 !== readUint32(data, position)) {
                            warn("Invalid JP2 signature");
                        }
                        break;

                      case 1783634458:
                      case 1718909296:
                      case 1920099697:
                      case 1919251232:
                      case 1768449138:
                        break;

                      default:
                        var headerType = String.fromCharCode(tbox >> 24 & 255, tbox >> 16 & 255, tbox >> 8 & 255, tbox & 255);
                        warn("Unsupported header type " + tbox + " (" + headerType + ")");
                        break;
                    }
                    if (jumpDataLength) {
                        position += dataLength;
                    }
                }
            },
            parseImageProperties: function JpxImage_parseImageProperties(stream) {
                var newByte = stream.getByte();
                while (newByte >= 0) {
                    var oldByte = newByte;
                    newByte = stream.getByte();
                    var code = oldByte << 8 | newByte;
                    if (code === 65361) {
                        stream.skip(4);
                        var Xsiz = stream.getInt32() >>> 0;
                        var Ysiz = stream.getInt32() >>> 0;
                        var XOsiz = stream.getInt32() >>> 0;
                        var YOsiz = stream.getInt32() >>> 0;
                        stream.skip(16);
                        var Csiz = stream.getUint16();
                        this.width = Xsiz - XOsiz;
                        this.height = Ysiz - YOsiz;
                        this.componentsCount = Csiz;
                        this.bitsPerComponent = 8;
                        return;
                    }
                }
                throw new Error("JPX Error: No size marker found in JPX stream");
            },
            parseCodestream: function JpxImage_parseCodestream(data, start, end) {
                var context = {};
                try {
                    var doNotRecover = false;
                    var position = start;
                    while (position + 1 < end) {
                        var code = readUint16(data, position);
                        position += 2;
                        var length = 0, j, sqcd, spqcds, spqcdSize, scalarExpounded, tile;
                        switch (code) {
                          case 65359:
                            context.mainHeader = true;
                            break;

                          case 65497:
                            break;

                          case 65361:
                            length = readUint16(data, position);
                            var siz = {};
                            siz.Xsiz = readUint32(data, position + 4);
                            siz.Ysiz = readUint32(data, position + 8);
                            siz.XOsiz = readUint32(data, position + 12);
                            siz.YOsiz = readUint32(data, position + 16);
                            siz.XTsiz = readUint32(data, position + 20);
                            siz.YTsiz = readUint32(data, position + 24);
                            siz.XTOsiz = readUint32(data, position + 28);
                            siz.YTOsiz = readUint32(data, position + 32);
                            var componentsCount = readUint16(data, position + 36);
                            siz.Csiz = componentsCount;
                            var components = [];
                            j = position + 38;
                            for (var i = 0; i < componentsCount; i++) {
                                var component = {
                                    precision: (data[j] & 127) + 1,
                                    isSigned: !!(data[j] & 128),
                                    XRsiz: data[j + 1],
                                    YRsiz: data[j + 1]
                                };
                                calculateComponentDimensions(component, siz);
                                components.push(component);
                            }
                            context.SIZ = siz;
                            context.components = components;
                            calculateTileGrids(context, components);
                            context.QCC = [];
                            context.COC = [];
                            break;

                          case 65372:
                            length = readUint16(data, position);
                            var qcd = {};
                            j = position + 2;
                            sqcd = data[j++];
                            switch (sqcd & 31) {
                              case 0:
                                spqcdSize = 8;
                                scalarExpounded = true;
                                break;

                              case 1:
                                spqcdSize = 16;
                                scalarExpounded = false;
                                break;

                              case 2:
                                spqcdSize = 16;
                                scalarExpounded = true;
                                break;

                              default:
                                throw new Error("JPX Error: Invalid SQcd value " + sqcd);
                            }
                            qcd.noQuantization = spqcdSize === 8;
                            qcd.scalarExpounded = scalarExpounded;
                            qcd.guardBits = sqcd >> 5;
                            spqcds = [];
                            while (j < length + position) {
                                var spqcd = {};
                                if (spqcdSize === 8) {
                                    spqcd.epsilon = data[j++] >> 3;
                                    spqcd.mu = 0;
                                } else {
                                    spqcd.epsilon = data[j] >> 3;
                                    spqcd.mu = (data[j] & 7) << 8 | data[j + 1];
                                    j += 2;
                                }
                                spqcds.push(spqcd);
                            }
                            qcd.SPqcds = spqcds;
                            if (context.mainHeader) {
                                context.QCD = qcd;
                            } else {
                                context.currentTile.QCD = qcd;
                                context.currentTile.QCC = [];
                            }
                            break;

                          case 65373:
                            length = readUint16(data, position);
                            var qcc = {};
                            j = position + 2;
                            var cqcc;
                            if (context.SIZ.Csiz < 257) {
                                cqcc = data[j++];
                            } else {
                                cqcc = readUint16(data, j);
                                j += 2;
                            }
                            sqcd = data[j++];
                            switch (sqcd & 31) {
                              case 0:
                                spqcdSize = 8;
                                scalarExpounded = true;
                                break;

                              case 1:
                                spqcdSize = 16;
                                scalarExpounded = false;
                                break;

                              case 2:
                                spqcdSize = 16;
                                scalarExpounded = true;
                                break;

                              default:
                                throw new Error("JPX Error: Invalid SQcd value " + sqcd);
                            }
                            qcc.noQuantization = spqcdSize === 8;
                            qcc.scalarExpounded = scalarExpounded;
                            qcc.guardBits = sqcd >> 5;
                            spqcds = [];
                            while (j < length + position) {
                                spqcd = {};
                                if (spqcdSize === 8) {
                                    spqcd.epsilon = data[j++] >> 3;
                                    spqcd.mu = 0;
                                } else {
                                    spqcd.epsilon = data[j] >> 3;
                                    spqcd.mu = (data[j] & 7) << 8 | data[j + 1];
                                    j += 2;
                                }
                                spqcds.push(spqcd);
                            }
                            qcc.SPqcds = spqcds;
                            if (context.mainHeader) {
                                context.QCC[cqcc] = qcc;
                            } else {
                                context.currentTile.QCC[cqcc] = qcc;
                            }
                            break;

                          case 65362:
                            length = readUint16(data, position);
                            var cod = {};
                            j = position + 2;
                            var scod = data[j++];
                            cod.entropyCoderWithCustomPrecincts = !!(scod & 1);
                            cod.sopMarkerUsed = !!(scod & 2);
                            cod.ephMarkerUsed = !!(scod & 4);
                            cod.progressionOrder = data[j++];
                            cod.layersCount = readUint16(data, j);
                            j += 2;
                            cod.multipleComponentTransform = data[j++];
                            cod.decompositionLevelsCount = data[j++];
                            cod.xcb = (data[j++] & 15) + 2;
                            cod.ycb = (data[j++] & 15) + 2;
                            var blockStyle = data[j++];
                            cod.selectiveArithmeticCodingBypass = !!(blockStyle & 1);
                            cod.resetContextProbabilities = !!(blockStyle & 2);
                            cod.terminationOnEachCodingPass = !!(blockStyle & 4);
                            cod.verticalyStripe = !!(blockStyle & 8);
                            cod.predictableTermination = !!(blockStyle & 16);
                            cod.segmentationSymbolUsed = !!(blockStyle & 32);
                            cod.reversibleTransformation = data[j++];
                            if (cod.entropyCoderWithCustomPrecincts) {
                                var precinctsSizes = [];
                                while (j < length + position) {
                                    var precinctsSize = data[j++];
                                    precinctsSizes.push({
                                        PPx: precinctsSize & 15,
                                        PPy: precinctsSize >> 4
                                    });
                                }
                                cod.precinctsSizes = precinctsSizes;
                            }
                            var unsupported = [];
                            if (cod.selectiveArithmeticCodingBypass) {
                                unsupported.push("selectiveArithmeticCodingBypass");
                            }
                            if (cod.resetContextProbabilities) {
                                unsupported.push("resetContextProbabilities");
                            }
                            if (cod.terminationOnEachCodingPass) {
                                unsupported.push("terminationOnEachCodingPass");
                            }
                            if (cod.verticalyStripe) {
                                unsupported.push("verticalyStripe");
                            }
                            if (cod.predictableTermination) {
                                unsupported.push("predictableTermination");
                            }
                            if (unsupported.length > 0) {
                                doNotRecover = true;
                                throw new Error("JPX Error: Unsupported COD options (" + unsupported.join(", ") + ")");
                            }
                            if (context.mainHeader) {
                                context.COD = cod;
                            } else {
                                context.currentTile.COD = cod;
                                context.currentTile.COC = [];
                            }
                            break;

                          case 65424:
                            length = readUint16(data, position);
                            tile = {};
                            tile.index = readUint16(data, position + 2);
                            tile.length = readUint32(data, position + 4);
                            tile.dataEnd = tile.length + position - 2;
                            tile.partIndex = data[position + 8];
                            tile.partsCount = data[position + 9];
                            context.mainHeader = false;
                            if (tile.partIndex === 0) {
                                tile.COD = context.COD;
                                tile.COC = context.COC.slice(0);
                                tile.QCD = context.QCD;
                                tile.QCC = context.QCC.slice(0);
                            }
                            context.currentTile = tile;
                            break;

                          case 65427:
                            tile = context.currentTile;
                            if (tile.partIndex === 0) {
                                initializeTile(context, tile.index);
                                buildPackets(context);
                            }
                            length = tile.dataEnd - position;
                            parseTilePackets(context, data, position, length);
                            break;

                          case 65365:
                          case 65367:
                          case 65368:
                          case 65380:
                            length = readUint16(data, position);
                            break;

                          case 65363:
                            throw new Error("JPX Error: Codestream code 0xFF53 (COC) is " + "not implemented");

                          default:
                            throw new Error("JPX Error: Unknown codestream code: " + code.toString(16));
                        }
                        position += length;
                    }
                } catch (e) {
                    if (doNotRecover || this.failOnCorruptedImage) {
                        throw e;
                    } else {
                        warn("Trying to recover from " + e.message);
                    }
                }
                this.tiles = transformComponents(context);
                this.width = context.SIZ.Xsiz - context.SIZ.XOsiz;
                this.height = context.SIZ.Ysiz - context.SIZ.YOsiz;
                this.componentsCount = context.SIZ.Csiz;
            }
        };
        function calculateComponentDimensions(component, siz) {
            component.x0 = Math.ceil(siz.XOsiz / component.XRsiz);
            component.x1 = Math.ceil(siz.Xsiz / component.XRsiz);
            component.y0 = Math.ceil(siz.YOsiz / component.YRsiz);
            component.y1 = Math.ceil(siz.Ysiz / component.YRsiz);
            component.width = component.x1 - component.x0;
            component.height = component.y1 - component.y0;
        }
        function calculateTileGrids(context, components) {
            var siz = context.SIZ;
            var tile, tiles = [];
            var numXtiles = Math.ceil((siz.Xsiz - siz.XTOsiz) / siz.XTsiz);
            var numYtiles = Math.ceil((siz.Ysiz - siz.YTOsiz) / siz.YTsiz);
            for (var q = 0; q < numYtiles; q++) {
                for (var p = 0; p < numXtiles; p++) {
                    tile = {};
                    tile.tx0 = Math.max(siz.XTOsiz + p * siz.XTsiz, siz.XOsiz);
                    tile.ty0 = Math.max(siz.YTOsiz + q * siz.YTsiz, siz.YOsiz);
                    tile.tx1 = Math.min(siz.XTOsiz + (p + 1) * siz.XTsiz, siz.Xsiz);
                    tile.ty1 = Math.min(siz.YTOsiz + (q + 1) * siz.YTsiz, siz.Ysiz);
                    tile.width = tile.tx1 - tile.tx0;
                    tile.height = tile.ty1 - tile.ty0;
                    tile.components = [];
                    tiles.push(tile);
                }
            }
            context.tiles = tiles;
            var componentsCount = siz.Csiz;
            for (var i = 0, ii = componentsCount; i < ii; i++) {
                var component = components[i];
                for (var j = 0, jj = tiles.length; j < jj; j++) {
                    var tileComponent = {};
                    tile = tiles[j];
                    tileComponent.tcx0 = Math.ceil(tile.tx0 / component.XRsiz);
                    tileComponent.tcy0 = Math.ceil(tile.ty0 / component.YRsiz);
                    tileComponent.tcx1 = Math.ceil(tile.tx1 / component.XRsiz);
                    tileComponent.tcy1 = Math.ceil(tile.ty1 / component.YRsiz);
                    tileComponent.width = tileComponent.tcx1 - tileComponent.tcx0;
                    tileComponent.height = tileComponent.tcy1 - tileComponent.tcy0;
                    tile.components[i] = tileComponent;
                }
            }
        }
        function getBlocksDimensions(context, component, r) {
            var codOrCoc = component.codingStyleParameters;
            var result = {};
            if (!codOrCoc.entropyCoderWithCustomPrecincts) {
                result.PPx = 15;
                result.PPy = 15;
            } else {
                result.PPx = codOrCoc.precinctsSizes[r].PPx;
                result.PPy = codOrCoc.precinctsSizes[r].PPy;
            }
            result.xcb_ = r > 0 ? Math.min(codOrCoc.xcb, result.PPx - 1) : Math.min(codOrCoc.xcb, result.PPx);
            result.ycb_ = r > 0 ? Math.min(codOrCoc.ycb, result.PPy - 1) : Math.min(codOrCoc.ycb, result.PPy);
            return result;
        }
        function buildPrecincts(context, resolution, dimensions) {
            var precinctWidth = 1 << dimensions.PPx;
            var precinctHeight = 1 << dimensions.PPy;
            var isZeroRes = resolution.resLevel === 0;
            var precinctWidthInSubband = 1 << dimensions.PPx + (isZeroRes ? 0 : -1);
            var precinctHeightInSubband = 1 << dimensions.PPy + (isZeroRes ? 0 : -1);
            var numprecinctswide = resolution.trx1 > resolution.trx0 ? Math.ceil(resolution.trx1 / precinctWidth) - Math.floor(resolution.trx0 / precinctWidth) : 0;
            var numprecinctshigh = resolution.try1 > resolution.try0 ? Math.ceil(resolution.try1 / precinctHeight) - Math.floor(resolution.try0 / precinctHeight) : 0;
            var numprecincts = numprecinctswide * numprecinctshigh;
            resolution.precinctParameters = {
                precinctWidth: precinctWidth,
                precinctHeight: precinctHeight,
                numprecinctswide: numprecinctswide,
                numprecinctshigh: numprecinctshigh,
                numprecincts: numprecincts,
                precinctWidthInSubband: precinctWidthInSubband,
                precinctHeightInSubband: precinctHeightInSubband
            };
        }
        function buildCodeblocks(context, subband, dimensions) {
            var xcb_ = dimensions.xcb_;
            var ycb_ = dimensions.ycb_;
            var codeblockWidth = 1 << xcb_;
            var codeblockHeight = 1 << ycb_;
            var cbx0 = subband.tbx0 >> xcb_;
            var cby0 = subband.tby0 >> ycb_;
            var cbx1 = subband.tbx1 + codeblockWidth - 1 >> xcb_;
            var cby1 = subband.tby1 + codeblockHeight - 1 >> ycb_;
            var precinctParameters = subband.resolution.precinctParameters;
            var codeblocks = [];
            var precincts = [];
            var i, j, codeblock, precinctNumber;
            for (j = cby0; j < cby1; j++) {
                for (i = cbx0; i < cbx1; i++) {
                    codeblock = {
                        cbx: i,
                        cby: j,
                        tbx0: codeblockWidth * i,
                        tby0: codeblockHeight * j,
                        tbx1: codeblockWidth * (i + 1),
                        tby1: codeblockHeight * (j + 1)
                    };
                    codeblock.tbx0_ = Math.max(subband.tbx0, codeblock.tbx0);
                    codeblock.tby0_ = Math.max(subband.tby0, codeblock.tby0);
                    codeblock.tbx1_ = Math.min(subband.tbx1, codeblock.tbx1);
                    codeblock.tby1_ = Math.min(subband.tby1, codeblock.tby1);
                    var pi = Math.floor((codeblock.tbx0_ - subband.tbx0) / precinctParameters.precinctWidthInSubband);
                    var pj = Math.floor((codeblock.tby0_ - subband.tby0) / precinctParameters.precinctHeightInSubband);
                    precinctNumber = pi + pj * precinctParameters.numprecinctswide;
                    codeblock.precinctNumber = precinctNumber;
                    codeblock.subbandType = subband.type;
                    codeblock.Lblock = 3;
                    if (codeblock.tbx1_ <= codeblock.tbx0_ || codeblock.tby1_ <= codeblock.tby0_) {
                        continue;
                    }
                    codeblocks.push(codeblock);
                    var precinct = precincts[precinctNumber];
                    if (precinct !== undefined) {
                        if (i < precinct.cbxMin) {
                            precinct.cbxMin = i;
                        } else if (i > precinct.cbxMax) {
                            precinct.cbxMax = i;
                        }
                        if (j < precinct.cbyMin) {
                            precinct.cbxMin = j;
                        } else if (j > precinct.cbyMax) {
                            precinct.cbyMax = j;
                        }
                    } else {
                        precincts[precinctNumber] = precinct = {
                            cbxMin: i,
                            cbyMin: j,
                            cbxMax: i,
                            cbyMax: j
                        };
                    }
                    codeblock.precinct = precinct;
                }
            }
            subband.codeblockParameters = {
                codeblockWidth: xcb_,
                codeblockHeight: ycb_,
                numcodeblockwide: cbx1 - cbx0 + 1,
                numcodeblockhigh: cby1 - cby0 + 1
            };
            subband.codeblocks = codeblocks;
            subband.precincts = precincts;
        }
        function createPacket(resolution, precinctNumber, layerNumber) {
            var precinctCodeblocks = [];
            var subbands = resolution.subbands;
            for (var i = 0, ii = subbands.length; i < ii; i++) {
                var subband = subbands[i];
                var codeblocks = subband.codeblocks;
                for (var j = 0, jj = codeblocks.length; j < jj; j++) {
                    var codeblock = codeblocks[j];
                    if (codeblock.precinctNumber !== precinctNumber) {
                        continue;
                    }
                    precinctCodeblocks.push(codeblock);
                }
            }
            return {
                layerNumber: layerNumber,
                codeblocks: precinctCodeblocks
            };
        }
        function LayerResolutionComponentPositionIterator(context) {
            var siz = context.SIZ;
            var tileIndex = context.currentTile.index;
            var tile = context.tiles[tileIndex];
            var layersCount = tile.codingStyleDefaultParameters.layersCount;
            var componentsCount = siz.Csiz;
            var maxDecompositionLevelsCount = 0;
            for (var q = 0; q < componentsCount; q++) {
                maxDecompositionLevelsCount = Math.max(maxDecompositionLevelsCount, tile.components[q].codingStyleParameters.decompositionLevelsCount);
            }
            var l = 0, r = 0, i = 0, k = 0;
            this.nextPacket = function JpxImage_nextPacket() {
                for (;l < layersCount; l++) {
                    for (;r <= maxDecompositionLevelsCount; r++) {
                        for (;i < componentsCount; i++) {
                            var component = tile.components[i];
                            if (r > component.codingStyleParameters.decompositionLevelsCount) {
                                continue;
                            }
                            var resolution = component.resolutions[r];
                            var numprecincts = resolution.precinctParameters.numprecincts;
                            for (;k < numprecincts; ) {
                                var packet = createPacket(resolution, k, l);
                                k++;
                                return packet;
                            }
                            k = 0;
                        }
                        i = 0;
                    }
                    r = 0;
                }
                throw new Error("JPX Error: Out of packets");
            };
        }
        function ResolutionLayerComponentPositionIterator(context) {
            var siz = context.SIZ;
            var tileIndex = context.currentTile.index;
            var tile = context.tiles[tileIndex];
            var layersCount = tile.codingStyleDefaultParameters.layersCount;
            var componentsCount = siz.Csiz;
            var maxDecompositionLevelsCount = 0;
            for (var q = 0; q < componentsCount; q++) {
                maxDecompositionLevelsCount = Math.max(maxDecompositionLevelsCount, tile.components[q].codingStyleParameters.decompositionLevelsCount);
            }
            var r = 0, l = 0, i = 0, k = 0;
            this.nextPacket = function JpxImage_nextPacket() {
                for (;r <= maxDecompositionLevelsCount; r++) {
                    for (;l < layersCount; l++) {
                        for (;i < componentsCount; i++) {
                            var component = tile.components[i];
                            if (r > component.codingStyleParameters.decompositionLevelsCount) {
                                continue;
                            }
                            var resolution = component.resolutions[r];
                            var numprecincts = resolution.precinctParameters.numprecincts;
                            for (;k < numprecincts; ) {
                                var packet = createPacket(resolution, k, l);
                                k++;
                                return packet;
                            }
                            k = 0;
                        }
                        i = 0;
                    }
                    l = 0;
                }
                throw new Error("JPX Error: Out of packets");
            };
        }
        function ResolutionPositionComponentLayerIterator(context) {
            var siz = context.SIZ;
            var tileIndex = context.currentTile.index;
            var tile = context.tiles[tileIndex];
            var layersCount = tile.codingStyleDefaultParameters.layersCount;
            var componentsCount = siz.Csiz;
            var l, r, c, p;
            var maxDecompositionLevelsCount = 0;
            for (c = 0; c < componentsCount; c++) {
                var component = tile.components[c];
                maxDecompositionLevelsCount = Math.max(maxDecompositionLevelsCount, component.codingStyleParameters.decompositionLevelsCount);
            }
            var maxNumPrecinctsInLevel = new Int32Array(maxDecompositionLevelsCount + 1);
            for (r = 0; r <= maxDecompositionLevelsCount; ++r) {
                var maxNumPrecincts = 0;
                for (c = 0; c < componentsCount; ++c) {
                    var resolutions = tile.components[c].resolutions;
                    if (r < resolutions.length) {
                        maxNumPrecincts = Math.max(maxNumPrecincts, resolutions[r].precinctParameters.numprecincts);
                    }
                }
                maxNumPrecinctsInLevel[r] = maxNumPrecincts;
            }
            l = 0;
            r = 0;
            c = 0;
            p = 0;
            this.nextPacket = function JpxImage_nextPacket() {
                for (;r <= maxDecompositionLevelsCount; r++) {
                    for (;p < maxNumPrecinctsInLevel[r]; p++) {
                        for (;c < componentsCount; c++) {
                            var component = tile.components[c];
                            if (r > component.codingStyleParameters.decompositionLevelsCount) {
                                continue;
                            }
                            var resolution = component.resolutions[r];
                            var numprecincts = resolution.precinctParameters.numprecincts;
                            if (p >= numprecincts) {
                                continue;
                            }
                            for (;l < layersCount; ) {
                                var packet = createPacket(resolution, p, l);
                                l++;
                                return packet;
                            }
                            l = 0;
                        }
                        c = 0;
                    }
                    p = 0;
                }
                throw new Error("JPX Error: Out of packets");
            };
        }
        function PositionComponentResolutionLayerIterator(context) {
            var siz = context.SIZ;
            var tileIndex = context.currentTile.index;
            var tile = context.tiles[tileIndex];
            var layersCount = tile.codingStyleDefaultParameters.layersCount;
            var componentsCount = siz.Csiz;
            var precinctsSizes = getPrecinctSizesInImageScale(tile);
            var precinctsIterationSizes = precinctsSizes;
            var l = 0, r = 0, c = 0, px = 0, py = 0;
            this.nextPacket = function JpxImage_nextPacket() {
                for (;py < precinctsIterationSizes.maxNumHigh; py++) {
                    for (;px < precinctsIterationSizes.maxNumWide; px++) {
                        for (;c < componentsCount; c++) {
                            var component = tile.components[c];
                            var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
                            for (;r <= decompositionLevelsCount; r++) {
                                var resolution = component.resolutions[r];
                                var sizeInImageScale = precinctsSizes.components[c].resolutions[r];
                                var k = getPrecinctIndexIfExist(px, py, sizeInImageScale, precinctsIterationSizes, resolution);
                                if (k === null) {
                                    continue;
                                }
                                for (;l < layersCount; ) {
                                    var packet = createPacket(resolution, k, l);
                                    l++;
                                    return packet;
                                }
                                l = 0;
                            }
                            r = 0;
                        }
                        c = 0;
                    }
                    px = 0;
                }
                throw new Error("JPX Error: Out of packets");
            };
        }
        function ComponentPositionResolutionLayerIterator(context) {
            var siz = context.SIZ;
            var tileIndex = context.currentTile.index;
            var tile = context.tiles[tileIndex];
            var layersCount = tile.codingStyleDefaultParameters.layersCount;
            var componentsCount = siz.Csiz;
            var precinctsSizes = getPrecinctSizesInImageScale(tile);
            var l = 0, r = 0, c = 0, px = 0, py = 0;
            this.nextPacket = function JpxImage_nextPacket() {
                for (;c < componentsCount; ++c) {
                    var component = tile.components[c];
                    var precinctsIterationSizes = precinctsSizes.components[c];
                    var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
                    for (;py < precinctsIterationSizes.maxNumHigh; py++) {
                        for (;px < precinctsIterationSizes.maxNumWide; px++) {
                            for (;r <= decompositionLevelsCount; r++) {
                                var resolution = component.resolutions[r];
                                var sizeInImageScale = precinctsIterationSizes.resolutions[r];
                                var k = getPrecinctIndexIfExist(px, py, sizeInImageScale, precinctsIterationSizes, resolution);
                                if (k === null) {
                                    continue;
                                }
                                for (;l < layersCount; ) {
                                    var packet = createPacket(resolution, k, l);
                                    l++;
                                    return packet;
                                }
                                l = 0;
                            }
                            r = 0;
                        }
                        px = 0;
                    }
                    py = 0;
                }
                throw new Error("JPX Error: Out of packets");
            };
        }
        function getPrecinctIndexIfExist(pxIndex, pyIndex, sizeInImageScale, precinctIterationSizes, resolution) {
            var posX = pxIndex * precinctIterationSizes.minWidth;
            var posY = pyIndex * precinctIterationSizes.minHeight;
            if (posX % sizeInImageScale.width !== 0 || posY % sizeInImageScale.height !== 0) {
                return null;
            }
            var startPrecinctRowIndex = posY / sizeInImageScale.width * resolution.precinctParameters.numprecinctswide;
            return posX / sizeInImageScale.height + startPrecinctRowIndex;
        }
        function getPrecinctSizesInImageScale(tile) {
            var componentsCount = tile.components.length;
            var minWidth = Number.MAX_VALUE;
            var minHeight = Number.MAX_VALUE;
            var maxNumWide = 0;
            var maxNumHigh = 0;
            var sizePerComponent = new Array(componentsCount);
            for (var c = 0; c < componentsCount; c++) {
                var component = tile.components[c];
                var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
                var sizePerResolution = new Array(decompositionLevelsCount + 1);
                var minWidthCurrentComponent = Number.MAX_VALUE;
                var minHeightCurrentComponent = Number.MAX_VALUE;
                var maxNumWideCurrentComponent = 0;
                var maxNumHighCurrentComponent = 0;
                var scale = 1;
                for (var r = decompositionLevelsCount; r >= 0; --r) {
                    var resolution = component.resolutions[r];
                    var widthCurrentResolution = scale * resolution.precinctParameters.precinctWidth;
                    var heightCurrentResolution = scale * resolution.precinctParameters.precinctHeight;
                    minWidthCurrentComponent = Math.min(minWidthCurrentComponent, widthCurrentResolution);
                    minHeightCurrentComponent = Math.min(minHeightCurrentComponent, heightCurrentResolution);
                    maxNumWideCurrentComponent = Math.max(maxNumWideCurrentComponent, resolution.precinctParameters.numprecinctswide);
                    maxNumHighCurrentComponent = Math.max(maxNumHighCurrentComponent, resolution.precinctParameters.numprecinctshigh);
                    sizePerResolution[r] = {
                        width: widthCurrentResolution,
                        height: heightCurrentResolution
                    };
                    scale <<= 1;
                }
                minWidth = Math.min(minWidth, minWidthCurrentComponent);
                minHeight = Math.min(minHeight, minHeightCurrentComponent);
                maxNumWide = Math.max(maxNumWide, maxNumWideCurrentComponent);
                maxNumHigh = Math.max(maxNumHigh, maxNumHighCurrentComponent);
                sizePerComponent[c] = {
                    resolutions: sizePerResolution,
                    minWidth: minWidthCurrentComponent,
                    minHeight: minHeightCurrentComponent,
                    maxNumWide: maxNumWideCurrentComponent,
                    maxNumHigh: maxNumHighCurrentComponent
                };
            }
            return {
                components: sizePerComponent,
                minWidth: minWidth,
                minHeight: minHeight,
                maxNumWide: maxNumWide,
                maxNumHigh: maxNumHigh
            };
        }
        function buildPackets(context) {
            var siz = context.SIZ;
            var tileIndex = context.currentTile.index;
            var tile = context.tiles[tileIndex];
            var componentsCount = siz.Csiz;
            for (var c = 0; c < componentsCount; c++) {
                var component = tile.components[c];
                var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
                var resolutions = [];
                var subbands = [];
                for (var r = 0; r <= decompositionLevelsCount; r++) {
                    var blocksDimensions = getBlocksDimensions(context, component, r);
                    var resolution = {};
                    var scale = 1 << decompositionLevelsCount - r;
                    resolution.trx0 = Math.ceil(component.tcx0 / scale);
                    resolution.try0 = Math.ceil(component.tcy0 / scale);
                    resolution.trx1 = Math.ceil(component.tcx1 / scale);
                    resolution.try1 = Math.ceil(component.tcy1 / scale);
                    resolution.resLevel = r;
                    buildPrecincts(context, resolution, blocksDimensions);
                    resolutions.push(resolution);
                    var subband;
                    if (r === 0) {
                        subband = {};
                        subband.type = "LL";
                        subband.tbx0 = Math.ceil(component.tcx0 / scale);
                        subband.tby0 = Math.ceil(component.tcy0 / scale);
                        subband.tbx1 = Math.ceil(component.tcx1 / scale);
                        subband.tby1 = Math.ceil(component.tcy1 / scale);
                        subband.resolution = resolution;
                        buildCodeblocks(context, subband, blocksDimensions);
                        subbands.push(subband);
                        resolution.subbands = [ subband ];
                    } else {
                        var bscale = 1 << decompositionLevelsCount - r + 1;
                        var resolutionSubbands = [];
                        subband = {};
                        subband.type = "HL";
                        subband.tbx0 = Math.ceil(component.tcx0 / bscale - .5);
                        subband.tby0 = Math.ceil(component.tcy0 / bscale);
                        subband.tbx1 = Math.ceil(component.tcx1 / bscale - .5);
                        subband.tby1 = Math.ceil(component.tcy1 / bscale);
                        subband.resolution = resolution;
                        buildCodeblocks(context, subband, blocksDimensions);
                        subbands.push(subband);
                        resolutionSubbands.push(subband);
                        subband = {};
                        subband.type = "LH";
                        subband.tbx0 = Math.ceil(component.tcx0 / bscale);
                        subband.tby0 = Math.ceil(component.tcy0 / bscale - .5);
                        subband.tbx1 = Math.ceil(component.tcx1 / bscale);
                        subband.tby1 = Math.ceil(component.tcy1 / bscale - .5);
                        subband.resolution = resolution;
                        buildCodeblocks(context, subband, blocksDimensions);
                        subbands.push(subband);
                        resolutionSubbands.push(subband);
                        subband = {};
                        subband.type = "HH";
                        subband.tbx0 = Math.ceil(component.tcx0 / bscale - .5);
                        subband.tby0 = Math.ceil(component.tcy0 / bscale - .5);
                        subband.tbx1 = Math.ceil(component.tcx1 / bscale - .5);
                        subband.tby1 = Math.ceil(component.tcy1 / bscale - .5);
                        subband.resolution = resolution;
                        buildCodeblocks(context, subband, blocksDimensions);
                        subbands.push(subband);
                        resolutionSubbands.push(subband);
                        resolution.subbands = resolutionSubbands;
                    }
                }
                component.resolutions = resolutions;
                component.subbands = subbands;
            }
            var progressionOrder = tile.codingStyleDefaultParameters.progressionOrder;
            switch (progressionOrder) {
              case 0:
                tile.packetsIterator = new LayerResolutionComponentPositionIterator(context);
                break;

              case 1:
                tile.packetsIterator = new ResolutionLayerComponentPositionIterator(context);
                break;

              case 2:
                tile.packetsIterator = new ResolutionPositionComponentLayerIterator(context);
                break;

              case 3:
                tile.packetsIterator = new PositionComponentResolutionLayerIterator(context);
                break;

              case 4:
                tile.packetsIterator = new ComponentPositionResolutionLayerIterator(context);
                break;

              default:
                throw new Error("JPX Error: Unsupported progression order " + progressionOrder);
            }
        }
        function parseTilePackets(context, data, offset, dataLength) {
            var position = 0;
            var buffer, bufferSize = 0, skipNextBit = false;
            function readBits(count) {
                while (bufferSize < count) {
                    var b = data[offset + position];
                    position++;
                    if (skipNextBit) {
                        buffer = buffer << 7 | b;
                        bufferSize += 7;
                        skipNextBit = false;
                    } else {
                        buffer = buffer << 8 | b;
                        bufferSize += 8;
                    }
                    if (b === 255) {
                        skipNextBit = true;
                    }
                }
                bufferSize -= count;
                return buffer >>> bufferSize & (1 << count) - 1;
            }
            function skipMarkerIfEqual(value) {
                if (data[offset + position - 1] === 255 && data[offset + position] === value) {
                    skipBytes(1);
                    return true;
                } else if (data[offset + position] === 255 && data[offset + position + 1] === value) {
                    skipBytes(2);
                    return true;
                }
                return false;
            }
            function skipBytes(count) {
                position += count;
            }
            function alignToByte() {
                bufferSize = 0;
                if (skipNextBit) {
                    position++;
                    skipNextBit = false;
                }
            }
            function readCodingpasses() {
                if (readBits(1) === 0) {
                    return 1;
                }
                if (readBits(1) === 0) {
                    return 2;
                }
                var value = readBits(2);
                if (value < 3) {
                    return value + 3;
                }
                value = readBits(5);
                if (value < 31) {
                    return value + 6;
                }
                value = readBits(7);
                return value + 37;
            }
            var tileIndex = context.currentTile.index;
            var tile = context.tiles[tileIndex];
            var sopMarkerUsed = context.COD.sopMarkerUsed;
            var ephMarkerUsed = context.COD.ephMarkerUsed;
            var packetsIterator = tile.packetsIterator;
            while (position < dataLength) {
                alignToByte();
                if (sopMarkerUsed && skipMarkerIfEqual(145)) {
                    skipBytes(4);
                }
                var packet = packetsIterator.nextPacket();
                if (!readBits(1)) {
                    continue;
                }
                var layerNumber = packet.layerNumber;
                var queue = [], codeblock;
                for (var i = 0, ii = packet.codeblocks.length; i < ii; i++) {
                    codeblock = packet.codeblocks[i];
                    var precinct = codeblock.precinct;
                    var codeblockColumn = codeblock.cbx - precinct.cbxMin;
                    var codeblockRow = codeblock.cby - precinct.cbyMin;
                    var codeblockIncluded = false;
                    var firstTimeInclusion = false;
                    var valueReady;
                    if (codeblock["included"] !== undefined) {
                        codeblockIncluded = !!readBits(1);
                    } else {
                        precinct = codeblock.precinct;
                        var inclusionTree, zeroBitPlanesTree;
                        if (precinct["inclusionTree"] !== undefined) {
                            inclusionTree = precinct.inclusionTree;
                        } else {
                            var width = precinct.cbxMax - precinct.cbxMin + 1;
                            var height = precinct.cbyMax - precinct.cbyMin + 1;
                            inclusionTree = new InclusionTree(width, height, layerNumber);
                            zeroBitPlanesTree = new TagTree(width, height);
                            precinct.inclusionTree = inclusionTree;
                            precinct.zeroBitPlanesTree = zeroBitPlanesTree;
                        }
                        if (inclusionTree.reset(codeblockColumn, codeblockRow, layerNumber)) {
                            while (true) {
                                if (readBits(1)) {
                                    valueReady = !inclusionTree.nextLevel();
                                    if (valueReady) {
                                        codeblock.included = true;
                                        codeblockIncluded = firstTimeInclusion = true;
                                        break;
                                    }
                                } else {
                                    inclusionTree.incrementValue(layerNumber);
                                    break;
                                }
                            }
                        }
                    }
                    if (!codeblockIncluded) {
                        continue;
                    }
                    if (firstTimeInclusion) {
                        zeroBitPlanesTree = precinct.zeroBitPlanesTree;
                        zeroBitPlanesTree.reset(codeblockColumn, codeblockRow);
                        while (true) {
                            if (readBits(1)) {
                                valueReady = !zeroBitPlanesTree.nextLevel();
                                if (valueReady) {
                                    break;
                                }
                            } else {
                                zeroBitPlanesTree.incrementValue();
                            }
                        }
                        codeblock.zeroBitPlanes = zeroBitPlanesTree.value;
                    }
                    var codingpasses = readCodingpasses();
                    while (readBits(1)) {
                        codeblock.Lblock++;
                    }
                    var codingpassesLog2 = log2(codingpasses);
                    var bits = (codingpasses < 1 << codingpassesLog2 ? codingpassesLog2 - 1 : codingpassesLog2) + codeblock.Lblock;
                    var codedDataLength = readBits(bits);
                    queue.push({
                        codeblock: codeblock,
                        codingpasses: codingpasses,
                        dataLength: codedDataLength
                    });
                }
                alignToByte();
                if (ephMarkerUsed) {
                    skipMarkerIfEqual(146);
                }
                while (queue.length > 0) {
                    var packetItem = queue.shift();
                    codeblock = packetItem.codeblock;
                    if (codeblock["data"] === undefined) {
                        codeblock.data = [];
                    }
                    codeblock.data.push({
                        data: data,
                        start: offset + position,
                        end: offset + position + packetItem.dataLength,
                        codingpasses: packetItem.codingpasses
                    });
                    position += packetItem.dataLength;
                }
            }
            return position;
        }
        function copyCoefficients(coefficients, levelWidth, levelHeight, subband, delta, mb, reversible, segmentationSymbolUsed) {
            var x0 = subband.tbx0;
            var y0 = subband.tby0;
            var width = subband.tbx1 - subband.tbx0;
            var codeblocks = subband.codeblocks;
            var right = subband.type.charAt(0) === "H" ? 1 : 0;
            var bottom = subband.type.charAt(1) === "H" ? levelWidth : 0;
            for (var i = 0, ii = codeblocks.length; i < ii; ++i) {
                var codeblock = codeblocks[i];
                var blockWidth = codeblock.tbx1_ - codeblock.tbx0_;
                var blockHeight = codeblock.tby1_ - codeblock.tby0_;
                if (blockWidth === 0 || blockHeight === 0) {
                    continue;
                }
                if (codeblock["data"] === undefined) {
                    continue;
                }
                var bitModel, currentCodingpassType;
                bitModel = new BitModel(blockWidth, blockHeight, codeblock.subbandType, codeblock.zeroBitPlanes, mb);
                currentCodingpassType = 2;
                var data = codeblock.data, totalLength = 0, codingpasses = 0;
                var j, jj, dataItem;
                for (j = 0, jj = data.length; j < jj; j++) {
                    dataItem = data[j];
                    totalLength += dataItem.end - dataItem.start;
                    codingpasses += dataItem.codingpasses;
                }
                var encodedData = new Uint8Array(totalLength);
                var position = 0;
                for (j = 0, jj = data.length; j < jj; j++) {
                    dataItem = data[j];
                    var chunk = dataItem.data.subarray(dataItem.start, dataItem.end);
                    encodedData.set(chunk, position);
                    position += chunk.length;
                }
                var decoder = new ArithmeticDecoder(encodedData, 0, totalLength);
                bitModel.setDecoder(decoder);
                for (j = 0; j < codingpasses; j++) {
                    switch (currentCodingpassType) {
                      case 0:
                        bitModel.runSignificancePropogationPass();
                        break;

                      case 1:
                        bitModel.runMagnitudeRefinementPass();
                        break;

                      case 2:
                        bitModel.runCleanupPass();
                        if (segmentationSymbolUsed) {
                            bitModel.checkSegmentationSymbol();
                        }
                        break;
                    }
                    currentCodingpassType = (currentCodingpassType + 1) % 3;
                }
                var offset = codeblock.tbx0_ - x0 + (codeblock.tby0_ - y0) * width;
                var sign = bitModel.coefficentsSign;
                var magnitude = bitModel.coefficentsMagnitude;
                var bitsDecoded = bitModel.bitsDecoded;
                var magnitudeCorrection = reversible ? 0 : .5;
                var k, n, nb;
                position = 0;
                var interleave = subband.type !== "LL";
                for (j = 0; j < blockHeight; j++) {
                    var row = offset / width | 0;
                    var levelOffset = 2 * row * (levelWidth - width) + right + bottom;
                    for (k = 0; k < blockWidth; k++) {
                        n = magnitude[position];
                        if (n !== 0) {
                            n = (n + magnitudeCorrection) * delta;
                            if (sign[position] !== 0) {
                                n = -n;
                            }
                            nb = bitsDecoded[position];
                            var pos = interleave ? levelOffset + (offset << 1) : offset;
                            if (reversible && nb >= mb) {
                                coefficients[pos] = n;
                            } else {
                                coefficients[pos] = n * (1 << mb - nb);
                            }
                        }
                        offset++;
                        position++;
                    }
                    offset += width - blockWidth;
                }
            }
        }
        function transformTile(context, tile, c) {
            var component = tile.components[c];
            var codingStyleParameters = component.codingStyleParameters;
            var quantizationParameters = component.quantizationParameters;
            var decompositionLevelsCount = codingStyleParameters.decompositionLevelsCount;
            var spqcds = quantizationParameters.SPqcds;
            var scalarExpounded = quantizationParameters.scalarExpounded;
            var guardBits = quantizationParameters.guardBits;
            var segmentationSymbolUsed = codingStyleParameters.segmentationSymbolUsed;
            var precision = context.components[c].precision;
            var reversible = codingStyleParameters.reversibleTransformation;
            var transform = reversible ? new ReversibleTransform() : new IrreversibleTransform();
            var subbandCoefficients = [];
            var b = 0;
            for (var i = 0; i <= decompositionLevelsCount; i++) {
                var resolution = component.resolutions[i];
                var width = resolution.trx1 - resolution.trx0;
                var height = resolution.try1 - resolution.try0;
                var coefficients = new Float32Array(width * height);
                for (var j = 0, jj = resolution.subbands.length; j < jj; j++) {
                    var mu, epsilon;
                    if (!scalarExpounded) {
                        mu = spqcds[0].mu;
                        epsilon = spqcds[0].epsilon + (i > 0 ? 1 - i : 0);
                    } else {
                        mu = spqcds[b].mu;
                        epsilon = spqcds[b].epsilon;
                        b++;
                    }
                    var subband = resolution.subbands[j];
                    var gainLog2 = SubbandsGainLog2[subband.type];
                    var delta = reversible ? 1 : Math.pow(2, precision + gainLog2 - epsilon) * (1 + mu / 2048);
                    var mb = guardBits + epsilon - 1;
                    copyCoefficients(coefficients, width, height, subband, delta, mb, reversible, segmentationSymbolUsed);
                }
                subbandCoefficients.push({
                    width: width,
                    height: height,
                    items: coefficients
                });
            }
            var result = transform.calculate(subbandCoefficients, component.tcx0, component.tcy0);
            return {
                left: component.tcx0,
                top: component.tcy0,
                width: result.width,
                height: result.height,
                items: result.items
            };
        }
        function transformComponents(context) {
            var siz = context.SIZ;
            var components = context.components;
            var componentsCount = siz.Csiz;
            var resultImages = [];
            for (var i = 0, ii = context.tiles.length; i < ii; i++) {
                var tile = context.tiles[i];
                var transformedTiles = [];
                var c;
                for (c = 0; c < componentsCount; c++) {
                    transformedTiles[c] = transformTile(context, tile, c);
                }
                var tile0 = transformedTiles[0];
                var out = new Uint8Array(tile0.items.length * componentsCount);
                var result = {
                    left: tile0.left,
                    top: tile0.top,
                    width: tile0.width,
                    height: tile0.height,
                    items: out
                };
                var shift, offset, max, min, maxK;
                var pos = 0, j, jj, y0, y1, y2, r, g, b, k, val;
                if (tile.codingStyleDefaultParameters.multipleComponentTransform) {
                    var fourComponents = componentsCount === 4;
                    var y0items = transformedTiles[0].items;
                    var y1items = transformedTiles[1].items;
                    var y2items = transformedTiles[2].items;
                    var y3items = fourComponents ? transformedTiles[3].items : null;
                    shift = components[0].precision - 8;
                    offset = (128 << shift) + .5;
                    max = 255 * (1 << shift);
                    maxK = max * .5;
                    min = -maxK;
                    var component0 = tile.components[0];
                    var alpha01 = componentsCount - 3;
                    jj = y0items.length;
                    if (!component0.codingStyleParameters.reversibleTransformation) {
                        for (j = 0; j < jj; j++, pos += alpha01) {
                            y0 = y0items[j] + offset;
                            y1 = y1items[j];
                            y2 = y2items[j];
                            r = y0 + 1.402 * y2;
                            g = y0 - .34413 * y1 - .71414 * y2;
                            b = y0 + 1.772 * y1;
                            out[pos++] = r <= 0 ? 0 : r >= max ? 255 : r >> shift;
                            out[pos++] = g <= 0 ? 0 : g >= max ? 255 : g >> shift;
                            out[pos++] = b <= 0 ? 0 : b >= max ? 255 : b >> shift;
                        }
                    } else {
                        for (j = 0; j < jj; j++, pos += alpha01) {
                            y0 = y0items[j] + offset;
                            y1 = y1items[j];
                            y2 = y2items[j];
                            g = y0 - (y2 + y1 >> 2);
                            r = g + y2;
                            b = g + y1;
                            out[pos++] = r <= 0 ? 0 : r >= max ? 255 : r >> shift;
                            out[pos++] = g <= 0 ? 0 : g >= max ? 255 : g >> shift;
                            out[pos++] = b <= 0 ? 0 : b >= max ? 255 : b >> shift;
                        }
                    }
                    if (fourComponents) {
                        for (j = 0, pos = 3; j < jj; j++, pos += 4) {
                            k = y3items[j];
                            out[pos] = k <= min ? 0 : k >= maxK ? 255 : k + offset >> shift;
                        }
                    }
                } else {
                    for (c = 0; c < componentsCount; c++) {
                        var items = transformedTiles[c].items;
                        shift = components[c].precision - 8;
                        offset = (128 << shift) + .5;
                        max = 127.5 * (1 << shift);
                        min = -max;
                        for (pos = c, j = 0, jj = items.length; j < jj; j++) {
                            val = items[j];
                            out[pos] = val <= min ? 0 : val >= max ? 255 : val + offset >> shift;
                            pos += componentsCount;
                        }
                    }
                }
                resultImages.push(result);
            }
            return resultImages;
        }
        function initializeTile(context, tileIndex) {
            var siz = context.SIZ;
            var componentsCount = siz.Csiz;
            var tile = context.tiles[tileIndex];
            for (var c = 0; c < componentsCount; c++) {
                var component = tile.components[c];
                var qcdOrQcc = context.currentTile.QCC[c] !== undefined ? context.currentTile.QCC[c] : context.currentTile.QCD;
                component.quantizationParameters = qcdOrQcc;
                var codOrCoc = context.currentTile.COC[c] !== undefined ? context.currentTile.COC[c] : context.currentTile.COD;
                component.codingStyleParameters = codOrCoc;
            }
            tile.codingStyleDefaultParameters = context.currentTile.COD;
        }
        var TagTree = function TagTreeClosure() {
            function TagTree(width, height) {
                var levelsLength = log2(Math.max(width, height)) + 1;
                this.levels = [];
                for (var i = 0; i < levelsLength; i++) {
                    var level = {
                        width: width,
                        height: height,
                        items: []
                    };
                    this.levels.push(level);
                    width = Math.ceil(width / 2);
                    height = Math.ceil(height / 2);
                }
            }
            TagTree.prototype = {
                reset: function TagTree_reset(i, j) {
                    var currentLevel = 0, value = 0, level;
                    while (currentLevel < this.levels.length) {
                        level = this.levels[currentLevel];
                        var index = i + j * level.width;
                        if (level.items[index] !== undefined) {
                            value = level.items[index];
                            break;
                        }
                        level.index = index;
                        i >>= 1;
                        j >>= 1;
                        currentLevel++;
                    }
                    currentLevel--;
                    level = this.levels[currentLevel];
                    level.items[level.index] = value;
                    this.currentLevel = currentLevel;
                    delete this.value;
                },
                incrementValue: function TagTree_incrementValue() {
                    var level = this.levels[this.currentLevel];
                    level.items[level.index]++;
                },
                nextLevel: function TagTree_nextLevel() {
                    var currentLevel = this.currentLevel;
                    var level = this.levels[currentLevel];
                    var value = level.items[level.index];
                    currentLevel--;
                    if (currentLevel < 0) {
                        this.value = value;
                        return false;
                    }
                    this.currentLevel = currentLevel;
                    level = this.levels[currentLevel];
                    level.items[level.index] = value;
                    return true;
                }
            };
            return TagTree;
        }();
        var InclusionTree = function InclusionTreeClosure() {
            function InclusionTree(width, height, defaultValue) {
                var levelsLength = log2(Math.max(width, height)) + 1;
                this.levels = [];
                for (var i = 0; i < levelsLength; i++) {
                    var items = new Uint8Array(width * height);
                    for (var j = 0, jj = items.length; j < jj; j++) {
                        items[j] = defaultValue;
                    }
                    var level = {
                        width: width,
                        height: height,
                        items: items
                    };
                    this.levels.push(level);
                    width = Math.ceil(width / 2);
                    height = Math.ceil(height / 2);
                }
            }
            InclusionTree.prototype = {
                reset: function InclusionTree_reset(i, j, stopValue) {
                    var currentLevel = 0;
                    while (currentLevel < this.levels.length) {
                        var level = this.levels[currentLevel];
                        var index = i + j * level.width;
                        level.index = index;
                        var value = level.items[index];
                        if (value === 255) {
                            break;
                        }
                        if (value > stopValue) {
                            this.currentLevel = currentLevel;
                            this.propagateValues();
                            return false;
                        }
                        i >>= 1;
                        j >>= 1;
                        currentLevel++;
                    }
                    this.currentLevel = currentLevel - 1;
                    return true;
                },
                incrementValue: function InclusionTree_incrementValue(stopValue) {
                    var level = this.levels[this.currentLevel];
                    level.items[level.index] = stopValue + 1;
                    this.propagateValues();
                },
                propagateValues: function InclusionTree_propagateValues() {
                    var levelIndex = this.currentLevel;
                    var level = this.levels[levelIndex];
                    var currentValue = level.items[level.index];
                    while (--levelIndex >= 0) {
                        level = this.levels[levelIndex];
                        level.items[level.index] = currentValue;
                    }
                },
                nextLevel: function InclusionTree_nextLevel() {
                    var currentLevel = this.currentLevel;
                    var level = this.levels[currentLevel];
                    var value = level.items[level.index];
                    level.items[level.index] = 255;
                    currentLevel--;
                    if (currentLevel < 0) {
                        return false;
                    }
                    this.currentLevel = currentLevel;
                    level = this.levels[currentLevel];
                    level.items[level.index] = value;
                    return true;
                }
            };
            return InclusionTree;
        }();
        var BitModel = function BitModelClosure() {
            var UNIFORM_CONTEXT = 17;
            var RUNLENGTH_CONTEXT = 18;
            var LLAndLHContextsLabel = new Uint8Array([ 0, 5, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 1, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 2, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 2, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 2, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8 ]);
            var HLContextLabel = new Uint8Array([ 0, 3, 4, 0, 5, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 1, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 2, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 2, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 2, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8 ]);
            var HHContextLabel = new Uint8Array([ 0, 1, 2, 0, 1, 2, 2, 0, 2, 2, 2, 0, 0, 0, 0, 0, 3, 4, 5, 0, 4, 5, 5, 0, 5, 5, 5, 0, 0, 0, 0, 0, 6, 7, 7, 0, 7, 7, 7, 0, 7, 7, 7, 0, 0, 0, 0, 0, 8, 8, 8, 0, 8, 8, 8, 0, 8, 8, 8, 0, 0, 0, 0, 0, 8, 8, 8, 0, 8, 8, 8, 0, 8, 8, 8 ]);
            function BitModel(width, height, subband, zeroBitPlanes, mb) {
                this.width = width;
                this.height = height;
                this.contextLabelTable = subband === "HH" ? HHContextLabel : subband === "HL" ? HLContextLabel : LLAndLHContextsLabel;
                var coefficientCount = width * height;
                this.neighborsSignificance = new Uint8Array(coefficientCount);
                this.coefficentsSign = new Uint8Array(coefficientCount);
                this.coefficentsMagnitude = mb > 14 ? new Uint32Array(coefficientCount) : mb > 6 ? new Uint16Array(coefficientCount) : new Uint8Array(coefficientCount);
                this.processingFlags = new Uint8Array(coefficientCount);
                var bitsDecoded = new Uint8Array(coefficientCount);
                if (zeroBitPlanes !== 0) {
                    for (var i = 0; i < coefficientCount; i++) {
                        bitsDecoded[i] = zeroBitPlanes;
                    }
                }
                this.bitsDecoded = bitsDecoded;
                this.reset();
            }
            BitModel.prototype = {
                setDecoder: function BitModel_setDecoder(decoder) {
                    this.decoder = decoder;
                },
                reset: function BitModel_reset() {
                    this.contexts = new Int8Array(19);
                    this.contexts[0] = 4 << 1 | 0;
                    this.contexts[UNIFORM_CONTEXT] = 46 << 1 | 0;
                    this.contexts[RUNLENGTH_CONTEXT] = 3 << 1 | 0;
                },
                setNeighborsSignificance: function BitModel_setNeighborsSignificance(row, column, index) {
                    var neighborsSignificance = this.neighborsSignificance;
                    var width = this.width, height = this.height;
                    var left = column > 0;
                    var right = column + 1 < width;
                    var i;
                    if (row > 0) {
                        i = index - width;
                        if (left) {
                            neighborsSignificance[i - 1] += 16;
                        }
                        if (right) {
                            neighborsSignificance[i + 1] += 16;
                        }
                        neighborsSignificance[i] += 4;
                    }
                    if (row + 1 < height) {
                        i = index + width;
                        if (left) {
                            neighborsSignificance[i - 1] += 16;
                        }
                        if (right) {
                            neighborsSignificance[i + 1] += 16;
                        }
                        neighborsSignificance[i] += 4;
                    }
                    if (left) {
                        neighborsSignificance[index - 1] += 1;
                    }
                    if (right) {
                        neighborsSignificance[index + 1] += 1;
                    }
                    neighborsSignificance[index] |= 128;
                },
                runSignificancePropogationPass: function BitModel_runSignificancePropogationPass() {
                    var decoder = this.decoder;
                    var width = this.width, height = this.height;
                    var coefficentsMagnitude = this.coefficentsMagnitude;
                    var coefficentsSign = this.coefficentsSign;
                    var neighborsSignificance = this.neighborsSignificance;
                    var processingFlags = this.processingFlags;
                    var contexts = this.contexts;
                    var labels = this.contextLabelTable;
                    var bitsDecoded = this.bitsDecoded;
                    var processedInverseMask = ~1;
                    var processedMask = 1;
                    var firstMagnitudeBitMask = 2;
                    for (var i0 = 0; i0 < height; i0 += 4) {
                        for (var j = 0; j < width; j++) {
                            var index = i0 * width + j;
                            for (var i1 = 0; i1 < 4; i1++, index += width) {
                                var i = i0 + i1;
                                if (i >= height) {
                                    break;
                                }
                                processingFlags[index] &= processedInverseMask;
                                if (coefficentsMagnitude[index] || !neighborsSignificance[index]) {
                                    continue;
                                }
                                var contextLabel = labels[neighborsSignificance[index]];
                                var decision = decoder.readBit(contexts, contextLabel);
                                if (decision) {
                                    var sign = this.decodeSignBit(i, j, index);
                                    coefficentsSign[index] = sign;
                                    coefficentsMagnitude[index] = 1;
                                    this.setNeighborsSignificance(i, j, index);
                                    processingFlags[index] |= firstMagnitudeBitMask;
                                }
                                bitsDecoded[index]++;
                                processingFlags[index] |= processedMask;
                            }
                        }
                    }
                },
                decodeSignBit: function BitModel_decodeSignBit(row, column, index) {
                    var width = this.width, height = this.height;
                    var coefficentsMagnitude = this.coefficentsMagnitude;
                    var coefficentsSign = this.coefficentsSign;
                    var contribution, sign0, sign1, significance1;
                    var contextLabel, decoded;
                    significance1 = column > 0 && coefficentsMagnitude[index - 1] !== 0;
                    if (column + 1 < width && coefficentsMagnitude[index + 1] !== 0) {
                        sign1 = coefficentsSign[index + 1];
                        if (significance1) {
                            sign0 = coefficentsSign[index - 1];
                            contribution = 1 - sign1 - sign0;
                        } else {
                            contribution = 1 - sign1 - sign1;
                        }
                    } else if (significance1) {
                        sign0 = coefficentsSign[index - 1];
                        contribution = 1 - sign0 - sign0;
                    } else {
                        contribution = 0;
                    }
                    var horizontalContribution = 3 * contribution;
                    significance1 = row > 0 && coefficentsMagnitude[index - width] !== 0;
                    if (row + 1 < height && coefficentsMagnitude[index + width] !== 0) {
                        sign1 = coefficentsSign[index + width];
                        if (significance1) {
                            sign0 = coefficentsSign[index - width];
                            contribution = 1 - sign1 - sign0 + horizontalContribution;
                        } else {
                            contribution = 1 - sign1 - sign1 + horizontalContribution;
                        }
                    } else if (significance1) {
                        sign0 = coefficentsSign[index - width];
                        contribution = 1 - sign0 - sign0 + horizontalContribution;
                    } else {
                        contribution = horizontalContribution;
                    }
                    if (contribution >= 0) {
                        contextLabel = 9 + contribution;
                        decoded = this.decoder.readBit(this.contexts, contextLabel);
                    } else {
                        contextLabel = 9 - contribution;
                        decoded = this.decoder.readBit(this.contexts, contextLabel) ^ 1;
                    }
                    return decoded;
                },
                runMagnitudeRefinementPass: function BitModel_runMagnitudeRefinementPass() {
                    var decoder = this.decoder;
                    var width = this.width, height = this.height;
                    var coefficentsMagnitude = this.coefficentsMagnitude;
                    var neighborsSignificance = this.neighborsSignificance;
                    var contexts = this.contexts;
                    var bitsDecoded = this.bitsDecoded;
                    var processingFlags = this.processingFlags;
                    var processedMask = 1;
                    var firstMagnitudeBitMask = 2;
                    var length = width * height;
                    var width4 = width * 4;
                    for (var index0 = 0, indexNext; index0 < length; index0 = indexNext) {
                        indexNext = Math.min(length, index0 + width4);
                        for (var j = 0; j < width; j++) {
                            for (var index = index0 + j; index < indexNext; index += width) {
                                if (!coefficentsMagnitude[index] || (processingFlags[index] & processedMask) !== 0) {
                                    continue;
                                }
                                var contextLabel = 16;
                                if ((processingFlags[index] & firstMagnitudeBitMask) !== 0) {
                                    processingFlags[index] ^= firstMagnitudeBitMask;
                                    var significance = neighborsSignificance[index] & 127;
                                    contextLabel = significance === 0 ? 15 : 14;
                                }
                                var bit = decoder.readBit(contexts, contextLabel);
                                coefficentsMagnitude[index] = coefficentsMagnitude[index] << 1 | bit;
                                bitsDecoded[index]++;
                                processingFlags[index] |= processedMask;
                            }
                        }
                    }
                },
                runCleanupPass: function BitModel_runCleanupPass() {
                    var decoder = this.decoder;
                    var width = this.width, height = this.height;
                    var neighborsSignificance = this.neighborsSignificance;
                    var coefficentsMagnitude = this.coefficentsMagnitude;
                    var coefficentsSign = this.coefficentsSign;
                    var contexts = this.contexts;
                    var labels = this.contextLabelTable;
                    var bitsDecoded = this.bitsDecoded;
                    var processingFlags = this.processingFlags;
                    var processedMask = 1;
                    var firstMagnitudeBitMask = 2;
                    var oneRowDown = width;
                    var twoRowsDown = width * 2;
                    var threeRowsDown = width * 3;
                    var iNext;
                    for (var i0 = 0; i0 < height; i0 = iNext) {
                        iNext = Math.min(i0 + 4, height);
                        var indexBase = i0 * width;
                        var checkAllEmpty = i0 + 3 < height;
                        for (var j = 0; j < width; j++) {
                            var index0 = indexBase + j;
                            var allEmpty = checkAllEmpty && processingFlags[index0] === 0 && processingFlags[index0 + oneRowDown] === 0 && processingFlags[index0 + twoRowsDown] === 0 && processingFlags[index0 + threeRowsDown] === 0 && neighborsSignificance[index0] === 0 && neighborsSignificance[index0 + oneRowDown] === 0 && neighborsSignificance[index0 + twoRowsDown] === 0 && neighborsSignificance[index0 + threeRowsDown] === 0;
                            var i1 = 0, index = index0;
                            var i = i0, sign;
                            if (allEmpty) {
                                var hasSignificantCoefficent = decoder.readBit(contexts, RUNLENGTH_CONTEXT);
                                if (!hasSignificantCoefficent) {
                                    bitsDecoded[index0]++;
                                    bitsDecoded[index0 + oneRowDown]++;
                                    bitsDecoded[index0 + twoRowsDown]++;
                                    bitsDecoded[index0 + threeRowsDown]++;
                                    continue;
                                }
                                i1 = decoder.readBit(contexts, UNIFORM_CONTEXT) << 1 | decoder.readBit(contexts, UNIFORM_CONTEXT);
                                if (i1 !== 0) {
                                    i = i0 + i1;
                                    index += i1 * width;
                                }
                                sign = this.decodeSignBit(i, j, index);
                                coefficentsSign[index] = sign;
                                coefficentsMagnitude[index] = 1;
                                this.setNeighborsSignificance(i, j, index);
                                processingFlags[index] |= firstMagnitudeBitMask;
                                index = index0;
                                for (var i2 = i0; i2 <= i; i2++, index += width) {
                                    bitsDecoded[index]++;
                                }
                                i1++;
                            }
                            for (i = i0 + i1; i < iNext; i++, index += width) {
                                if (coefficentsMagnitude[index] || (processingFlags[index] & processedMask) !== 0) {
                                    continue;
                                }
                                var contextLabel = labels[neighborsSignificance[index]];
                                var decision = decoder.readBit(contexts, contextLabel);
                                if (decision === 1) {
                                    sign = this.decodeSignBit(i, j, index);
                                    coefficentsSign[index] = sign;
                                    coefficentsMagnitude[index] = 1;
                                    this.setNeighborsSignificance(i, j, index);
                                    processingFlags[index] |= firstMagnitudeBitMask;
                                }
                                bitsDecoded[index]++;
                            }
                        }
                    }
                },
                checkSegmentationSymbol: function BitModel_checkSegmentationSymbol() {
                    var decoder = this.decoder;
                    var contexts = this.contexts;
                    var symbol = decoder.readBit(contexts, UNIFORM_CONTEXT) << 3 | decoder.readBit(contexts, UNIFORM_CONTEXT) << 2 | decoder.readBit(contexts, UNIFORM_CONTEXT) << 1 | decoder.readBit(contexts, UNIFORM_CONTEXT);
                    if (symbol !== 10) {
                        throw new Error("JPX Error: Invalid segmentation symbol");
                    }
                }
            };
            return BitModel;
        }();
        var Transform = function TransformClosure() {
            function Transform() {}
            Transform.prototype.calculate = function transformCalculate(subbands, u0, v0) {
                var ll = subbands[0];
                for (var i = 1, ii = subbands.length; i < ii; i++) {
                    ll = this.iterate(ll, subbands[i], u0, v0);
                }
                return ll;
            };
            Transform.prototype.extend = function extend(buffer, offset, size) {
                var i1 = offset - 1, j1 = offset + 1;
                var i2 = offset + size - 2, j2 = offset + size;
                buffer[i1--] = buffer[j1++];
                buffer[j2++] = buffer[i2--];
                buffer[i1--] = buffer[j1++];
                buffer[j2++] = buffer[i2--];
                buffer[i1--] = buffer[j1++];
                buffer[j2++] = buffer[i2--];
                buffer[i1] = buffer[j1];
                buffer[j2] = buffer[i2];
            };
            Transform.prototype.iterate = function Transform_iterate(ll, hl_lh_hh, u0, v0) {
                var llWidth = ll.width, llHeight = ll.height, llItems = ll.items;
                var width = hl_lh_hh.width;
                var height = hl_lh_hh.height;
                var items = hl_lh_hh.items;
                var i, j, k, l, u, v;
                for (k = 0, i = 0; i < llHeight; i++) {
                    l = i * 2 * width;
                    for (j = 0; j < llWidth; j++, k++, l += 2) {
                        items[l] = llItems[k];
                    }
                }
                llItems = ll.items = null;
                var bufferPadding = 4;
                var rowBuffer = new Float32Array(width + 2 * bufferPadding);
                if (width === 1) {
                    if ((u0 & 1) !== 0) {
                        for (v = 0, k = 0; v < height; v++, k += width) {
                            items[k] *= .5;
                        }
                    }
                } else {
                    for (v = 0, k = 0; v < height; v++, k += width) {
                        rowBuffer.set(items.subarray(k, k + width), bufferPadding);
                        this.extend(rowBuffer, bufferPadding, width);
                        this.filter(rowBuffer, bufferPadding, width);
                        items.set(rowBuffer.subarray(bufferPadding, bufferPadding + width), k);
                    }
                }
                var numBuffers = 16;
                var colBuffers = [];
                for (i = 0; i < numBuffers; i++) {
                    colBuffers.push(new Float32Array(height + 2 * bufferPadding));
                }
                var b, currentBuffer = 0;
                ll = bufferPadding + height;
                if (height === 1) {
                    if ((v0 & 1) !== 0) {
                        for (u = 0; u < width; u++) {
                            items[u] *= .5;
                        }
                    }
                } else {
                    for (u = 0; u < width; u++) {
                        if (currentBuffer === 0) {
                            numBuffers = Math.min(width - u, numBuffers);
                            for (k = u, l = bufferPadding; l < ll; k += width, l++) {
                                for (b = 0; b < numBuffers; b++) {
                                    colBuffers[b][l] = items[k + b];
                                }
                            }
                            currentBuffer = numBuffers;
                        }
                        currentBuffer--;
                        var buffer = colBuffers[currentBuffer];
                        this.extend(buffer, bufferPadding, height);
                        this.filter(buffer, bufferPadding, height);
                        if (currentBuffer === 0) {
                            k = u - numBuffers + 1;
                            for (l = bufferPadding; l < ll; k += width, l++) {
                                for (b = 0; b < numBuffers; b++) {
                                    items[k + b] = colBuffers[b][l];
                                }
                            }
                        }
                    }
                }
                return {
                    width: width,
                    height: height,
                    items: items
                };
            };
            return Transform;
        }();
        var IrreversibleTransform = function IrreversibleTransformClosure() {
            function IrreversibleTransform() {
                Transform.call(this);
            }
            IrreversibleTransform.prototype = Object.create(Transform.prototype);
            IrreversibleTransform.prototype.filter = function irreversibleTransformFilter(x, offset, length) {
                var len = length >> 1;
                offset = offset | 0;
                var j, n, current, next;
                var alpha = -1.586134342059924;
                var beta = -.052980118572961;
                var gamma = .882911075530934;
                var delta = .443506852043971;
                var K = 1.230174104914001;
                var K_ = 1 / K;
                j = offset - 3;
                for (n = len + 4; n--; j += 2) {
                    x[j] *= K_;
                }
                j = offset - 2;
                current = delta * x[j - 1];
                for (n = len + 3; n--; j += 2) {
                    next = delta * x[j + 1];
                    x[j] = K * x[j] - current - next;
                    if (n--) {
                        j += 2;
                        current = delta * x[j + 1];
                        x[j] = K * x[j] - current - next;
                    } else {
                        break;
                    }
                }
                j = offset - 1;
                current = gamma * x[j - 1];
                for (n = len + 2; n--; j += 2) {
                    next = gamma * x[j + 1];
                    x[j] -= current + next;
                    if (n--) {
                        j += 2;
                        current = gamma * x[j + 1];
                        x[j] -= current + next;
                    } else {
                        break;
                    }
                }
                j = offset;
                current = beta * x[j - 1];
                for (n = len + 1; n--; j += 2) {
                    next = beta * x[j + 1];
                    x[j] -= current + next;
                    if (n--) {
                        j += 2;
                        current = beta * x[j + 1];
                        x[j] -= current + next;
                    } else {
                        break;
                    }
                }
                if (len !== 0) {
                    j = offset + 1;
                    current = alpha * x[j - 1];
                    for (n = len; n--; j += 2) {
                        next = alpha * x[j + 1];
                        x[j] -= current + next;
                        if (n--) {
                            j += 2;
                            current = alpha * x[j + 1];
                            x[j] -= current + next;
                        } else {
                            break;
                        }
                    }
                }
            };
            return IrreversibleTransform;
        }();
        var ReversibleTransform = function ReversibleTransformClosure() {
            function ReversibleTransform() {
                Transform.call(this);
            }
            ReversibleTransform.prototype = Object.create(Transform.prototype);
            ReversibleTransform.prototype.filter = function reversibleTransformFilter(x, offset, length) {
                var len = length >> 1;
                offset = offset | 0;
                var j, n;
                for (j = offset, n = len + 1; n--; j += 2) {
                    x[j] -= x[j - 1] + x[j + 1] + 2 >> 2;
                }
                for (j = offset + 1, n = len; n--; j += 2) {
                    x[j] += x[j - 1] + x[j + 1] >> 1;
                }
            };
            return ReversibleTransform;
        }();
        return JpxImage;
    }();
    "use strict";
    var Jbig2Image = function Jbig2ImageClosure() {
        function ContextCache() {}
        ContextCache.prototype = {
            getContexts: function(id) {
                if (id in this) {
                    return this[id];
                }
                return this[id] = new Int8Array(1 << 16);
            }
        };
        function DecodingContext(data, start, end) {
            this.data = data;
            this.start = start;
            this.end = end;
        }
        DecodingContext.prototype = {
            get decoder() {
                var decoder = new ArithmeticDecoder(this.data, this.start, this.end);
                return shadow(this, "decoder", decoder);
            },
            get contextCache() {
                var cache = new ContextCache();
                return shadow(this, "contextCache", cache);
            }
        };
        function decodeInteger(contextCache, procedure, decoder) {
            var contexts = contextCache.getContexts(procedure);
            var prev = 1;
            function readBits(length) {
                var v = 0;
                for (var i = 0; i < length; i++) {
                    var bit = decoder.readBit(contexts, prev);
                    prev = prev < 256 ? prev << 1 | bit : (prev << 1 | bit) & 511 | 256;
                    v = v << 1 | bit;
                }
                return v >>> 0;
            }
            var sign = readBits(1);
            var value = readBits(1) ? readBits(1) ? readBits(1) ? readBits(1) ? readBits(1) ? readBits(32) + 4436 : readBits(12) + 340 : readBits(8) + 84 : readBits(6) + 20 : readBits(4) + 4 : readBits(2);
            return sign === 0 ? value : value > 0 ? -value : null;
        }
        function decodeIAID(contextCache, decoder, codeLength) {
            var contexts = contextCache.getContexts("IAID");
            var prev = 1;
            for (var i = 0; i < codeLength; i++) {
                var bit = decoder.readBit(contexts, prev);
                prev = prev << 1 | bit;
            }
            if (codeLength < 31) {
                return prev & (1 << codeLength) - 1;
            }
            return prev & 2147483647;
        }
        var SegmentTypes = [ "SymbolDictionary", null, null, null, "IntermediateTextRegion", null, "ImmediateTextRegion", "ImmediateLosslessTextRegion", null, null, null, null, null, null, null, null, "patternDictionary", null, null, null, "IntermediateHalftoneRegion", null, "ImmediateHalftoneRegion", "ImmediateLosslessHalftoneRegion", null, null, null, null, null, null, null, null, null, null, null, null, "IntermediateGenericRegion", null, "ImmediateGenericRegion", "ImmediateLosslessGenericRegion", "IntermediateGenericRefinementRegion", null, "ImmediateGenericRefinementRegion", "ImmediateLosslessGenericRefinementRegion", null, null, null, null, "PageInformation", "EndOfPage", "EndOfStripe", "EndOfFile", "Profiles", "Tables", null, null, null, null, null, null, null, null, "Extension" ];
        var CodingTemplates = [ [ {
            x: -1,
            y: -2
        }, {
            x: 0,
            y: -2
        }, {
            x: 1,
            y: -2
        }, {
            x: -2,
            y: -1
        }, {
            x: -1,
            y: -1
        }, {
            x: 0,
            y: -1
        }, {
            x: 1,
            y: -1
        }, {
            x: 2,
            y: -1
        }, {
            x: -4,
            y: 0
        }, {
            x: -3,
            y: 0
        }, {
            x: -2,
            y: 0
        }, {
            x: -1,
            y: 0
        } ], [ {
            x: -1,
            y: -2
        }, {
            x: 0,
            y: -2
        }, {
            x: 1,
            y: -2
        }, {
            x: 2,
            y: -2
        }, {
            x: -2,
            y: -1
        }, {
            x: -1,
            y: -1
        }, {
            x: 0,
            y: -1
        }, {
            x: 1,
            y: -1
        }, {
            x: 2,
            y: -1
        }, {
            x: -3,
            y: 0
        }, {
            x: -2,
            y: 0
        }, {
            x: -1,
            y: 0
        } ], [ {
            x: -1,
            y: -2
        }, {
            x: 0,
            y: -2
        }, {
            x: 1,
            y: -2
        }, {
            x: -2,
            y: -1
        }, {
            x: -1,
            y: -1
        }, {
            x: 0,
            y: -1
        }, {
            x: 1,
            y: -1
        }, {
            x: -2,
            y: 0
        }, {
            x: -1,
            y: 0
        } ], [ {
            x: -3,
            y: -1
        }, {
            x: -2,
            y: -1
        }, {
            x: -1,
            y: -1
        }, {
            x: 0,
            y: -1
        }, {
            x: 1,
            y: -1
        }, {
            x: -4,
            y: 0
        }, {
            x: -3,
            y: 0
        }, {
            x: -2,
            y: 0
        }, {
            x: -1,
            y: 0
        } ] ];
        var RefinementTemplates = [ {
            coding: [ {
                x: 0,
                y: -1
            }, {
                x: 1,
                y: -1
            }, {
                x: -1,
                y: 0
            } ],
            reference: [ {
                x: 0,
                y: -1
            }, {
                x: 1,
                y: -1
            }, {
                x: -1,
                y: 0
            }, {
                x: 0,
                y: 0
            }, {
                x: 1,
                y: 0
            }, {
                x: -1,
                y: 1
            }, {
                x: 0,
                y: 1
            }, {
                x: 1,
                y: 1
            } ]
        }, {
            coding: [ {
                x: -1,
                y: -1
            }, {
                x: 0,
                y: -1
            }, {
                x: 1,
                y: -1
            }, {
                x: -1,
                y: 0
            } ],
            reference: [ {
                x: 0,
                y: -1
            }, {
                x: -1,
                y: 0
            }, {
                x: 0,
                y: 0
            }, {
                x: 1,
                y: 0
            }, {
                x: 0,
                y: 1
            }, {
                x: 1,
                y: 1
            } ]
        } ];
        var ReusedContexts = [ 39717, 1941, 229, 405 ];
        var RefinementReusedContexts = [ 32, 8 ];
        function decodeBitmapTemplate0(width, height, decodingContext) {
            var decoder = decodingContext.decoder;
            var contexts = decodingContext.contextCache.getContexts("GB");
            var contextLabel, i, j, pixel, row, row1, row2, bitmap = [];
            var OLD_PIXEL_MASK = 31735;
            for (i = 0; i < height; i++) {
                row = bitmap[i] = new Uint8Array(width);
                row1 = i < 1 ? row : bitmap[i - 1];
                row2 = i < 2 ? row : bitmap[i - 2];
                contextLabel = row2[0] << 13 | row2[1] << 12 | row2[2] << 11 | row1[0] << 7 | row1[1] << 6 | row1[2] << 5 | row1[3] << 4;
                for (j = 0; j < width; j++) {
                    row[j] = pixel = decoder.readBit(contexts, contextLabel);
                    contextLabel = (contextLabel & OLD_PIXEL_MASK) << 1 | (j + 3 < width ? row2[j + 3] << 11 : 0) | (j + 4 < width ? row1[j + 4] << 4 : 0) | pixel;
                }
            }
            return bitmap;
        }
        function decodeBitmap(mmr, width, height, templateIndex, prediction, skip, at, decodingContext) {
            if (mmr) {
                error("JBIG2 error: MMR encoding is not supported");
            }
            if (templateIndex === 0 && !skip && !prediction && at.length === 4 && at[0].x === 3 && at[0].y === -1 && at[1].x === -3 && at[1].y === -1 && at[2].x === 2 && at[2].y === -2 && at[3].x === -2 && at[3].y === -2) {
                return decodeBitmapTemplate0(width, height, decodingContext);
            }
            var useskip = !!skip;
            var template = CodingTemplates[templateIndex].concat(at);
            template.sort(function(a, b) {
                return a.y - b.y || a.x - b.x;
            });
            var templateLength = template.length;
            var templateX = new Int8Array(templateLength);
            var templateY = new Int8Array(templateLength);
            var changingTemplateEntries = [];
            var reuseMask = 0, minX = 0, maxX = 0, minY = 0;
            var c, k;
            for (k = 0; k < templateLength; k++) {
                templateX[k] = template[k].x;
                templateY[k] = template[k].y;
                minX = Math.min(minX, template[k].x);
                maxX = Math.max(maxX, template[k].x);
                minY = Math.min(minY, template[k].y);
                if (k < templateLength - 1 && template[k].y === template[k + 1].y && template[k].x === template[k + 1].x - 1) {
                    reuseMask |= 1 << templateLength - 1 - k;
                } else {
                    changingTemplateEntries.push(k);
                }
            }
            var changingEntriesLength = changingTemplateEntries.length;
            var changingTemplateX = new Int8Array(changingEntriesLength);
            var changingTemplateY = new Int8Array(changingEntriesLength);
            var changingTemplateBit = new Uint16Array(changingEntriesLength);
            for (c = 0; c < changingEntriesLength; c++) {
                k = changingTemplateEntries[c];
                changingTemplateX[c] = template[k].x;
                changingTemplateY[c] = template[k].y;
                changingTemplateBit[c] = 1 << templateLength - 1 - k;
            }
            var sbb_left = -minX;
            var sbb_top = -minY;
            var sbb_right = width - maxX;
            var pseudoPixelContext = ReusedContexts[templateIndex];
            var row = new Uint8Array(width);
            var bitmap = [];
            var decoder = decodingContext.decoder;
            var contexts = decodingContext.contextCache.getContexts("GB");
            var ltp = 0, j, i0, j0, contextLabel = 0, bit, shift;
            for (var i = 0; i < height; i++) {
                if (prediction) {
                    var sltp = decoder.readBit(contexts, pseudoPixelContext);
                    ltp ^= sltp;
                    if (ltp) {
                        bitmap.push(row);
                        continue;
                    }
                }
                row = new Uint8Array(row);
                bitmap.push(row);
                for (j = 0; j < width; j++) {
                    if (useskip && skip[i][j]) {
                        row[j] = 0;
                        continue;
                    }
                    if (j >= sbb_left && j < sbb_right && i >= sbb_top) {
                        contextLabel = contextLabel << 1 & reuseMask;
                        for (k = 0; k < changingEntriesLength; k++) {
                            i0 = i + changingTemplateY[k];
                            j0 = j + changingTemplateX[k];
                            bit = bitmap[i0][j0];
                            if (bit) {
                                bit = changingTemplateBit[k];
                                contextLabel |= bit;
                            }
                        }
                    } else {
                        contextLabel = 0;
                        shift = templateLength - 1;
                        for (k = 0; k < templateLength; k++, shift--) {
                            j0 = j + templateX[k];
                            if (j0 >= 0 && j0 < width) {
                                i0 = i + templateY[k];
                                if (i0 >= 0) {
                                    bit = bitmap[i0][j0];
                                    if (bit) {
                                        contextLabel |= bit << shift;
                                    }
                                }
                            }
                        }
                    }
                    var pixel = decoder.readBit(contexts, contextLabel);
                    row[j] = pixel;
                }
            }
            return bitmap;
        }
        function decodeRefinement(width, height, templateIndex, referenceBitmap, offsetX, offsetY, prediction, at, decodingContext) {
            var codingTemplate = RefinementTemplates[templateIndex].coding;
            if (templateIndex === 0) {
                codingTemplate = codingTemplate.concat([ at[0] ]);
            }
            var codingTemplateLength = codingTemplate.length;
            var codingTemplateX = new Int32Array(codingTemplateLength);
            var codingTemplateY = new Int32Array(codingTemplateLength);
            var k;
            for (k = 0; k < codingTemplateLength; k++) {
                codingTemplateX[k] = codingTemplate[k].x;
                codingTemplateY[k] = codingTemplate[k].y;
            }
            var referenceTemplate = RefinementTemplates[templateIndex].reference;
            if (templateIndex === 0) {
                referenceTemplate = referenceTemplate.concat([ at[1] ]);
            }
            var referenceTemplateLength = referenceTemplate.length;
            var referenceTemplateX = new Int32Array(referenceTemplateLength);
            var referenceTemplateY = new Int32Array(referenceTemplateLength);
            for (k = 0; k < referenceTemplateLength; k++) {
                referenceTemplateX[k] = referenceTemplate[k].x;
                referenceTemplateY[k] = referenceTemplate[k].y;
            }
            var referenceWidth = referenceBitmap[0].length;
            var referenceHeight = referenceBitmap.length;
            var pseudoPixelContext = RefinementReusedContexts[templateIndex];
            var bitmap = [];
            var decoder = decodingContext.decoder;
            var contexts = decodingContext.contextCache.getContexts("GR");
            var ltp = 0;
            for (var i = 0; i < height; i++) {
                if (prediction) {
                    var sltp = decoder.readBit(contexts, pseudoPixelContext);
                    ltp ^= sltp;
                    if (ltp) {
                        error("JBIG2 error: prediction is not supported");
                    }
                }
                var row = new Uint8Array(width);
                bitmap.push(row);
                for (var j = 0; j < width; j++) {
                    var i0, j0;
                    var contextLabel = 0;
                    for (k = 0; k < codingTemplateLength; k++) {
                        i0 = i + codingTemplateY[k];
                        j0 = j + codingTemplateX[k];
                        if (i0 < 0 || j0 < 0 || j0 >= width) {
                            contextLabel <<= 1;
                        } else {
                            contextLabel = contextLabel << 1 | bitmap[i0][j0];
                        }
                    }
                    for (k = 0; k < referenceTemplateLength; k++) {
                        i0 = i + referenceTemplateY[k] + offsetY;
                        j0 = j + referenceTemplateX[k] + offsetX;
                        if (i0 < 0 || i0 >= referenceHeight || j0 < 0 || j0 >= referenceWidth) {
                            contextLabel <<= 1;
                        } else {
                            contextLabel = contextLabel << 1 | referenceBitmap[i0][j0];
                        }
                    }
                    var pixel = decoder.readBit(contexts, contextLabel);
                    row[j] = pixel;
                }
            }
            return bitmap;
        }
        function decodeSymbolDictionary(huffman, refinement, symbols, numberOfNewSymbols, numberOfExportedSymbols, huffmanTables, templateIndex, at, refinementTemplateIndex, refinementAt, decodingContext) {
            if (huffman) {
                error("JBIG2 error: huffman is not supported");
            }
            var newSymbols = [];
            var currentHeight = 0;
            var symbolCodeLength = log2(symbols.length + numberOfNewSymbols);
            var decoder = decodingContext.decoder;
            var contextCache = decodingContext.contextCache;
            while (newSymbols.length < numberOfNewSymbols) {
                var deltaHeight = decodeInteger(contextCache, "IADH", decoder);
                currentHeight += deltaHeight;
                var currentWidth = 0;
                var totalWidth = 0;
                while (true) {
                    var deltaWidth = decodeInteger(contextCache, "IADW", decoder);
                    if (deltaWidth === null) {
                        break;
                    }
                    currentWidth += deltaWidth;
                    totalWidth += currentWidth;
                    var bitmap;
                    if (refinement) {
                        var numberOfInstances = decodeInteger(contextCache, "IAAI", decoder);
                        if (numberOfInstances > 1) {
                            bitmap = decodeTextRegion(huffman, refinement, currentWidth, currentHeight, 0, numberOfInstances, 1, symbols.concat(newSymbols), symbolCodeLength, 0, 0, 1, 0, huffmanTables, refinementTemplateIndex, refinementAt, decodingContext);
                        } else {
                            var symbolId = decodeIAID(contextCache, decoder, symbolCodeLength);
                            var rdx = decodeInteger(contextCache, "IARDX", decoder);
                            var rdy = decodeInteger(contextCache, "IARDY", decoder);
                            var symbol = symbolId < symbols.length ? symbols[symbolId] : newSymbols[symbolId - symbols.length];
                            bitmap = decodeRefinement(currentWidth, currentHeight, refinementTemplateIndex, symbol, rdx, rdy, false, refinementAt, decodingContext);
                        }
                    } else {
                        bitmap = decodeBitmap(false, currentWidth, currentHeight, templateIndex, false, null, at, decodingContext);
                    }
                    newSymbols.push(bitmap);
                }
            }
            var exportedSymbols = [];
            var flags = [], currentFlag = false;
            var totalSymbolsLength = symbols.length + numberOfNewSymbols;
            while (flags.length < totalSymbolsLength) {
                var runLength = decodeInteger(contextCache, "IAEX", decoder);
                while (runLength--) {
                    flags.push(currentFlag);
                }
                currentFlag = !currentFlag;
            }
            for (var i = 0, ii = symbols.length; i < ii; i++) {
                if (flags[i]) {
                    exportedSymbols.push(symbols[i]);
                }
            }
            for (var j = 0; j < numberOfNewSymbols; i++, j++) {
                if (flags[i]) {
                    exportedSymbols.push(newSymbols[j]);
                }
            }
            return exportedSymbols;
        }
        function decodeTextRegion(huffman, refinement, width, height, defaultPixelValue, numberOfSymbolInstances, stripSize, inputSymbols, symbolCodeLength, transposed, dsOffset, referenceCorner, combinationOperator, huffmanTables, refinementTemplateIndex, refinementAt, decodingContext) {
            if (huffman) {
                error("JBIG2 error: huffman is not supported");
            }
            var bitmap = [];
            var i, row;
            for (i = 0; i < height; i++) {
                row = new Uint8Array(width);
                if (defaultPixelValue) {
                    for (var j = 0; j < width; j++) {
                        row[j] = defaultPixelValue;
                    }
                }
                bitmap.push(row);
            }
            var decoder = decodingContext.decoder;
            var contextCache = decodingContext.contextCache;
            var stripT = -decodeInteger(contextCache, "IADT", decoder);
            var firstS = 0;
            i = 0;
            while (i < numberOfSymbolInstances) {
                var deltaT = decodeInteger(contextCache, "IADT", decoder);
                stripT += deltaT;
                var deltaFirstS = decodeInteger(contextCache, "IAFS", decoder);
                firstS += deltaFirstS;
                var currentS = firstS;
                do {
                    var currentT = stripSize === 1 ? 0 : decodeInteger(contextCache, "IAIT", decoder);
                    var t = stripSize * stripT + currentT;
                    var symbolId = decodeIAID(contextCache, decoder, symbolCodeLength);
                    var applyRefinement = refinement && decodeInteger(contextCache, "IARI", decoder);
                    var symbolBitmap = inputSymbols[symbolId];
                    var symbolWidth = symbolBitmap[0].length;
                    var symbolHeight = symbolBitmap.length;
                    if (applyRefinement) {
                        var rdw = decodeInteger(contextCache, "IARDW", decoder);
                        var rdh = decodeInteger(contextCache, "IARDH", decoder);
                        var rdx = decodeInteger(contextCache, "IARDX", decoder);
                        var rdy = decodeInteger(contextCache, "IARDY", decoder);
                        symbolWidth += rdw;
                        symbolHeight += rdh;
                        symbolBitmap = decodeRefinement(symbolWidth, symbolHeight, refinementTemplateIndex, symbolBitmap, (rdw >> 1) + rdx, (rdh >> 1) + rdy, false, refinementAt, decodingContext);
                    }
                    var offsetT = t - (referenceCorner & 1 ? 0 : symbolHeight);
                    var offsetS = currentS - (referenceCorner & 2 ? symbolWidth : 0);
                    var s2, t2, symbolRow;
                    if (transposed) {
                        for (s2 = 0; s2 < symbolHeight; s2++) {
                            row = bitmap[offsetS + s2];
                            if (!row) {
                                continue;
                            }
                            symbolRow = symbolBitmap[s2];
                            var maxWidth = Math.min(width - offsetT, symbolWidth);
                            switch (combinationOperator) {
                              case 0:
                                for (t2 = 0; t2 < maxWidth; t2++) {
                                    row[offsetT + t2] |= symbolRow[t2];
                                }
                                break;

                              case 2:
                                for (t2 = 0; t2 < maxWidth; t2++) {
                                    row[offsetT + t2] ^= symbolRow[t2];
                                }
                                break;

                              default:
                                error("JBIG2 error: operator " + combinationOperator + " is not supported");
                            }
                        }
                        currentS += symbolHeight - 1;
                    } else {
                        for (t2 = 0; t2 < symbolHeight; t2++) {
                            row = bitmap[offsetT + t2];
                            if (!row) {
                                continue;
                            }
                            symbolRow = symbolBitmap[t2];
                            switch (combinationOperator) {
                              case 0:
                                for (s2 = 0; s2 < symbolWidth; s2++) {
                                    row[offsetS + s2] |= symbolRow[s2];
                                }
                                break;

                              case 2:
                                for (s2 = 0; s2 < symbolWidth; s2++) {
                                    row[offsetS + s2] ^= symbolRow[s2];
                                }
                                break;

                              default:
                                error("JBIG2 error: operator " + combinationOperator + " is not supported");
                            }
                        }
                        currentS += symbolWidth - 1;
                    }
                    i++;
                    var deltaS = decodeInteger(contextCache, "IADS", decoder);
                    if (deltaS === null) {
                        break;
                    }
                    currentS += deltaS + dsOffset;
                } while (true);
            }
            return bitmap;
        }
        function readSegmentHeader(data, start) {
            var segmentHeader = {};
            segmentHeader.number = readUint32(data, start);
            var flags = data[start + 4];
            var segmentType = flags & 63;
            if (!SegmentTypes[segmentType]) {
                error("JBIG2 error: invalid segment type: " + segmentType);
            }
            segmentHeader.type = segmentType;
            segmentHeader.typeName = SegmentTypes[segmentType];
            segmentHeader.deferredNonRetain = !!(flags & 128);
            var pageAssociationFieldSize = !!(flags & 64);
            var referredFlags = data[start + 5];
            var referredToCount = referredFlags >> 5 & 7;
            var retainBits = [ referredFlags & 31 ];
            var position = start + 6;
            if (referredFlags === 7) {
                referredToCount = readUint32(data, position - 1) & 536870911;
                position += 3;
                var bytes = referredToCount + 7 >> 3;
                retainBits[0] = data[position++];
                while (--bytes > 0) {
                    retainBits.push(data[position++]);
                }
            } else if (referredFlags === 5 || referredFlags === 6) {
                error("JBIG2 error: invalid referred-to flags");
            }
            segmentHeader.retainBits = retainBits;
            var referredToSegmentNumberSize = segmentHeader.number <= 256 ? 1 : segmentHeader.number <= 65536 ? 2 : 4;
            var referredTo = [];
            var i, ii;
            for (i = 0; i < referredToCount; i++) {
                var number = referredToSegmentNumberSize === 1 ? data[position] : referredToSegmentNumberSize === 2 ? readUint16(data, position) : readUint32(data, position);
                referredTo.push(number);
                position += referredToSegmentNumberSize;
            }
            segmentHeader.referredTo = referredTo;
            if (!pageAssociationFieldSize) {
                segmentHeader.pageAssociation = data[position++];
            } else {
                segmentHeader.pageAssociation = readUint32(data, position);
                position += 4;
            }
            segmentHeader.length = readUint32(data, position);
            position += 4;
            if (segmentHeader.length === 4294967295) {
                if (segmentType === 38) {
                    var genericRegionInfo = readRegionSegmentInformation(data, position);
                    var genericRegionSegmentFlags = data[position + RegionSegmentInformationFieldLength];
                    var genericRegionMmr = !!(genericRegionSegmentFlags & 1);
                    var searchPatternLength = 6;
                    var searchPattern = new Uint8Array(searchPatternLength);
                    if (!genericRegionMmr) {
                        searchPattern[0] = 255;
                        searchPattern[1] = 172;
                    }
                    searchPattern[2] = genericRegionInfo.height >>> 24 & 255;
                    searchPattern[3] = genericRegionInfo.height >> 16 & 255;
                    searchPattern[4] = genericRegionInfo.height >> 8 & 255;
                    searchPattern[5] = genericRegionInfo.height & 255;
                    for (i = position, ii = data.length; i < ii; i++) {
                        var j = 0;
                        while (j < searchPatternLength && searchPattern[j] === data[i + j]) {
                            j++;
                        }
                        if (j === searchPatternLength) {
                            segmentHeader.length = i + searchPatternLength;
                            break;
                        }
                    }
                    if (segmentHeader.length === 4294967295) {
                        error("JBIG2 error: segment end was not found");
                    }
                } else {
                    error("JBIG2 error: invalid unknown segment length");
                }
            }
            segmentHeader.headerEnd = position;
            return segmentHeader;
        }
        function readSegments(header, data, start, end) {
            var segments = [];
            var position = start;
            while (position < end) {
                var segmentHeader = readSegmentHeader(data, position);
                position = segmentHeader.headerEnd;
                var segment = {
                    header: segmentHeader,
                    data: data
                };
                if (!header.randomAccess) {
                    segment.start = position;
                    position += segmentHeader.length;
                    segment.end = position;
                }
                segments.push(segment);
                if (segmentHeader.type === 51) {
                    break;
                }
            }
            if (header.randomAccess) {
                for (var i = 0, ii = segments.length; i < ii; i++) {
                    segments[i].start = position;
                    position += segments[i].header.length;
                    segments[i].end = position;
                }
            }
            return segments;
        }
        function readRegionSegmentInformation(data, start) {
            return {
                width: readUint32(data, start),
                height: readUint32(data, start + 4),
                x: readUint32(data, start + 8),
                y: readUint32(data, start + 12),
                combinationOperator: data[start + 16] & 7
            };
        }
        var RegionSegmentInformationFieldLength = 17;
        function processSegment(segment, visitor) {
            var header = segment.header;
            var data = segment.data, position = segment.start, end = segment.end;
            var args, at, i, atLength;
            switch (header.type) {
              case 0:
                var dictionary = {};
                var dictionaryFlags = readUint16(data, position);
                dictionary.huffman = !!(dictionaryFlags & 1);
                dictionary.refinement = !!(dictionaryFlags & 2);
                dictionary.huffmanDHSelector = dictionaryFlags >> 2 & 3;
                dictionary.huffmanDWSelector = dictionaryFlags >> 4 & 3;
                dictionary.bitmapSizeSelector = dictionaryFlags >> 6 & 1;
                dictionary.aggregationInstancesSelector = dictionaryFlags >> 7 & 1;
                dictionary.bitmapCodingContextUsed = !!(dictionaryFlags & 256);
                dictionary.bitmapCodingContextRetained = !!(dictionaryFlags & 512);
                dictionary.template = dictionaryFlags >> 10 & 3;
                dictionary.refinementTemplate = dictionaryFlags >> 12 & 1;
                position += 2;
                if (!dictionary.huffman) {
                    atLength = dictionary.template === 0 ? 4 : 1;
                    at = [];
                    for (i = 0; i < atLength; i++) {
                        at.push({
                            x: readInt8(data, position),
                            y: readInt8(data, position + 1)
                        });
                        position += 2;
                    }
                    dictionary.at = at;
                }
                if (dictionary.refinement && !dictionary.refinementTemplate) {
                    at = [];
                    for (i = 0; i < 2; i++) {
                        at.push({
                            x: readInt8(data, position),
                            y: readInt8(data, position + 1)
                        });
                        position += 2;
                    }
                    dictionary.refinementAt = at;
                }
                dictionary.numberOfExportedSymbols = readUint32(data, position);
                position += 4;
                dictionary.numberOfNewSymbols = readUint32(data, position);
                position += 4;
                args = [ dictionary, header.number, header.referredTo, data, position, end ];
                break;

              case 6:
              case 7:
                var textRegion = {};
                textRegion.info = readRegionSegmentInformation(data, position);
                position += RegionSegmentInformationFieldLength;
                var textRegionSegmentFlags = readUint16(data, position);
                position += 2;
                textRegion.huffman = !!(textRegionSegmentFlags & 1);
                textRegion.refinement = !!(textRegionSegmentFlags & 2);
                textRegion.stripSize = 1 << (textRegionSegmentFlags >> 2 & 3);
                textRegion.referenceCorner = textRegionSegmentFlags >> 4 & 3;
                textRegion.transposed = !!(textRegionSegmentFlags & 64);
                textRegion.combinationOperator = textRegionSegmentFlags >> 7 & 3;
                textRegion.defaultPixelValue = textRegionSegmentFlags >> 9 & 1;
                textRegion.dsOffset = textRegionSegmentFlags << 17 >> 27;
                textRegion.refinementTemplate = textRegionSegmentFlags >> 15 & 1;
                if (textRegion.huffman) {
                    var textRegionHuffmanFlags = readUint16(data, position);
                    position += 2;
                    textRegion.huffmanFS = textRegionHuffmanFlags & 3;
                    textRegion.huffmanDS = textRegionHuffmanFlags >> 2 & 3;
                    textRegion.huffmanDT = textRegionHuffmanFlags >> 4 & 3;
                    textRegion.huffmanRefinementDW = textRegionHuffmanFlags >> 6 & 3;
                    textRegion.huffmanRefinementDH = textRegionHuffmanFlags >> 8 & 3;
                    textRegion.huffmanRefinementDX = textRegionHuffmanFlags >> 10 & 3;
                    textRegion.huffmanRefinementDY = textRegionHuffmanFlags >> 12 & 3;
                    textRegion.huffmanRefinementSizeSelector = !!(textRegionHuffmanFlags & 14);
                }
                if (textRegion.refinement && !textRegion.refinementTemplate) {
                    at = [];
                    for (i = 0; i < 2; i++) {
                        at.push({
                            x: readInt8(data, position),
                            y: readInt8(data, position + 1)
                        });
                        position += 2;
                    }
                    textRegion.refinementAt = at;
                }
                textRegion.numberOfSymbolInstances = readUint32(data, position);
                position += 4;
                if (textRegion.huffman) {
                    error("JBIG2 error: huffman is not supported");
                }
                args = [ textRegion, header.referredTo, data, position, end ];
                break;

              case 38:
              case 39:
                var genericRegion = {};
                genericRegion.info = readRegionSegmentInformation(data, position);
                position += RegionSegmentInformationFieldLength;
                var genericRegionSegmentFlags = data[position++];
                genericRegion.mmr = !!(genericRegionSegmentFlags & 1);
                genericRegion.template = genericRegionSegmentFlags >> 1 & 3;
                genericRegion.prediction = !!(genericRegionSegmentFlags & 8);
                if (!genericRegion.mmr) {
                    atLength = genericRegion.template === 0 ? 4 : 1;
                    at = [];
                    for (i = 0; i < atLength; i++) {
                        at.push({
                            x: readInt8(data, position),
                            y: readInt8(data, position + 1)
                        });
                        position += 2;
                    }
                    genericRegion.at = at;
                }
                args = [ genericRegion, data, position, end ];
                break;

              case 48:
                var pageInfo = {
                    width: readUint32(data, position),
                    height: readUint32(data, position + 4),
                    resolutionX: readUint32(data, position + 8),
                    resolutionY: readUint32(data, position + 12)
                };
                if (pageInfo.height === 4294967295) {
                    delete pageInfo.height;
                }
                var pageSegmentFlags = data[position + 16];
                var pageStripingInformatiom = readUint16(data, position + 17);
                pageInfo.lossless = !!(pageSegmentFlags & 1);
                pageInfo.refinement = !!(pageSegmentFlags & 2);
                pageInfo.defaultPixelValue = pageSegmentFlags >> 2 & 1;
                pageInfo.combinationOperator = pageSegmentFlags >> 3 & 3;
                pageInfo.requiresBuffer = !!(pageSegmentFlags & 32);
                pageInfo.combinationOperatorOverride = !!(pageSegmentFlags & 64);
                args = [ pageInfo ];
                break;

              case 49:
                break;

              case 50:
                break;

              case 51:
                break;

              case 62:
                break;

              default:
                error("JBIG2 error: segment type " + header.typeName + "(" + header.type + ") is not implemented");
            }
            var callbackName = "on" + header.typeName;
            if (callbackName in visitor) {
                visitor[callbackName].apply(visitor, args);
            }
        }
        function processSegments(segments, visitor) {
            for (var i = 0, ii = segments.length; i < ii; i++) {
                processSegment(segments[i], visitor);
            }
        }
        function parseJbig2(data, start, end) {
            var position = start;
            if (data[position] !== 151 || data[position + 1] !== 74 || data[position + 2] !== 66 || data[position + 3] !== 50 || data[position + 4] !== 13 || data[position + 5] !== 10 || data[position + 6] !== 26 || data[position + 7] !== 10) {
                error("JBIG2 error: invalid header");
            }
            var header = {};
            position += 8;
            var flags = data[position++];
            header.randomAccess = !(flags & 1);
            if (!(flags & 2)) {
                header.numberOfPages = readUint32(data, position);
                position += 4;
            }
            var segments = readSegments(header, data, position, end);
            error("Not implemented");
        }
        function parseJbig2Chunks(chunks) {
            var visitor = new SimpleSegmentVisitor();
            for (var i = 0, ii = chunks.length; i < ii; i++) {
                var chunk = chunks[i];
                var segments = readSegments({}, chunk.data, chunk.start, chunk.end);
                processSegments(segments, visitor);
            }
            return visitor;
        }
        function SimpleSegmentVisitor() {}
        SimpleSegmentVisitor.prototype = {
            onPageInformation: function SimpleSegmentVisitor_onPageInformation(info) {
                this.currentPageInfo = info;
                var rowSize = info.width + 7 >> 3;
                var buffer = new Uint8Array(rowSize * info.height);
                if (info.defaultPixelValue) {
                    for (var i = 0, ii = buffer.length; i < ii; i++) {
                        buffer[i] = 255;
                    }
                }
                this.buffer = buffer;
            },
            drawBitmap: function SimpleSegmentVisitor_drawBitmap(regionInfo, bitmap) {
                var pageInfo = this.currentPageInfo;
                var width = regionInfo.width, height = regionInfo.height;
                var rowSize = pageInfo.width + 7 >> 3;
                var combinationOperator = pageInfo.combinationOperatorOverride ? regionInfo.combinationOperator : pageInfo.combinationOperator;
                var buffer = this.buffer;
                var mask0 = 128 >> (regionInfo.x & 7);
                var offset0 = regionInfo.y * rowSize + (regionInfo.x >> 3);
                var i, j, mask, offset;
                switch (combinationOperator) {
                  case 0:
                    for (i = 0; i < height; i++) {
                        mask = mask0;
                        offset = offset0;
                        for (j = 0; j < width; j++) {
                            if (bitmap[i][j]) {
                                buffer[offset] |= mask;
                            }
                            mask >>= 1;
                            if (!mask) {
                                mask = 128;
                                offset++;
                            }
                        }
                        offset0 += rowSize;
                    }
                    break;

                  case 2:
                    for (i = 0; i < height; i++) {
                        mask = mask0;
                        offset = offset0;
                        for (j = 0; j < width; j++) {
                            if (bitmap[i][j]) {
                                buffer[offset] ^= mask;
                            }
                            mask >>= 1;
                            if (!mask) {
                                mask = 128;
                                offset++;
                            }
                        }
                        offset0 += rowSize;
                    }
                    break;

                  default:
                    error("JBIG2 error: operator " + combinationOperator + " is not supported");
                }
            },
            onImmediateGenericRegion: function SimpleSegmentVisitor_onImmediateGenericRegion(region, data, start, end) {
                var regionInfo = region.info;
                var decodingContext = new DecodingContext(data, start, end);
                var bitmap = decodeBitmap(region.mmr, regionInfo.width, regionInfo.height, region.template, region.prediction, null, region.at, decodingContext);
                this.drawBitmap(regionInfo, bitmap);
            },
            onImmediateLosslessGenericRegion: function SimpleSegmentVisitor_onImmediateLosslessGenericRegion() {
                this.onImmediateGenericRegion.apply(this, arguments);
            },
            onSymbolDictionary: function SimpleSegmentVisitor_onSymbolDictionary(dictionary, currentSegment, referredSegments, data, start, end) {
                var huffmanTables;
                if (dictionary.huffman) {
                    error("JBIG2 error: huffman is not supported");
                }
                var symbols = this.symbols;
                if (!symbols) {
                    this.symbols = symbols = {};
                }
                var inputSymbols = [];
                for (var i = 0, ii = referredSegments.length; i < ii; i++) {
                    inputSymbols = inputSymbols.concat(symbols[referredSegments[i]]);
                }
                var decodingContext = new DecodingContext(data, start, end);
                symbols[currentSegment] = decodeSymbolDictionary(dictionary.huffman, dictionary.refinement, inputSymbols, dictionary.numberOfNewSymbols, dictionary.numberOfExportedSymbols, huffmanTables, dictionary.template, dictionary.at, dictionary.refinementTemplate, dictionary.refinementAt, decodingContext);
            },
            onImmediateTextRegion: function SimpleSegmentVisitor_onImmediateTextRegion(region, referredSegments, data, start, end) {
                var regionInfo = region.info;
                var huffmanTables;
                var symbols = this.symbols;
                var inputSymbols = [];
                for (var i = 0, ii = referredSegments.length; i < ii; i++) {
                    inputSymbols = inputSymbols.concat(symbols[referredSegments[i]]);
                }
                var symbolCodeLength = log2(inputSymbols.length);
                var decodingContext = new DecodingContext(data, start, end);
                var bitmap = decodeTextRegion(region.huffman, region.refinement, regionInfo.width, regionInfo.height, region.defaultPixelValue, region.numberOfSymbolInstances, region.stripSize, inputSymbols, symbolCodeLength, region.transposed, region.dsOffset, region.referenceCorner, region.combinationOperator, huffmanTables, region.refinementTemplate, region.refinementAt, decodingContext);
                this.drawBitmap(regionInfo, bitmap);
            },
            onImmediateLosslessTextRegion: function SimpleSegmentVisitor_onImmediateLosslessTextRegion() {
                this.onImmediateTextRegion.apply(this, arguments);
            }
        };
        function Jbig2Image() {}
        Jbig2Image.prototype = {
            parseChunks: function Jbig2Image_parseChunks(chunks) {
                return parseJbig2Chunks(chunks);
            }
        };
        return Jbig2Image;
    }();
    function log2(x) {
        var n = 1, i = 0;
        while (x > n) {
            n <<= 1;
            i++;
        }
        return i;
    }
    function readInt8(data, start) {
        return data[start] << 24 >> 24;
    }
    function readUint16(data, offset) {
        return data[offset] << 8 | data[offset + 1];
    }
    function readUint32(data, offset) {
        return (data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]) >>> 0;
    }
    function shadow(obj, prop, value) {
        Object.defineProperty(obj, prop, {
            value: value,
            enumerable: true,
            configurable: true,
            writable: false
        });
        return value;
    }
    var error = function() {
        console.error.apply(console, arguments);
        throw new Error("PDFJS error: " + arguments[0]);
    };
    var warn = function() {
        console.warn.apply(console, arguments);
    };
    var info = function() {
        console.info.apply(console, arguments);
    };
    Jbig2Image.prototype.parse = function parseJbig2(data) {
        var position = 0, end = data.length;
        if (data[position] !== 151 || data[position + 1] !== 74 || data[position + 2] !== 66 || data[position + 3] !== 50 || data[position + 4] !== 13 || data[position + 5] !== 10 || data[position + 6] !== 26 || data[position + 7] !== 10) {
            error("JBIG2 error: invalid header");
        }
        var header = {};
        position += 8;
        var flags = data[position++];
        header.randomAccess = !(flags & 1);
        if (!(flags & 2)) {
            header.numberOfPages = readUint32(data, position);
            position += 4;
        }
        var visitor = this.parseChunks([ {
            data: data,
            start: position,
            end: end
        } ]);
        var width = visitor.currentPageInfo.width;
        var height = visitor.currentPageInfo.height;
        var bitPacked = visitor.buffer;
        var data = new Uint8Array(width * height);
        var q = 0, k = 0;
        for (var i = 0; i < height; i++) {
            var mask = 0, buffer;
            for (var j = 0; j < width; j++) {
                if (!mask) {
                    mask = 128;
                    buffer = bitPacked[k++];
                }
                data[q++] = buffer & mask ? 0 : 255;
                mask >>= 1;
            }
        }
        this.width = width;
        this.height = height;
        this.data = data;
    };
    PDFJS.JpegImage = JpegImage;
    PDFJS.JpxImage = JpxImage;
    PDFJS.Jbig2Image = Jbig2Image;
})(PDFJS || (PDFJS = {}));

var JpegDecoder = PDFJS.JpegImage;

var JpxDecoder = PDFJS.JpxImage;

var Jbig2Decoder = PDFJS.Jbig2Image;

if (typeof exports !== "undefined") {
    module.exports = {
        JpegImage: JpegImage,
        JpegDecoder: JpegDecoder,
        JpxDecoder: JpxDecoder,
        Jbig2Decoder: Jbig2Decoder
    };
}
