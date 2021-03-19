/**
 * @license
 * Copyright 2020 Google Inc.
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

export function toBase64(array: ArrayBufferView): Promise<string> {
  return new Promise(resolve => {
    const blob = new Blob([array], {type: 'application/octet-stream'});
    const reader = new FileReader();
    reader.onload = function(event) {
      const dataUrl = event.target!.result as string;
      resolve(dataUrl.substr(dataUrl.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
