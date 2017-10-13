# @license
# Copyright 2017 Google Inc.
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

import numpy as np
import numbers

min_safe_integer = -9007199254740991
max_safe_integer = 9007199254740991

def json_encoder_default(obj):
    """JSON encoder function that handles some numpy types."""
    if isinstance(obj, numbers.Integral) and (obj < min_safe_integer or obj > max_safe_integer):
        return str(obj)
    if isinstance(obj, np.integer):
        return str(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return list(obj)
    elif isinstance(obj, (set, frozenset)):
        return list(obj)
    raise TypeError
