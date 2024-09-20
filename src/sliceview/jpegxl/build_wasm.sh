#!/bin/bash -xve

LIBJXL=/usr/src/libjxl/lib

compile_options=(
    -O2
    -I${LIBJXL}/include
    -I${LIBJXL}/jxl
    ${LIBJXL}/jxl/*.cc
    jxl_wasm.c
     -DNDEBUG
     --no-entry
     -s FILESYSTEM=0
     -s ALLOW_MEMORY_GROWTH=1 
     -s TOTAL_STACK=32768
     -s TOTAL_MEMORY=64kb
     -s EXPORTED_FUNCTIONS='["_jxl_decompress","_malloc","_free"]'
     -s MALLOC=emmalloc
     -s ENVIRONMENT=worker
     -s STANDALONE_WASM=1
     # -s ASSERTIONS=1 
     # -s SAFE_HEAP=1
     -o libjxl.wasm
)
emcc ${compile_options[@]}
