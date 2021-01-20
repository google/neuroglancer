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

from __future__ import absolute_import, print_function

import concurrent.futures
import json
import multiprocessing
import re
import socket
import sys
import threading
import weakref

import numpy as np
import tornado.httpserver
import tornado.ioloop
import tornado.netutil
import tornado.web

import sockjs.tornado

try:
    # Newer versions of tornado do not have the asynchronous decorator
    from sockjs.tornado.util import asynchronous
except ImportError:
    from tornado.web import asynchronous

from . import local_volume, static
from . import skeleton
from .json_utils import json_encoder_default
from .random_token import make_random_token
from .sockjs_handler import SOCKET_PATH_REGEX, SOCKET_PATH_REGEX_WITHOUT_GROUP, SockJSHandler

INFO_PATH_REGEX = r'^/neuroglancer/info/(?P<token>[^/]+)$'
SKELETON_INFO_PATH_REGEX = r'^/neuroglancer/skeletoninfo/(?P<token>[^/]+)$'

DATA_PATH_REGEX = r'^/neuroglancer/(?P<data_format>[^/]+)/(?P<token>[^/]+)/(?P<scale_key>[^/]+)/(?P<start>[0-9]+(?:,[0-9]+)*)/(?P<end>[0-9]+(?:,[0-9]+)*)$'

SKELETON_PATH_REGEX = r'^/neuroglancer/skeleton/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

MESH_PATH_REGEX = r'^/neuroglancer/mesh/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

STATIC_PATH_REGEX = r'^/v/(?P<viewer_token>[^/]+)/(?P<path>(?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$'

ACTION_PATH_REGEX = r'^/action/(?P<viewer_token>[^/]+)$'

global_static_content_source = None

global_server_args = dict(bind_address='127.0.0.1', bind_port=0)

debug = False

class Server(object):
    def __init__(self, ioloop, bind_address='127.0.0.1', bind_port=0):
        self.viewers = weakref.WeakValueDictionary()
        self.token = make_random_token()
        self.executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=multiprocessing.cpu_count())

        self.ioloop = ioloop
        sockjs_router = sockjs.tornado.SockJSRouter(
            SockJSHandler, SOCKET_PATH_REGEX_WITHOUT_GROUP, io_loop=ioloop)
        sockjs_router.neuroglancer_server = self
        def log_function(handler):
            if debug:
                print("%d %s %.2fs" % (handler.get_status(),
                                       handler.request.uri, handler.request.request_time()))

        app = self.app = tornado.web.Application(
            [
                (STATIC_PATH_REGEX, StaticPathHandler, dict(server=self)),
                (INFO_PATH_REGEX, VolumeInfoHandler, dict(server=self)),
                (SKELETON_INFO_PATH_REGEX, SkeletonInfoHandler, dict(server=self)),
                (DATA_PATH_REGEX, SubvolumeHandler, dict(server=self)),
                (SKELETON_PATH_REGEX, SkeletonHandler, dict(server=self)),
                (MESH_PATH_REGEX, MeshHandler, dict(server=self)),
                (ACTION_PATH_REGEX, ActionHandler, dict(server=self)),
            ] + sockjs_router.urls,
            log_function=log_function,
            # Set a large maximum message size to accommodate large screenshot
            # messages.
            websocket_max_message_size=100 * 1024 * 1024)
        http_server = tornado.httpserver.HTTPServer(
            app,
            # Allow very large requests to accommodate large screenshots.
            max_buffer_size=1024**3,
        )
        sockets = tornado.netutil.bind_sockets(port=bind_port, address=bind_address)
        http_server.add_sockets(sockets)
        actual_port = sockets[0].getsockname()[1]

        global global_static_content_source
        if global_static_content_source is None:
            global_static_content_source = static.get_default_static_content_source()

        if bind_address == '0.0.0.0' or bind_address == '::':
            hostname = socket.getfqdn()
        else:
            hostname = bind_address

        self.server_url = 'http://%s:%s' % (hostname, actual_port)

    def get_volume(self, key):
        dot_index = key.find('.')
        if dot_index == -1:
            return None
        viewer_token = key[:dot_index]
        volume_token = key[dot_index+1:]
        viewer = self.viewers.get(viewer_token)
        if viewer is None:
            return None
        return viewer.volume_manager.volumes.get(volume_token)


class BaseRequestHandler(tornado.web.RequestHandler):
    def initialize(self, server):
        self.server = server

class StaticPathHandler(BaseRequestHandler):
    def get(self, viewer_token, path):
        if viewer_token != self.server.token and viewer_token not in self.server.viewers:
            self.send_error(404)
            return
        try:
            data, content_type = global_static_content_source.get(path)
        except ValueError as e:
            self.send_error(404, message=e.args[0])
            return
        self.set_header('Content-type', content_type)
        self.finish(data)

class ActionHandler(BaseRequestHandler):
    def post(self, viewer_token):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        action = json.loads(self.request.body)
        self.server.ioloop.add_callback(viewer.actions.invoke, action['action'], action['state'])
        self.finish('')

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
    @asynchronous
    def get(self, data_format, token, scale_key, start, end):
        start_pos = np.array(start.split(','), dtype=np.int64)
        end_pos = np.array(end.split(','), dtype=np.int64)
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, local_volume.LocalVolume):
            self.send_error(404)
            return

        def handle_subvolume_result(f):
            try:
                data, content_type = f.result()
            except ValueError as e:
                self.send_error(400, message=e.args[0])
                return

            self.set_header('Content-type', content_type)
            self.finish(data)

        self.server.executor.submit(
            vol.get_encoded_subvolume,
            data_format=data_format, start=start_pos, end=end_pos, scale_key=scale_key).add_done_callback(
                lambda f: self.server.ioloop.add_callback(lambda: handle_subvolume_result(f)))


class MeshHandler(BaseRequestHandler):
    @asynchronous
    def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.get_volume(key)
        if vol is None or not isinstance(vol, local_volume.LocalVolume):
            self.send_error(404)
            return

        def handle_mesh_result(f):
            try:
                encoded_mesh = f.result()
            except local_volume.MeshImplementationNotAvailable:
                self.send_error(501, message='Mesh implementation not available')
                return
            except local_volume.MeshesNotSupportedForVolume:
                self.send_error(405, message='Meshes not supported for volume')
                return
            except local_volume.InvalidObjectIdForMesh:
                self.send_error(404, message='Mesh not available for specified object id')
                return
            except ValueError as e:
                self.send_error(400, message=e.args[0])
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.finish(encoded_mesh)

        self.server.executor.submit(vol.get_object_mesh, object_id).add_done_callback(
            lambda f: self.server.ioloop.add_callback(lambda: handle_mesh_result(f)))


class SkeletonHandler(BaseRequestHandler):
    @asynchronous
    def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.get_volume(key)
        if vol is None or not isinstance(vol, skeleton.SkeletonSource):
            self.send_error(404)

        def handle_result(f):
            try:
                encoded_skeleton = f.result()
            except:
                self.send_error(500, message=e.args[0])
                return
            if encoded_skeleton is None:
                self.send_error(404, message='Skeleton not available for specified object id')
                return
            self.set_header('Content-type', 'application/octet-stream')
            self.finish(encoded_skeleton)

        def get_encoded_skeleton(skeletons, object_id):
            skeleton = skeletons.get_skeleton(object_id)
            if skeleton is None:
                return None
            return skeleton.encode(skeletons)

        self.server.executor.submit(
            get_encoded_skeleton, vol, object_id).add_done_callback(
                lambda f: self.server.ioloop.add_callback(lambda: handle_result(f)))


global_server = None


def set_static_content_source(*args, **kwargs):
    global global_static_content_source
    global_static_content_source = static.get_static_content_source(*args, **kwargs)


def set_server_bind_address(bind_address='127.0.0.1', bind_port=0):
    global global_server_args
    global_server_args = dict(bind_address=bind_address, bind_port=bind_port)


def is_server_running():
    return global_server is not None


def stop():
    """Stop the server, invalidating any viewer URLs.

    This allows any previously-referenced data arrays to be garbage collected if there are no other
    references to them.
    """
    global global_server
    if global_server is not None:
        ioloop = global_server.ioloop
        def stop_ioloop():
            ioloop.stop()
        global_server.ioloop.add_callback(stop_ioloop)
        global_server = None


def get_server_url():
    return global_server.server_url


_global_server_lock = threading.Lock()


def start():
    global global_server
    with _global_server_lock:
        if global_server is not None: return

        # Workaround https://bugs.python.org/issue37373
        # https://www.tornadoweb.org/en/stable/index.html#installation
        if sys.platform == 'win32' and sys.version_info >= (3, 8):
            import asyncio
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

        done = threading.Event()

        def start_server():
            global global_server
            ioloop = tornado.ioloop.IOLoop()
            ioloop.make_current()
            global_server = Server(ioloop=ioloop, **global_server_args)
            done.set()
            ioloop.start()
            ioloop.close()

        thread = threading.Thread(target=start_server)
        thread.daemon = True
        thread.start()
        done.wait()


def register_viewer(viewer):
    start()
    global_server.viewers[viewer.token] = viewer

def defer_callback(callback, *args, **kwargs):
    """Register `callback` to run in the server event loop thread."""
    start()
    global_server.ioloop.add_callback(lambda: callback(*args, **kwargs))
