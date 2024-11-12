#!/bin/bash -xve

cd /src
cargo build --target wasm32-unknown-unknown --release
cp /src/target/wasm32-unknown-unknown/release/jxl_wasm.wasm /src/jxl_decoder.wasm
rm -r target