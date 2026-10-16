#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "tensorstore",
#     "numpy",
# ]
# ///
import json
import os
import shutil

import numpy as np
import tensorstore as ts


def write_multiscale(path: str, num_channels: int, num_scales: int):
    shutil.rmtree(path, ignore_errors=True)
    shape = np.array([10, 20, 30, num_channels])
    base_resolution = np.array([3, 4, 5])
    for scale in range(num_scales):
        downsample_factors = [2**scale, 2**scale, 2**scale, 1]
        ts.open(
            {
                "driver": "neuroglancer_precomputed",
                "kvstore": {"driver": "file", "path": path},
                "scale_metadata": {
                    "resolution": base_resolution * downsample_factors[:-1]
                },
            },
            create=True,
            dtype=ts.uint16,
            shape=-(-shape // downsample_factors),
        ).result()


def write_reversed_scales(source_path: str, path: str):
    """Writes a copy of `source_path` with the scales listed coarsest first.

    The format requires the resolution not to decrease as the index into
    `"scales"` increases, but files violating that do occur in practice, so
    Neuroglancer sorts the scales rather than trusting the order.  tensorstore
    always writes them in order, hence this derived copy.
    """
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path)
    with open(os.path.join(source_path, "info")) as f:
        info = json.load(f)
    info["scales"] = info["scales"][::-1]
    with open(os.path.join(path, "info"), "w") as f:
        json.dump(info, f)


base = os.path.abspath(os.path.dirname(__file__))

write_multiscale(
    os.path.join(base, "one_channel"),
    num_channels=1,
    num_scales=3,
)

write_multiscale(
    os.path.join(base, "two_channels"),
    num_channels=2,
    num_scales=3,
)

write_reversed_scales(
    os.path.join(base, "one_channel"),
    os.path.join(base, "reversed_scales"),
)
