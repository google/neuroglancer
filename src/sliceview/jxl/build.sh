#!/bin/bash -xve

# This script builds `jxl_decoder.wasm` using emsdk in a docker container.

cd "$(dirname "$0")"

docker build -f compile.Dockerfile .
docker run \
       --rm \
       -v ${PWD}:/src \
       -u $(id -u):$(id -g) \
       $(docker build -f compile.Dockerfile -q .) \
       /src/build_wasm.sh

docker build -f optimize.Dockerfile .
docker run \
       --rm \
       -v ${PWD}:/src \
       -u $(id -u):$(id -g) \
       $(docker build -f optimize.Dockerfile -q .) \
       /src/optimize_wasm.sh

