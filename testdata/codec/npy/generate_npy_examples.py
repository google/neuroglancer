#!/usr/bin/env python3

# @license
# Copyright 2016 Google Inc.
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

# This file generates npy_test.*.{npy,json} files for use by
# src/util/npy.spec.ts.
#
# This should be run from within the testdata/ directory.

import json

import numpy as np


def write_array(array):
    dtype = array.dtype
    if dtype == np.uint8:
        byte_orders = [("=", "")]
    else:
        byte_orders = [("<", "-le"), (">", "-be")]
    for byte_order_i, (byte_order, byte_order_name) in enumerate(byte_orders):
        new_array = np.array(array, dtype=dtype.newbyteorder(byte_order))
        name = f"npy_test.{dtype.name}{byte_order_name}"
        np.save(name, new_array)
    array_for_json = array
    if dtype == np.uint64:
        array_for_json = np.asarray(array, dtype=np.dtype("<u8")).view("<u4")
    if dtype == np.float32:
        array_for_json = np.asarray(array_for_json, dtype=float)
    else:
        array_for_json = np.asarray(array_for_json, dtype=int)
    json_type = float if dtype.kind == "f" else int
    json_obj = dict(
        dataType=dtype.name,
        shape=array.shape,
        data=list(json_type(x) for x in array_for_json.ravel()),
    )
    with open("npy_test.%s.json" % dtype.name, "w") as f:
        f.write(json.dumps(json_obj))


gen = np.random.default_rng(seed=0)
shape = (3, 4, 5)


def write_int_array(dtype):
    dtype = np.dtype(dtype)
    info = np.iinfo(dtype)
    write_array(gen.randint(low=info.min, high=info.max + 1, size=shape, dtype=dtype))


write_int_array(np.uint8)
write_int_array(np.uint16)
write_int_array(np.uint32)
write_int_array(np.uint64)
write_array(np.asarray(gen.standard_normal(shape), dtype=np.float32))
