/**
 * @license
 * Copyright 2017 Google Inc.
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

import { registerProvider } from "#src/datasource/default_provider.js";
import { NiftiZarrDataSource } from "#src/datasource/niftizarr/frontend.js";

registerProvider("niftizarr", () => new NiftiZarrDataSource());
registerProvider("niftizarr2", () => new NiftiZarrDataSource(2));
registerProvider("niftizarr3", () => new NiftiZarrDataSource(3));

