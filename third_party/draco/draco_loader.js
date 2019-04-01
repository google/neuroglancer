// Copyright 2016 The Draco Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
'use strict';

import DracoDecoderModule from "draco_wasm_wrapper.js";
require('draco_decoder.wasm');

const DracoLoader = {};
DracoLoader.dracoDecoderType = {};
DracoLoader.moduleLoaded = false;
DracoLoader.dracoDecoderType['onModuleLoaded'] = () => {
    DracoLoader.moduleLoaded = true;
};

function loadWebAssemblyDecoder() {
  DracoLoader.dracoDecoderType['wasmBinaryFile'] = 'draco_decoder.wasm';

  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'draco_decoder.wasm', true);
  xhr.responseType = 'arraybuffer';

  xhr.onload = function() {
    // For WebAssembly the object passed into DracoModule() must contain a
    // property with the name of wasmBinary and the value must be an
    // ArrayBuffer containing the contents of the .wasm file.
    DracoLoader.dracoDecoderType['wasmBinary'] = xhr.response;
    DracoLoader.decoderModule = DracoDecoderModule(DracoLoader.dracoDecoderType);
  };

  xhr.send(null);
}

loadWebAssemblyDecoder();

export default DracoLoader;
