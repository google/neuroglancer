#!/bin/zsh -xve

compile_options=(
    compresso_wasm.cc
     -O3
     -DNDEBUG
     --no-entry
     -fno-rtti
     -s FILESYSTEM=0
     -s ALLOW_MEMORY_GROWTH=1 
     -s TOTAL_STACK=32768
     -s TOTAL_MEMORY=65536
     -s EXPORTED_FUNCTIONS='["_compresso_decompress","_malloc","_free"]'
     -s MALLOC=emmalloc
     -s ENVIRONMENT=worker
     -s MODULARIZE=1
     -s EXPORT_NAME="createCompressoModule"
     # -s ASSERTIONS=1 
     # -s SAFE_HEAP=1
     -std=c++14
     -o compresso.js
)
em++ ${compile_options[@]}
