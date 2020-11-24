#!/bin/bash -xve

# cibuildwheel runs docker containers as root, and when running as uid 0, pip refuses to use a cache
# directory that is not owned by uid 0.

PIP_CACHE_DIR="$1"

if [ ! -z "${PIP_CACHE_DIR}" ]; then
  mkdir -p "${PIP_CACHE_DIR}"
  chown $UID "${PIP_CACHE_DIR}"
  chmod 777 "${PIP_CACHE_DIR}"
fi
