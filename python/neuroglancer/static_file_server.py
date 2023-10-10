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


import tornado.httpserver
import tornado.netutil
import tornado.web

import neuroglancer.random_token
import neuroglancer.server

from . import async_util


class CorsStaticFileHandler(tornado.web.StaticFileHandler):
    def set_default_headers(self):
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Headers", "x-requested-with, range")
        self.set_header("Access-Control-Expose-Headers", "content-range")
        self.set_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def options(self, *args):
        self.set_status(204)
        self.finish()


class StaticFileServer(async_util.BackgroundTornadoServer):
    def __init__(
        self, static_dir: str, bind_address: str = "localhost", daemon=False
    ) -> None:
        super().__init__(daemon=daemon)
        self.bind_address = bind_address
        self.static_dir = static_dir

    def __enter__(self):
        return self.url

    def __exit__(self, exc_type, exc_value, traceback):
        self.stop()

    def _attempt_to_start_server(self):
        token = neuroglancer.random_token.make_random_token()
        handlers = [
            (rf"/{token}/(.*)", CorsStaticFileHandler, {"path": self.static_dir}),
        ]
        settings = {}
        self.app = tornado.web.Application(handlers, settings=settings)
        self.http_server = tornado.httpserver.HTTPServer(self.app)
        sockets = tornado.netutil.bind_sockets(port=0, address=self.bind_address)
        self.http_server.add_sockets(sockets)
        actual_port = sockets[0].getsockname()[1]
        server_url = neuroglancer.server._get_server_url(self.bind_address, actual_port)
        self.url = f"{server_url}/{token}"
