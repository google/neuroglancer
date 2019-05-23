#!/bin/bash -xve

docker build .
docker run --rm -v ${PWD}:/src $(docker build -q .) ./build_wasm.sh
