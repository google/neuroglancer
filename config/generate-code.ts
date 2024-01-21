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

"use strict";

const nunjucks = require("nunjucks");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const srcDir = path.resolve(rootDir, "src");
const templatesDir = path.resolve(rootDir, "templates");

const env = nunjucks.configure(rootDir, {
  autoescape: false,
  tags: {
    blockStart: "/*%",
    blockEnd: "%*/",
    variableStart: "/*@",
    variableEnd: "@*/",
  },
});

function writeGenerated(sourcePath, outputPath, contents) {
  fs.writeFileSync(
    path.resolve(rootDir, "src", outputPath),
    `// DO NOT EDIT.  Generated from templates/${sourcePath}.
` + contents,
  );
}

function renderTemplate(sourcePath, outputPath, context) {
  writeGenerated(
    sourcePath,
    outputPath,
    env.render(path.resolve(templatesDir, sourcePath), context),
  );
}

function writeSegmentationCompression() {
  const baseDir = "sliceview/compressed_segmentation";
  renderTemplate(
    path.join(baseDir, "encode_common.template.ts"),
    path.join(baseDir, "encode_common.ts"),
    {},
  );
  for (const dataType of ["uint64", "uint32"]) {
    const context = {
      dataType,
      strideMultiplier: dataType === "uint64" ? 2 : 1,
    };
    for (const op of ["encode", "decode"]) {
      renderTemplate(
        path.join(baseDir, `${op}.template.ts`),
        path.join(baseDir, `${op}_${dataType}.ts`),
        context,
      );
    }
  }
}

function makeSubstitutions(inputPath, outputPath, replacements) {
  let inputContents = fs.readFileSync(path.resolve(templatesDir, inputPath), {
    encoding: "utf-8",
  });
  for (const patternAndReplacement of replacements) {
    inputContents = inputContents.replace(
      patternAndReplacement[0],
      patternAndReplacement[1],
    );
  }
  writeGenerated(inputPath, outputPath, inputContents);
}

function writeDataStructures() {
  const baseDir = "util";
  for (const arrayType of [
    "Uint8Array",
    "Uint16Array",
    "Float32Array",
    "Uint32Array",
    "Float64Array",
    "Int8Array",
    "Int16Array",
    "Int32Array",
  ]) {
    makeSubstitutions(
      path.join(baseDir, "typedarray_builder.template.ts"),
      path.join(baseDir, `${arrayType.toLowerCase()}_builder.ts`),
      [[/\$TYPE\$/g, arrayType]],
    );
  }
  for (let i = 0; i < 2; ++i) {
    const nextPrevReplacements = [
      [/NEXT_PROPERTY/g, `next${i}`],
      [/PREV_PROPERTY/g, `prev${i}`],
    ];
    makeSubstitutions(
      path.join(baseDir, "linked_list.template.ts"),
      path.join(baseDir, `linked_list.${i}.ts`),
      nextPrevReplacements,
    );

    makeSubstitutions(
      path.join(baseDir, "pairing_heap.template.ts"),
      path.join(baseDir, `pairing_heap.${i}.ts`),
      [[/CHILD_PROPERTY/g, `child${i}`], ...nextPrevReplacements],
    );
  }
}

writeSegmentationCompression();
writeDataStructures();
