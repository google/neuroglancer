#!/bin/bash -xve

# cibuildwheel runs docker containers as root, and when running as uid 0, pip refuses to use a cache
# directory that is not owned by uid 0.

UV_CACHE_DIR="$1"

if [ ! -z "${UV_CACHE_DIR}" ]; then
  mkdir -p "${UV_CACHE_DIR}"
  chown $UID "${UV_CACHE_DIR}"
  chmod 777 "${UV_CACHE_DIR}"
fi
