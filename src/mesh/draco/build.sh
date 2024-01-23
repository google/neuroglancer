#!/bin/bash -xve

# This script builds `neuroglancer_draco.wasm` using emsdk in a docker container.

cd "$(dirname "$0")"

docker build .
docker run \
       --rm \
       -v ${PWD}:/src \
       -u $(id -u):$(id -g) \
       $(docker build -q .) \
       ./build_wasm.py
