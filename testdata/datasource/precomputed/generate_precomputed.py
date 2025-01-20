#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "tensorstore",
#     "numpy",
# ]
# ///
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


write_multiscale(
    os.path.abspath(os.path.join(os.path.dirname(__file__), "one_channel")),
    num_channels=1,
    num_scales=3,
)

write_multiscale(
    os.path.abspath(os.path.join(os.path.dirname(__file__), "two_channels")),
    num_channels=2,
    num_scales=3,
)
