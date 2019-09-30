#!/bin/bash -xve

draco_src_root="/usr/src/draco/src/draco"

eval $(sed -ne '/^set(draco_.*_sources$/,/)$/{p;}' /usr/src/draco/CMakeLists.txt | sed -e 's/^set(\(.*\)/\1=(/' | sed -e 's/)/\n)/g' | grep -v '\.h"$')

compile_options=(
    neuroglancer_draco.cc
     ${draco_attributes_sources[@]}
     ${draco_compression_attributes_dec_sources[@]}
     ${draco_compression_attributes_pred_schemes_dec_sources[@]}
     ${draco_compression_bit_coders_sources[@]}
     ${draco_compression_decode_sources[@]}
     ${draco_compression_entropy_sources[@]}
     ${draco_compression_mesh_traverser_sources[@]}
     ${draco_compression_mesh_dec_sources[@]}
     ${draco_compression_point_cloud_dec_sources[@]}
     ${draco_core_sources[@]}
     ${draco_dec_config_sources[@]}
     ${draco_mesh_sources[@]}
     ${draco_metadata_dec_sources[@]}
     ${draco_metadata_sources[@]}
     ${draco_point_cloud_sources[@]}
     ${draco_points_dec_sources[@]}
     -O3
     -DNDEBUG
     --js-library stub.js
     -fno-exceptions
     -fno-rtti
     -s FILESYSTEM=0
     -s ALLOW_MEMORY_GROWTH=1 
     -s TOTAL_STACK=32768 -s TOTAL_MEMORY=65536
     -s EXPORTED_FUNCTIONS='["_neuroglancer_draco_decode","_malloc"]'
     -s MALLOC=emmalloc
     -s ENVIRONMENT=worker
     -std=c++14
     -Idraco_overlay
     -I/usr/src/draco/src
     -o neuroglancer_draco.wasm
)
emcc ${compile_options[@]}
