# @license
# Copyright 2019 Google Inc.
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

# Generates the `first_bit_lookup_table` in `neuroglancer_draco.cc`.

bit_list = []

for i in range(256):
    bits = [b for b in range(8) if (i >> b) & 1]
    if not bits:
        bit = 0
    else:
        bit = bits[0]

    bit_list.append(bit)

print('{' + ', '.join(str(b) for b in bit_list) + '}')
