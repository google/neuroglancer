#!/bin/bash

export CIBW_ARCHS_MACOS="x86_64 arm64"
export CIBW_SKIP="cp27-* cp36-* pp* *_i686 *-win32"
export CIBW_TEST_EXTRAS="test"
export CIBW_TEST_COMMAND="python -m pytest {project}/python/tests -vv -s --skip-browser-tests"
export CIBW_MANYLINUX_X86_64_IMAGE=manylinux2014

# Skip testing on musllinux due to pillow binary wheels not being available.
export CIBW_TEST_SKIP="*-musllinux*"

script_dir="$(dirname "$0")"
root_dir="${script_dir}/../.."
cd "${root_dir}"
exec python -m cibuildwheel --output-dir dist "$@"
