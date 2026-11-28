#!/bin/bash -xve

# Builds warpfield.wasm from the reference Rust implementation, crate
# `warpfield-wasm` of zarr-warpfield (pure-Rust zstd, no imports):
#
#     ./build_wasm.sh /path/to/zarr-warpfield

cd "$(dirname "$0")"
repo="$(cd "$1" && pwd)"
cargo build --manifest-path "$repo/rust/Cargo.toml" -p warpfield-wasm \
  --target wasm32-unknown-unknown --profile release-wasm
cp "$repo/rust/target/wasm32-unknown-unknown/release-wasm/warpfield_wasm.wasm" warpfield.wasm
