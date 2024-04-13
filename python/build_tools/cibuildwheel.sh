#!/bin/bash

export CIBW_BUILD_FRONTEND="build"
export CIBW_ARCHS_MACOS="x86_64 arm64"
export CIBW_SKIP="cp27-* cp36-* cp37-* cp38-* pp* *_i686 *-win32 *-musllinux*"
export CIBW_TEST_REQUIRES="-r python/requirements-test.txt"
export CIBW_TEST_COMMAND="python -m pytest {project}/python/tests -vv -s --skip-browser-tests"
export CIBW_MANYLINUX_X86_64_IMAGE=manylinux2014

# Assume the client bundle was already built. The github actions workflow builds
# the client with specific defines to include the build stamp, and that would be
# lost if setup.py rebuilds the client.
export CIBW_ENVIRONMENT="NEUROGLANCER_PREBUILT_CLIENT=1"

script_dir="$(dirname "$0")"
root_dir="${script_dir}/../.."
cd "${root_dir}"
exec python -m cibuildwheel --output-dir dist "$@"
