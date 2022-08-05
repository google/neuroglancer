#!/bin/bash -xve

ZFP=/usr/src/zfp

compile_options=(
    -O2
    -L${ZFP}/build/lib/ -lzfp
    -I${ZFP}/include
    zfpc_wasm.cc
     -DNDEBUG
     --no-entry
     -s FILESYSTEM=0
     -s ALLOW_MEMORY_GROWTH=1 
     -s TOTAL_STACK=32768
     -s TOTAL_MEMORY=64kb
     -s EXPORTED_FUNCTIONS='["_zfpc_decompress","_malloc","_free"]'
     -s MALLOC=emmalloc
     -s ENVIRONMENT=worker
     -s STANDALONE_WASM=1
     # -s ASSERTIONS=1 
     # -s SAFE_HEAP=1
     -std=c++14
     -o libzfpc.wasm
)
emcc ${compile_options[@]}
