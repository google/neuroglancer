#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "icechunk",
#     "zarr>=3",
# ]
# ///

import asyncio
import json
import os
import pathlib
import shutil

import icechunk
import numpy as np
import zarr
import zarr.core.buffer

SCRIPT_DIR = os.path.abspath(os.path.dirname(__file__))


def write_zarr_array(name):
    storage_dir = os.path.abspath(os.path.join(SCRIPT_DIR, name))
    shutil.rmtree(storage_dir, ignore_errors=True)
    storage = icechunk.local_filesystem_storage(storage_dir)

    repo = icechunk.Repository.create(storage)

    session = repo.writable_session("main")

    a = zarr.create(
        shape=[6, 7],
        chunks=[4, 5],
        dtype="uint8",
        store=session.store,
        compressor=None,
    )
    a[...] = np.arange(np.prod(a.shape), dtype=a.dtype).reshape(a.shape)

    session.commit("first commit")

    main_snapshot = repo.lookup_branch("main")

    repo.create_branch("other_branch", main_snapshot)
    repo.create_tag("tag1", main_snapshot)
    repo.create_tag("tag2", main_snapshot)
    repo.create_tag("tag3", main_snapshot)
    repo.delete_tag("tag3")


def write_zarr_hierarchy(name):
    storage_dir = os.path.abspath(os.path.join(SCRIPT_DIR, name))
    shutil.rmtree(storage_dir, ignore_errors=True)
    storage = icechunk.local_filesystem_storage(storage_dir)

    repo = icechunk.Repository.create(storage)

    session = repo.writable_session("main")

    root = zarr.group(session.store, attributes={"a": 10})
    a = root.create_array(
        "a", shape=[6, 7], chunks=[4, 5], dtype="uint8", compressors=None
    )
    a[...] = np.arange(np.prod(a.shape), dtype=a.dtype).reshape(a.shape)
    root.create_array("bar", shape=[6, 7], chunks=[4, 5], dtype="int32")
    c = root.create_group("cde", attributes={"b": 11})
    c.create_array("abc", shape=[6, 7], chunks=[4, 5], dtype="int32")
    c.create_array("def", shape=[6, 7], chunks=[4, 5], dtype="int32")
    root.create_array("def", shape=[6, 7], chunks=[4, 5], dtype="int32")
    root.create_group("e", attributes={"b": 11})
    c.create_array("xyz", shape=[6, 7], chunks=[4, 5], dtype="int32")

    session.commit("first commit")


def copy_to_dir(name, output_name):
    storage_dir = os.path.abspath(os.path.join(SCRIPT_DIR, name))
    output_dir = os.path.join(SCRIPT_DIR, output_name)
    shutil.rmtree(output_dir, ignore_errors=True)
    storage = icechunk.local_filesystem_storage(storage_dir)
    repo = icechunk.Repository.open(storage)
    read_session = repo.readonly_session(branch="main")
    store = read_session.store

    async def do_copy():
        buffer_prototype = zarr.core.buffer.default_buffer_prototype()
        async for key in store.list():
            value = (await store.get(key, prototype=buffer_prototype)).to_bytes()
            if key.endswith("zarr.json"):
                # icechunk incorrectly includes `"dimension_names": null` fields.
                # https://github.com/earth-mover/icechunk/issues/706
                j = json.loads(value)
                if "dimension_names" in j and j["dimension_names"] is None:
                    del j["dimension_names"]
                value = json.dumps(j).encode("utf-8")
            output_path = os.path.join(output_dir, key)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            pathlib.Path(output_path).write_bytes(value)

    asyncio.run(do_copy())


def write_virtual_ref_test(name):
    storage_dir = os.path.abspath(os.path.join(SCRIPT_DIR, name))
    shutil.rmtree(storage_dir, ignore_errors=True)
    storage = icechunk.local_filesystem_storage(storage_dir)

    repo = icechunk.Repository.create(storage)

    session = repo.writable_session("main")

    zarr.create(
        shape=[4, 5],
        chunks=[4, 5],
        dtype="uint8",
        store=session.store,
        compressor=None,
    )
    session.store.set_virtual_ref(
        "c/0/0", "s3://mybucket/myobject", offset=5, length=20
    )

    session.commit("first commit")


write_zarr_array("single_array.icechunk")
write_zarr_hierarchy("hierarchy.icechunk")
for name in ["single_array", "hierarchy"]:
    copy_to_dir(f"{name}.icechunk", name)
write_virtual_ref_test("virtual_ref.icechunk")
