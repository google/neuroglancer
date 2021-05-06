'use strict';

import DracoDecoderModule from "./draco_wasm_wrapper.js";
require('./draco_decoder.wasm');

function loadWebAssemblyDecoder() {
  return new Promise((resolve, reject) => {
    const DracoLoader = {};
    DracoLoader.dracoDecoderType = {};
    DracoLoader.dracoDecoderType['onModuleLoaded'] = () => {
      resolve(DracoLoader);
    };

    DracoLoader.dracoDecoderType['wasmBinaryFile'] = 'draco_decoder.wasm';

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'draco_decoder.wasm', true);
    xhr.responseType = 'arraybuffer';

    xhr.onload = function() {
      // For WebAssembly the object passed into DracoModule() must contain a
      // property with the name of wasmBinary and the value must be an
      // ArrayBuffer containing the contents of the .wasm file.
      DracoLoader.dracoDecoderType['wasmBinary'] = xhr.response;
      try {
        DracoLoader.decoderModule = DracoDecoderModule(DracoLoader.dracoDecoderType);
      } catch (err) {
        reject(new Error('Draco webassembly decoder corrupted'));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Request to load draco webassembly decoder failed'));
    };

    xhr.send(null);
  });
}

const dracoModulePromise = loadWebAssemblyDecoder();

export default dracoModulePromise;