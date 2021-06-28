#!/usr/bin/env python3

"""Invoked by `build.sh` inside a container to build `neuroglancer_draco.wasm`.

Expects the directory of the Neuroglancere repository that contains this script
to be mounted as the current working directory inside the container.

Expects /usr/src/draco to contain the unpacked draco source code (see
`Dockerfile`).
"""


import pathlib
import re
import subprocess
import sys
import tempfile

DRACO_ROOT = pathlib.Path('/usr/src/draco')
DRACO_SRC = DRACO_ROOT / 'src'

SETTINGS = {
    # Disable filesystem interface, as it is unused.
    'FILESYSTEM': '0',
    'ALLOW_MEMORY_GROWTH': '1',
    'TOTAL_STACK': '32768',
    'TOTAL_MEMORY': '65536',
    'EXPORTED_FUNCTIONS': '["_neuroglancer_draco_decode","_malloc"]',
    'MALLOC': 'emmalloc',
    'ENVIRONMENT': 'worker',
    # Build in standalone mode (also implied by -o <name>.wasm option below)
    # https://github.com/emscripten-core/emscripten/wiki/WebAssembly-Standalone
    #
    # This causes the memory to be managed by WebAssembly rather than
    # JavaScript, and reduces the necessary JavaScript size.
    'STANDALONE_WASM': True,
}

DRACO_SOURCE_GROUPS = {
    'draco_attributes_sources',
    'draco_compression_attributes_dec_sources',
    'draco_compression_attributes_pred_schemes_dec_sources',
    'draco_compression_bit_coders_sources',
    'draco_compression_decode_sources',
    'draco_compression_entropy_sources',
    'draco_compression_mesh_traverser_sources',
    'draco_compression_mesh_dec_sources',
    'draco_compression_point_cloud_dec_sources',
    'draco_core_sources',
    'draco_dec_config_sources',
    'draco_mesh_sources',
    'draco_metadata_dec_sources',
    'draco_metadata_sources',
    'draco_point_cloud_sources',
    'draco_points_dec_sources',
}


def get_draco_sources():
    """Obtain the list of source files from CMakeLists.txt."""
    cmakelists_content = (DRACO_ROOT / 'CMakeLists.txt').read_text()
    sources = []

    seen_keys = set()

    for m in re.finditer(r'list\s*\(\s*APPEND\s+(draco_[a-z_]*_sources)\s+([^)]*)\)',
                         cmakelists_content):
        key = m.group(1)
        if key not in DRACO_SOURCE_GROUPS: continue
        seen_keys.add(key)
        key_sources = [
            x.strip('"').replace('${draco_src_root}', str(DRACO_SRC / 'draco'))
            for x in m.group(2).split()
        ]
        sources.extend(x for x in key_sources if not x.endswith('.h'))
    remaining_keys = DRACO_SOURCE_GROUPS - seen_keys
    if remaining_keys:
        raise Exception(f'missing source groups: {remaining_keys}')
    return sources


def main():
    sources = ['neuroglancer_draco.cc'] + get_draco_sources()

    settings_args = []
    for k, v in SETTINGS.items():
        settings_args.append('-s')
        if v is True:
            settings_args.append(k)
        else:
            settings_args.append(f'{k}={v}')

    # Use unity build for faster compilation (avoids redundant parsing of
    # headers, and redundant template instantiations).
    with tempfile.NamedTemporaryFile(suffix='.cc', mode='wb') as f:
        for source in sources:
            f.write(pathlib.Path(source).read_bytes())
        f.flush()

        sys.exit(
            subprocess.run([
                'emcc',
                f.name,
                # Note: Using -Os instead of -O3 reduces the size significantly,
                # but may harm performance.
                '-O3',
                # Disable debug assertions.
                '-DNDEBUG',
                # Specifies the interface that will be provided by JavaScript,
                # to avoid link errors.
                '--js-library',
                'stub.js',
                # Disable exception handling to reduce generated code size, as
                # it is unused and requires JavaScript support.
                '-fno-exceptions',
                # Disable RTTI to reduce generated code size, as it is unused.
                '-fno-rtti',
                # neuroglancer_draco.cc does not define a `main()` function.
                # Instead, this wasm module is intended to be used as a
                # "reactor", i.e. library.
                '--no-entry',
            ] + settings_args + [
                '-std=c++14',
                '-Idraco_overlay',
                f'-I{DRACO_SRC}',
                '-o',
                'neuroglancer_draco.wasm',
            ]).returncode)


if __name__ == '__main__':
    main()
