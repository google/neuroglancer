#!/bin/bash -xve

SPNG=/usr/src/spng/spng
MINIZ=/usr/src/miniz

compile_options=(
    -O2
    -I$MINIZ -DMINIZ_NO_STDIO=1
    $MINIZ/miniz_zip.c $MINIZ/miniz_tinfl.c $MINIZ/miniz_tdef.c $MINIZ/miniz.c
    # spng defaults to zlib if we don't force miniz
    # it also prints a warning about SIMD if we don't disable SIMD
    # using the SPNG_DISABLE_OPT flag.
    # As of this writng, WASM doesn't support SIMD by default anyway.
    -I$SPNG -DSPNG_USE_MINIZ=1 -DSPNG_DISABLE_OPT=1 $SPNG/spng.c
    png_wasm.c
     -DNDEBUG
     --no-entry
     -s FILESYSTEM=0
     -s ALLOW_MEMORY_GROWTH=1 
     -s TOTAL_STACK=32768
     -s TOTAL_MEMORY=64kb
     -s EXPORTED_FUNCTIONS='["_png_decompress","_malloc","_free"]'
     -s MALLOC=emmalloc
     -s ENVIRONMENT=worker
     -s STANDALONE_WASM=1
     # -s ASSERTIONS=1 
     # -s SAFE_HEAP=1
     -o libpng.wasm
)
emcc ${compile_options[@]}
