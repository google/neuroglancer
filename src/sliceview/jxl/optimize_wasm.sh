#!/bin/bash -xve

cd /src
wasm-opt -O3 /src/jxl_decoder.wasm -o /src/jxl_decoder.wasm