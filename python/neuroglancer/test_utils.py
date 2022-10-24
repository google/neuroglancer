# @license
# Copyright 2022 Google Inc.
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

import time
from typing import Callable, TypeVar, Type, Tuple


T = TypeVar("T")


def retry(func: Callable[[], T], max_attempts: int,
          delay: float = 0.01,
          exceptions: Tuple[Type[Exception], ...] = (Exception,)) -> T:
    """Invokes `func` up to `max_attempts` times.

    Reties after a delay of `delay` if an exception in `exceptions` is raised.

    Args:
      func: Function to call.
      max_attempts: Maximum number of attempts.
      delay: Delay in seconds between attempts.
      exceptions: Exceptions upon which to retry.
    Returns:
      Result of successful call.
    Raises:
      First exception not in `exceptions`, or any exception on last attempt.
    """
    for i in range(max_attempts-1):
        try:
            return func()
        except exceptions:
            time.sleep(delay)
    return func()
