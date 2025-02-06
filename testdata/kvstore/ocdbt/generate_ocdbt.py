#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "tensorstore",
# ]
# ///

import os
import pathlib
import shutil

import tensorstore as ts

SCRIPT_DIR = os.path.abspath(os.path.dirname(__file__))


def write_ocdbt_files(name, config):
    print(name)
    files_dir = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "files"))
    ocdbt_dir = os.path.abspath(os.path.join(SCRIPT_DIR, name))

    shutil.rmtree(ocdbt_dir, ignore_errors=True)

    kvs = ts.KvStore.open(
        {
            "driver": "ocdbt",
            "base": {"driver": "file", "path": ocdbt_dir},
            "assume_config": True,
            "config": config,
        }
    ).result()

    with ts.Transaction(atomic=True) as txn:
        for root, dirs, files in os.walk(files_dir):
            for filename in files:
                entry_path = os.path.join(root, filename)
                kvs.with_transaction(txn)[os.path.relpath(entry_path, files_dir)] = (
                    pathlib.Path(entry_path).read_bytes()
                )

    print(ts.ocdbt.dump(kvs.base).result())


def write_ocdbt_multi_version(name: str, config, num_versions: int):
    ocdbt_dir = os.path.abspath(os.path.join(SCRIPT_DIR, name))

    shutil.rmtree(ocdbt_dir, ignore_errors=True)

    kvs = ts.KvStore.open(
        {
            "driver": "ocdbt",
            "base": {"driver": "file", "path": ocdbt_dir},
            "assume_config": True,
            "config": config,
        }
    ).result()

    for i in range(1, num_versions + 1):
        with ts.Transaction(atomic=True) as txn:
            kvs.with_transaction(txn)[f"key{i}"] = f"version {i}"
    print(ts.ocdbt.dump(kvs.base).result())


write_ocdbt_files(name="files_high_arity.ocdbt", config={})
write_ocdbt_files(
    name="files_min_arity.ocdbt",
    config={"max_inline_value_bytes": 2, "max_decoded_node_bytes": 1},
)
write_ocdbt_multi_version(
    name="multi_version_high_arity.ocdbt", config={}, num_versions=200
)
write_ocdbt_multi_version(
    name="multi_version_low_arity.ocdbt",
    config={"version_tree_arity_log2": 1},
    num_versions=200,
)
