#!/bin/bash

export CIBW_SKIP="cp27-* pp* *_i686 *-win32"
export CIBW_TEST_EXTRAS="test"
export CIBW_TEST_COMMAND="python -m pytest {project}/python/tests -vv -s --skip-browser-tests"
script_dir="$(dirname "$0")"
root_dir="${script_dir}/../.."
cd "${root_dir}"
exec python -m cibuildwheel --output-dir dist "$@"
