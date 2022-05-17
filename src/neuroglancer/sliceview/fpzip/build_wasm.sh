#!/bin/bash -xve

FPZIP=/usr/src/fpzip
SRC=$FPZIP/src

compile_options=(
    -Oz # O2 + drops vectorization, but WASM doesn't support vectorization anyway
    -I$FPZIP/include 

    $SRC/error.cpp $SRC/rcdecoder.cpp $SRC/rcencoder.cpp 
    $SRC/rcqsmodel.cpp $SRC/write.cpp $SRC/read.cpp 
    
    -DFPZIP_FP=FPZIP_FP_FAST -DFPZIP_BLOCK_SIZE=0x1000
    -DWITH_UNION
    
    fpzip_wasm.cpp
     -DNDEBUG
     --no-entry
     -s FILESYSTEM=0
     -s ALLOW_MEMORY_GROWTH=1 
     -s TOTAL_STACK=32768
     -s TOTAL_MEMORY=64kb
     -s EXPORTED_FUNCTIONS='["_fpzip_decompress","_fpzip_dekempress","_check_valid","_malloc","_free"]'
     -s MALLOC=emmalloc
     -s ENVIRONMENT=worker
     -s STANDALONE_WASM=1
     # -s ASSERTIONS=1 
     # -s SAFE_HEAP=1
     -o libfpzip.wasm
)
em++ ${compile_options[@]}
