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

const gulp = require('gulp');
const format = require('gulp-clang-format');

{
  const sourcesToFormat = [
    'src/**/*.[tj]s',
    'gulpfile.js',
    'config/**/*.[tj]s',
    'examples/dependent-project/config/**/*.[tj]s',
    'examples/dependent-project/src/**/*.[tj]s',
    'typings/**/*.d.ts',
  ];
  const globOptions = {base: '.', nodir: true, follow: false};
  const opt_clangStyle = 'file';
  const opt_clangFormat = undefined;

  gulp.task('check-format', () => {
    return gulp.src(sourcesToFormat, globOptions)
        .pipe(format.checkFormat(opt_clangStyle, opt_clangFormat, {fail: true}));
  });

  gulp.task('format', () => {
    return gulp.src(sourcesToFormat, globOptions)
        .pipe(format.format(opt_clangStyle, opt_clangFormat))
        .pipe(gulp.dest('.'));
  });
}
