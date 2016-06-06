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

import { RenderLayer } from 'neuroglancer/sliceview/renderlayer';
import { ShaderBuilder } from 'neuroglancer/webgl/shader';

export class ImageRenderLayer extends RenderLayer {
  getShaderKey() {
    return 'sliceview.ImageRenderLayer';
  }

  defineShader (builder: ShaderBuilder) {
    super.defineShader(builder);
    builder.setFragmentMain(`
float value = getDataValue();
emit(vec4(value, value, value, 0.7));
`);
  }
};
