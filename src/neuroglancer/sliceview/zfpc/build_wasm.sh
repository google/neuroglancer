#!/bin/bash -xve

ZFP=/usr/src/zfp
ZSRC=${ZFP}/src
OPTIMIZATION_LEVEL=-O2

compile_options_zfp=(
    $OPTIMIZATION_LEVEL
    -c
    -I${ZFP}/include
    ${ZSRC}/zfp.c ${ZSRC}/bitstream.c ${ZSRC}/decode1f.c ${ZSRC}/decode1d.c 
    ${ZSRC}/decode1i.c ${ZSRC}/decode1l.c ${ZSRC}/decode2f.c ${ZSRC}/decode2d.c 
    ${ZSRC}/decode2i.c ${ZSRC}/decode2l.c ${ZSRC}/decode3f.c ${ZSRC}/decode3d.c 
    ${ZSRC}/decode3i.c ${ZSRC}/decode3l.c ${ZSRC}/decode4f.c ${ZSRC}/decode4d.c 
    ${ZSRC}/decode4i.c ${ZSRC}/decode4l.c
    -DNDEBUG
    --no-entry
)
emcc ${compile_options_zfp[@]}


OBJ_FILES=(
    zfp.o bitstream.o decode1f.o decode1d.o 
    decode1i.o decode1l.o decode2f.o decode2d.o 
    decode2i.o decode2l.o decode3f.o decode3d.o 
    decode3i.o decode3l.o decode4f.o decode4d.o 
    decode4i.o decode4l.o
)

compile_options_zfpc=(
    $OPTIMIZATION_LEVEL
    -I${ZFP}/include
    ${OBJ_FILES[@]}
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
emcc ${compile_options_zfpc[@]}
rm ${OBJ_FILES[@]}
