# @license
# Copyright 2026 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Generates warpfield-encoded chunks, and their reference decodings, for
# src/datasource/zarr/codec/warpfield/wasm.spec.ts.
#
# Needs the zarr_warpfield reference package (Python). Run from this directory:
#
#     python generate_warpfield_examples.py

import json

import numpy as np
from zarr_warpfield import Config, decode, encode


def smooth(shape, ncomp, rng, amp=3.0):
    """Low-frequency field with a sharp crack and a localized fold."""
    grids = np.meshgrid(*[np.arange(n, dtype=np.float64) for n in shape], indexing="ij")
    out = []
    for c in range(ncomp):
        f = np.zeros(shape)
        for _ in range(3):
            k = rng.normal(size=len(shape)) * 0.15
            ph = rng.uniform(0, 2 * np.pi)
            f += amp * np.sin(sum(ki * g for ki, g in zip(k, grids)) + ph)
        # tangential crack: a step across a tilted plane
        f += np.where(grids[-1] + 0.4 * grids[0] > shape[-1] * 0.6, 4.0 * (c + 1), 0.0)
        f += rng.normal(scale=0.01, size=shape)
        out.append(f)
    return out


def case(name, shape, roles, config, dtype="float32", tweak=None, seed=0):
    rng = np.random.default_rng(seed)
    comp_axis = roles.index("component") if "component" in roles else None
    spatial_shape = [n for n, r in zip(shape, roles) if r != "component"]
    ncomp = shape[comp_axis] if comp_axis is not None else 1
    comps = smooth(spatial_shape, ncomp, rng)
    arr = np.stack(comps, axis=-1) if comp_axis is not None else comps[0]
    if comp_axis is not None:
        arr = np.moveaxis(arr, -1, comp_axis)
    arr = arr.astype(dtype)
    if tweak is not None:
        tweak(arr)
    cfg = Config.from_dict({"axis_roles": roles, **config})
    buf, st, _ = encode(arr, cfg, stats=True)
    dec = decode(buf, arr.shape, dtype, cfg)
    assert np.all(np.abs(dec[np.isfinite(arr)] - arr[np.isfinite(arr)]) <= config["error_bound"])
    with open(f"{name}.wfld", "wb") as f:
        f.write(buf)
    dec.astype(dec.dtype.newbyteorder("<")).tofile(f"{name}.bin")  # raw, little-endian, C order
    with open(f"{name}.json", "w") as f:
        json.dump(
            {"shape": list(arr.shape), "dataType": dtype, "configuration": {"axis_roles": roles, **config}},
            f,
            indent=2,
        )
        f.write("\n")
    print(name, arr.shape, f"codes={st.n_codes} tight={st.n_tight} verbatim={st.n_verbatim}", len(buf))


def fold(arr):
    # Fold inside the chunk: reverse a patch of the first component's slope.
    arr[0, 6:10, 6:10, 6:10] = -3 * np.arange(6, 10, dtype=arr.dtype)[:, None, None]


def nonfinite(arr):
    arr.flat[17] = np.nan
    arr.flat[200] = np.inf
    arr.flat[201] = 1e30


case(
    "volume_jacobian",
    (3, 18, 21, 23),
    ["component", "spatial", "spatial", "spatial"],
    {"error_bound": 0.05, "jacobian": {"grid_spacing": [1.0, 1.0, 1.0], "min_det": 0.1}},
    tweak=fold,
)
case(
    "volume_component_last",
    (16, 16, 16, 3),
    ["spatial", "spatial", "spatial", "component"],
    {"error_bound": 0.25},
    seed=1,
)
case("image_linear", (33, 40, 2), ["spatial", "spatial", "component"], {"error_bound": 0.1, "predictor": "linear"}, seed=2)
case(
    "stack_cubic",
    (5, 30, 31, 2),
    ["independent", "spatial", "spatial", "component"],
    {"error_bound": 0.2, "predictor": "cubic", "face_error_bound": 0.1},
    seed=3,
)
case(
    "smooth_extrapolate_f64",
    (4, 19, 18, 2),
    ["smooth", "spatial", "spatial", "component"],
    {"error_bound": 0.02, "boundary": "extrapolate"},
    dtype="float64",
    tweak=nonfinite,
    seed=4,
)
