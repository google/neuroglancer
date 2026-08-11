#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy",
#     "crackle-codec",
# ]
# ///

# @license
# Copyright 2026 William Silversmith
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

# This file generates crackle (.ckl) files for use by
# tests/codec/crackle.spec.ts.
#
# This should be run from within the testdata/ directory.

import crackle
import numpy as np

ones = np.ones([32,32,32], dtype=np.uint8, order="F")

crackle.save(ones, "ones1.ckl")
crackle.save(ones.astype(np.uint16), "ones2.ckl")
crackle.save(ones.astype(np.uint32), "ones4.ckl")
crackle.save(ones.astype(np.uint64), "ones8.ckl")
crackle.save(ones, "ones_pins.ckl", allow_pins=True)

zeros = np.zeros([32,32,32], dtype=np.uint8, order="F")

crackle.save(zeros, "zeros1.ckl")
crackle.save(zeros.astype(np.uint16), "zeros2.ckl")
crackle.save(zeros.astype(np.uint32), "zeros4.ckl")
crackle.save(zeros.astype(np.uint64), "zeros8.ckl")

pinky40 = np.load("pinky40.npy")
crackle.save(pinky40, "pinky40.ckl")
crackle.save(pinky40, "pinky40_m4.ckl", markov_model_order=4)
crackle.save(pinky40, "pinky40_m4pins.ckl", markov_model_order=4, allow_pins=True)
crackle.save(pinky40, "pinky40_pins.ckl", allow_pins=True)

random_data = np.load("random.npy")
crackle.save(random_data, "random.ckl")



