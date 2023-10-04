# @license
# Copyright 2023 Google Inc.
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

import asyncio
import concurrent.futures
import threading

import tornado.platform.asyncio


class BackgroundTornadoServerMetaclass(type):
    def __call__(cls, *args, **kwargs):
        obj = type.__call__(cls, *args, **kwargs)
        obj.__post_init__()
        return obj


class BackgroundTornadoServer(metaclass=BackgroundTornadoServerMetaclass):
    def __init__(self, daemon=False):
        self._thread = threading.Thread(target=self._run_server)
        if daemon:
            self._thread.daemon = True
        self._started = concurrent.futures.Future()
        self._stop_lock = threading.Lock()
        self._stop_requested = False

    def __post_init__(self):
        self._thread.start()
        try:
            self._started.result()
        except:
            self._thread.join()
            raise

    def _run_server(self):
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            tornado.platform.asyncio.AsyncIOMainLoop()
            self.loop = loop
            loop.call_soon(self._start_server)
            loop.run_forever()
            loop.close()
        except Exception as exc:
            self._started.set_exception(exc)

    def _attempt_to_start_server(self):
        raise NotImplementedError

    def _start_server(self):
        try:
            self._attempt_to_start_server()
            self._started.set_result(None)
        except Exception as e:
            self.loop.stop()
            self._started.set_exception(e)

    def request_stop(self):
        with self._stop_lock:
            if not self._stop_requested:
                self._stop_requested = True
                self.loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(self._stop())
                )

    def stop(self):
        self.request_stop()
        self._thread.join()

    async def _stop(self):
        self.http_server.stop()
        await tornado.platform.asyncio.to_asyncio_future(
            self.http_server.close_all_connections()
        )
        self.loop.stop()
