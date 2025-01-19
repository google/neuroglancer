#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "ngff-zarr[tensorstore]",
#     "numpy",
# ]
# ///

import os
import shutil
import zipfile

import ngff_zarr as nz
import numpy as np

THIS_DIR = os.path.abspath(os.path.dirname(__file__))


def write_data(path: str, version: str):
    shape = [10, 10]

    data = np.arange(np.prod(shape), dtype=np.uint16).reshape(shape)

    image = nz.to_ngff_image(
        data,
        dims=["y", "x"],
        scale={"y": 4, "x": 30},
        axes_units={"y": "nanometer", "x": "nanometer"},
    )

    multiscales = nz.to_multiscales(
        image, scale_factors=[{"x": 2, "y": 2}, {"x": 4, "y": 4}]
    )

    full_path = os.path.join(THIS_DIR, path)
    shutil.rmtree(full_path, ignore_errors=True)

    nz.to_ngff_zarr(
        full_path,
        multiscales,
        use_tensorstore=True,
        version=version,
    )


def create_zip(directory_path: str, zip_path: str):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zipf:
        for root, dirs, files in os.walk(directory_path):
            for filename in files:
                entry_path = os.path.join(root, filename)
                zipf.write(entry_path, os.path.relpath(entry_path, directory_path))


write_data("simple_0.4", version="0.4")
write_data("simple_0.5", version="0.5")
create_zip(os.path.join(THIS_DIR, "simple_0.5"), "simple_0.4.zip")
