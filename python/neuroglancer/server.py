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

import asyncio
import concurrent.futures
import json
import multiprocessing
import os
import re
import socket
import subprocess
import sys
import threading
import weakref

import numpy as np
import tornado.httpserver
import tornado.netutil
import tornado.platform.asyncio
import tornado.web

from . import async_util, local_volume, skeleton, static
from .json_utils import encode_json, json_encoder_default
from .random_token import make_random_token
from .trackable_state import ConcurrentModificationError

INFO_PATH_REGEX = r"^/neuroglancer/info/(?P<token>[^/]+)$"
SKELETON_INFO_PATH_REGEX = r"^/neuroglancer/skeletoninfo/(?P<token>[^/]+)$"

DATA_PATH_REGEX = r"^/neuroglancer/(?P<data_format>[^/]+)/(?P<token>[^/]+)/(?P<scale_key>[^/]+)/(?P<start>[0-9]+(?:,[0-9]+)*)/(?P<end>[0-9]+(?:,[0-9]+)*)$"

SKELETON_PATH_REGEX = r"^/neuroglancer/skeleton/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$"

MESH_PATH_REGEX = r"^/neuroglancer/mesh/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$"

STATIC_PATH_REGEX = (
    r"^/v/(?P<viewer_token>[^/]+)/(?P<path>(?:[@a-zA-Z0-9_\-][@a-zA-Z0-9_\-./]*)?)$"
)

ACTION_PATH_REGEX = r"^/action/(?P<viewer_token>[^/]+)$"

VOLUME_INFO_RESPONSE_PATH_REGEX = (
    r"^/volume_response/(?P<viewer_token>[^/]+)/(?P<request_id>[^/]+)/info$"
)

VOLUME_CHUNK_RESPONSE_PATH_REGEX = (
    r"^/volume_response/(?P<viewer_token>[^/]+)/(?P<request_id>[^/]+)/chunk$"
)

EVENTS_PATH_REGEX = r"^/events/(?P<viewer_token>[^/]+)$"

SET_STATE_PATH_REGEX = r"^/state/(?P<viewer_token>[^/]+)$"

CREDENTIALS_PATH_REGEX = r"^/credentials/(?P<viewer_token>[^/]+)$"

global_static_content_source = None

global_server_args = dict(bind_address="127.0.0.1", bind_port=0)

debug = False

_IS_GOOGLE_COLAB = "google.colab" in sys.modules


def _get_server_url(bind_address: str, port: int) -> str:
    if _IS_GOOGLE_COLAB:
        return _get_colab_server_url(port)
    return _get_regular_server_url(bind_address, port)


def _get_regular_server_url(bind_address: str, port: int) -> str:
    if bind_address == "0.0.0.0" or bind_address == "::":
        hostname = socket.getfqdn()
    else:
        hostname = bind_address
    return f"http://{hostname}:{port}"


def _get_colab_server_url(port: int) -> str:
    import google.colab.output

    return google.colab.output.eval_js(f"google.colab.kernel.proxyPort({port})")


class Server(async_util.BackgroundTornadoServer):
    def __init__(self, bind_address="127.0.0.1", bind_port=0, token=None):
        super().__init__(daemon=True)
        self.viewers = weakref.WeakValueDictionary()
        self._bind_address = bind_address
        self._bind_port = bind_port
        if token is None:
            token = make_random_token()
        self.token = token
        self.executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=multiprocessing.cpu_count()
        )

    def _attempt_to_start_server(self):
        def log_function(handler):
            if debug:
                print(
                    "%d %s %.2fs"
                    % (
                        handler.get_status(),
                        handler.request.uri,
                        handler.request.request_time(),
                    )
                )

        app = self.app = tornado.web.Application(
            [
                (STATIC_PATH_REGEX, StaticPathHandler, dict(server=self)),
                (INFO_PATH_REGEX, VolumeInfoHandler, dict(server=self)),
                (SKELETON_INFO_PATH_REGEX, SkeletonInfoHandler, dict(server=self)),
                (DATA_PATH_REGEX, SubvolumeHandler, dict(server=self)),
                (SKELETON_PATH_REGEX, SkeletonHandler, dict(server=self)),
                (MESH_PATH_REGEX, MeshHandler, dict(server=self)),
                (ACTION_PATH_REGEX, ActionHandler, dict(server=self)),
                (
                    VOLUME_INFO_RESPONSE_PATH_REGEX,
                    VolumeInfoResponseHandler,
                    dict(server=self),
                ),
                (
                    VOLUME_CHUNK_RESPONSE_PATH_REGEX,
                    VolumeChunkResponseHandler,
                    dict(server=self),
                ),
                (EVENTS_PATH_REGEX, EventStreamHandler, dict(server=self)),
                (SET_STATE_PATH_REGEX, SetStateHandler, dict(server=self)),
                (CREDENTIALS_PATH_REGEX, CredentialsHandler, dict(server=self)),
            ],
            log_function=log_function,
        )
        self.http_server = tornado.httpserver.HTTPServer(
            app,
            # Allow very large requests to accommodate large screenshots.
            max_buffer_size=1024**3,
        )
        sockets = tornado.netutil.bind_sockets(
            port=self._bind_port, address=self._bind_address
        )
        self.http_server.add_sockets(sockets)
        actual_port = sockets[0].getsockname()[1]

        global global_static_content_source
        if global_static_content_source is None:
            global_static_content_source = static.get_default_static_content_source()
        self.port = actual_port
        self.server_url = _get_server_url(self._bind_address, actual_port)
        self.regular_server_url = _get_regular_server_url(
            self._bind_address, actual_port
        )
        self._credentials_manager = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.stop()

    def get_volume(self, key):
        dot_index = key.find(".")
        if dot_index == -1:
            return None
        viewer_token = key[:dot_index]
        volume_token = key[dot_index + 1 :]
        viewer = self.viewers.get(viewer_token)
        if viewer is None:
            return None
        return viewer.volume_manager.volumes.get(volume_token)


class BaseRequestHandler(tornado.web.RequestHandler):
    def initialize(self, server):
        self.server = server


class StaticPathHandler(BaseRequestHandler):
    def get(self, viewer_token, path):
        if (
            viewer_token != self.server.token
            and viewer_token not in self.server.viewers
        ):
            self.send_error(404)
            return
        try:
            query = self.request.query
            if query:
                query = f"?{query}"
            data, content_type = global_static_content_source.get(path, query)
        except ValueError as e:
            self.send_error(404, message=e.args[0])
            return
        self.set_header("Content-type", content_type)
        self.finish(data)


class ActionHandler(BaseRequestHandler):
    def post(self, viewer_token):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        action = json.loads(self.request.body)
        self.server.loop.call_soon(
            viewer.actions.invoke, action["action"], action["state"]
        )
        self.finish("")


class VolumeInfoResponseHandler(BaseRequestHandler):
    def post(self, viewer_token, request_id):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return

        info = json.loads(self.request.body)
        self.server.loop.call_soon(viewer._handle_volume_info_reply, request_id, info)
        self.finish("")


class VolumeChunkResponseHandler(BaseRequestHandler):
    def post(self, viewer_token, request_id):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return

        params = json.loads(self.get_argument("p"))
        data = self.request.body
        self.server.loop.call_soon(
            viewer._handle_volume_chunk_reply, request_id, params, data
        )
        self.finish("")


class EventStreamStateWatcher:
    def __init__(self, key: str, client_id: str, state, last_generation: str, wake_up):
        self.key = key
        self.state = state
        self.last_generation = last_generation
        self._wake_up = wake_up
        self._client_id = client_id
        state.add_changed_callback(wake_up)

    def unregister(self):
        self.state.remove_changed_callback(self._wake_up)

    def maybe_send_update(self, handler):
        raw_state, generation = self.state.raw_state_and_generation
        if generation == self.last_generation:
            return False
        if generation.startswith(self._client_id + "/"):
            return False
        self.last_generation = generation
        msg = {"k": self.key, "s": raw_state, "g": generation}
        handler.write(f"data: {encode_json(msg)}\n\n")
        if debug:
            print(f"data: {encode_json(msg)}\n\n")
        return True


class EventStreamHandler(BaseRequestHandler):
    async def get(self, viewer_token: str):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        self.set_header("content-type", "text/event-stream")
        self.set_header("cache-control", "no-cache")
        must_flush = True
        wake_event = asyncio.Event()
        self._wake_up = lambda: self.server.loop.call_soon_threadsafe(wake_event.set)
        client_id = self.get_query_argument("c")
        if client_id is None:
            raise tornado.web.HTTPError(400, "missing client_id")
        self._closed = False

        watchers = []

        def watch(key: str, state):
            last_generation = self.get_query_argument(f"g{key}")
            if last_generation is None:
                raise tornado.web.HTTPError(400, f"missing g{key}")
            watchers.append(
                EventStreamStateWatcher(
                    key=key,
                    state=state,
                    client_id=client_id,
                    wake_up=self._wake_up,
                    last_generation=last_generation,
                )
            )

        watch("c", viewer.config_state)
        if hasattr(viewer, "shared_state"):
            watch("s", viewer.shared_state)

        try:
            while True:
                wake_event.clear()
                if self._closed:
                    break
                try:
                    sent = False
                    for watcher in watchers:
                        sent = watcher.maybe_send_update(self) or sent
                    if sent:
                        self.flush()
                        if _IS_GOOGLE_COLAB:
                            # The proxy used by colab buffers the entire
                            # response.  Therefore we must end the response for
                            # the client to receive it.
                            break
                    elif must_flush:
                        self.flush()
                except tornado.iostream.StreamClosedError:
                    break
                await wake_event.wait()
                must_flush = False
        finally:
            for watcher in watchers:
                watcher.unregister()

    def on_connection_close(self):
        if debug:
            print("connection closed")
        super().on_connection_close()
        self._wake_up()
        self._closed = True


class SetStateHandler(BaseRequestHandler):
    def post(self, viewer_token: str):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        msg = json.loads(self.request.body)
        prev_generation = msg["pg"]
        generation = msg["g"]
        state = msg["s"]
        client_id = msg["c"]
        try:
            new_generation = viewer.set_state(
                state, f"{client_id}/{generation}", existing_generation=prev_generation
            )
            self.set_header("Content-type", "application/json")
            self.finish(json.dumps({"g": new_generation}))
        except ConcurrentModificationError:
            self.set_status(412)
            self.finish("")


class CredentialsHandler(BaseRequestHandler):
    async def post(self, viewer_token: str):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        if not viewer.allow_credentials:
            self.send_error(403)
            return
        if self.server._credentials_manager is None:
            from .default_credentials_manager import default_credentials_manager

            self.server._credentials_manager = default_credentials_manager
        msg = json.loads(self.request.body)
        invalid = msg.get("invalid")
        provider = self.server._credentials_manager.get(
            msg["key"], msg.get("parameters")
        )
        if provider is None:
            self.send_error(400)
            return
        try:
            credentials = await asyncio.wrap_future(provider.get(invalid))
            self.set_header("Content-type", "application/json")
            self.finish(json.dumps(credentials))
        except Exception:
            import traceback

            traceback.print_exc()
            self.send_error(401)


class VolumeInfoHandler(BaseRequestHandler):
    def get(self, token):
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, local_volume.LocalVolume):
            self.send_error(404)
            return
        self.finish(json.dumps(vol.info(), default=json_encoder_default).encode())


class SkeletonInfoHandler(BaseRequestHandler):
    def get(self, token):
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, skeleton.SkeletonSource):
            self.send_error(404)
            return
        self.finish(json.dumps(vol.info(), default=json_encoder_default).encode())


class SubvolumeHandler(BaseRequestHandler):
    async def get(self, data_format, token, scale_key, start, end):
        start_pos = np.array(start.split(","), dtype=np.int64)
        end_pos = np.array(end.split(","), dtype=np.int64)
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, local_volume.LocalVolume):
            self.send_error(404)
            return

        try:
            data, content_type = await asyncio.wrap_future(
                self.server.executor.submit(
                    vol.get_encoded_subvolume,
                    data_format=data_format,
                    start=start_pos,
                    end=end_pos,
                    scale_key=scale_key,
                )
            )
        except ValueError as e:
            self.send_error(400, message=e.args[0])
            return
        self.set_header("Content-type", content_type)
        self.finish(data)


class MeshHandler(BaseRequestHandler):
    async def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.get_volume(key)
        if vol is None or not isinstance(vol, local_volume.LocalVolume):
            self.send_error(404)
            return

        try:
            encoded_mesh = await asyncio.wrap_future(
                self.server.executor.submit(vol.get_object_mesh, object_id)
            )
        except local_volume.MeshImplementationNotAvailable:
            self.send_error(501, message="Mesh implementation not available")
            return
        except local_volume.MeshesNotSupportedForVolume:
            self.send_error(405, message="Meshes not supported for volume")
            return
        except local_volume.InvalidObjectIdForMesh:
            self.send_error(404, message="Mesh not available for specified object id")
            return
        except ValueError as e:
            self.send_error(400, message=e.args[0])
            return

        self.set_header("Content-type", "application/octet-stream")
        self.finish(encoded_mesh)


class SkeletonHandler(BaseRequestHandler):
    async def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.get_volume(key)
        if vol is None or not isinstance(vol, skeleton.SkeletonSource):
            self.send_error(404)
            return

        def get_encoded_skeleton(skeletons, object_id):
            skeleton = skeletons.get_skeleton(object_id)
            if skeleton is None:
                return None
            return skeleton.encode(skeletons)

        try:
            encoded_skeleton = await asyncio.wrap_future(
                self.server.executor.submit(get_encoded_skeleton, vol, object_id)
            )
        except Exception as e:
            self.send_error(500, message=e.args[0])
            return
        if encoded_skeleton is None:
            self.send_error(
                404, message="Skeleton not available for specified object id"
            )
            return
        self.set_header("Content-type", "application/octet-stream")
        self.finish(encoded_skeleton)


global_server = None
_global_server_lock = threading.Lock()


def _get_server_token():
    with _global_server_lock:
        if global_server is not None:
            return global_server.token
        token = make_random_token()
        global_server_args.update(token=token)
        return token


def set_static_content_source(*args, **kwargs):
    global global_static_content_source
    global_static_content_source = static.get_static_content_source(*args, **kwargs)


def set_dev_server_content_source():
    static_content_url = None
    root_dir = os.path.join(os.path.dirname(__file__), "..", "..")
    build_process = subprocess.Popen(
        [
            "npm",
            "run",
            "dev-server-python",
            "--",
            "--base",
            f"/v/{_get_server_token()}/",
            "--port=0",
        ],
        cwd=root_dir,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
    )

    try:
        future = concurrent.futures.Future()

        def thread_func(f):
            url = None
            for line in f:
                print(f"[dev-server] {line.rstrip()}")
                if url is None:
                    m = re.search(r"http://[^\s]+", line)
                    if m is not None:
                        url = m.group(0)
                        future.set_result(url)
            if url is None:
                future.set_result(None)

        thread = threading.Thread(target=thread_func, args=(build_process.stdout,))
        thread.daemon = True
        thread.start()

        static_content_url = future.result(timeout=10)
    except:
        build_process.terminate()
        raise

    set_static_content_source(url=static_content_url)


def set_server_bind_address(bind_address=None, bind_port=0):
    if bind_address is None:
        bind_address = "127.0.0.1"
    with _global_server_lock:
        global_server_args.update(bind_address=bind_address, bind_port=bind_port)


def is_server_running():
    with _global_server_lock:
        return global_server is not None


def stop():
    """Stop the server, invalidating any viewer URLs.

    This allows any previously-referenced data arrays to be garbage collected if there are no other
    references to them.
    """
    global global_server
    with _global_server_lock:
        server = global_server
        global_server = None
    if server is not None:
        server.stop()


def get_server_url():
    return global_server.server_url


def start():
    global global_server
    with _global_server_lock:
        if global_server is not None:
            return

        # Workaround https://bugs.python.org/issue37373
        # https://www.tornadoweb.org/en/stable/index.html#installation
        if sys.platform == "win32" and sys.version_info >= (3, 8):
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        global_server = Server(**global_server_args)


def register_viewer(viewer):
    start()
    global_server.viewers[viewer.token] = viewer


def defer_callback(callback, *args, **kwargs):
    """Register `callback` to run in the server event loop thread."""
    start()
    global_server.loop.call_soon_threadsafe(lambda: callback(*args, **kwargs))
