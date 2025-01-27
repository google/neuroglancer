#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "tensorstore",
# ]
# ///
import json
import os
import pathlib
import shutil

import tensorstore as ts


def write_multiscale(
    path, include_top_level_scales: bool, include_per_scale_downsampling_factors: bool
):
    shutil.rmtree(path, ignore_errors=True)
    shape = [10, 20]
    scales = []
    for scale in [0, 1, 2]:
        downsample_factors = [2**scale, 2**scale]
        scales.append(downsample_factors)
        scale_path = os.path.join(path, f"s{scale}")
        scale_attributes = {}
        if include_per_scale_downsampling_factors:
            scale_attributes["downsamplingFactors"] = downsample_factors
        ts.open(
            {
                "driver": "n5",
                "kvstore": {"driver": "file", "path": scale_path},
                "metadata": scale_attributes,
            },
            create=True,
            delete_existing=True,
            dtype=ts.uint16,
            shape=[
                -(-shape[0] // downsample_factors[0]),
                -(-shape[1] // downsample_factors[1]),
            ],
        ).result()
    top_level_attributes = {
        "axes": ["x", "y"],
        "units": ["nm", "s"],
        "resolution": [10, 20],
    }
    if include_top_level_scales:
        top_level_attributes["scales"] = scales
    pathlib.Path(os.path.join(path, "attributes.json")).write_text(
        json.dumps(top_level_attributes)
    )


write_multiscale(
    os.path.abspath(
        os.path.join(os.path.dirname(__file__), "n5_viewer_multiscale_deprecated")
    ),
    include_top_level_scales=True,
    include_per_scale_downsampling_factors=False,
)

write_multiscale(
    os.path.abspath(
        os.path.join(os.path.dirname(__file__), "n5_viewer_multiscale_modern")
    ),
    include_top_level_scales=False,
    include_per_scale_downsampling_factors=True,
)
