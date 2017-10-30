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

"""Various extensions to the concurrent.futures module."""

from __future__ import absolute_import

import concurrent.futures
import threading


def future_then_immediate(future, func):
    """Returns a future that maps the result of `future` by `func`.

    If `future` succeeds, sets the result of the returned future to `func(future.result())`.  If
    `future` fails or `func` raises an exception, the exception is stored in the returned future.

    If `future` has not yet finished, `func` is invoked by the same thread that finishes it.
    Otherwise, it is invoked immediately in the same thread that calls `future_then_immediate`.
    """
    result = concurrent.futures.Future()

    def on_done(f):
        try:
            result.set_result(func(f.result()))
        except Exception as e:
            result.set_exception(e)

    future.add_done_callback(on_done)
    return result


def run_on_new_thread(func, daemon=True):
    """Calls `func()` from a new thread.

    :param daemon: Specifies whether the thread should be in daemon mode.

    :returns: A concurrent.futures.Future object representing the result.
    """
    f = concurrent.futures.Future()
    def wrapper():
        if not f.set_running_or_notify_cancel():
            return
        try:
            f.set_result(func())
        except Exception as e:
            f.set_exception(e)
    t = threading.Thread(target=wrapper)
    t.daemon = daemon
    t.start()
    return f
