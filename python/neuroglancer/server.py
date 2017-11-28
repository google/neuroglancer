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
import threading
import weakref

import tornado.httpserver
import tornado.ioloop
import tornado.netutil
import tornado.web

import sockjs.tornado

from . import local_volume, static
from .json_utils import json_encoder_default
from .random_token import make_random_token
from .sockjs_handler import SOCKET_PATH_REGEX, SOCKET_PATH_REGEX_WITHOUT_GROUP, SockJSHandler

INFO_PATH_REGEX = r'^/neuroglancer/info/(?P<token>[^/]+)$'

DATA_PATH_REGEX = r'^/neuroglancer/(?P<data_format>[^/]+)/(?P<token>[^/]+)/(?P<scale_key>[^/]+)/(?P<start_x>[0-9]+),(?P<end_x>[0-9]+)/(?P<start_y>[0-9]+),(?P<end_y>[0-9]+)/(?P<start_z>[0-9]+),(?P<end_z>[0-9]+)$'

SKELETON_PATH_REGEX = r'^/neuroglancer/skeleton/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

MESH_PATH_REGEX = r'^/neuroglancer/mesh/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

STATIC_PATH_REGEX = r'^/v/(?P<viewer_token>[^/]+)/(?P<path>(?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$'

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
        def log_function(request_handler):
            pass
        app = self.app = tornado.web.Application([
            (STATIC_PATH_REGEX, StaticPathHandler, dict(server=self)),
            (INFO_PATH_REGEX, VolumeInfoHandler, dict(server=self)),
            (DATA_PATH_REGEX, SubvolumeHandler, dict(server=self)),
            (SKELETON_PATH_REGEX, SkeletonHandler, dict(server=self)),
            (MESH_PATH_REGEX, MeshHandler, dict(server=self)),
        ] + sockjs_router.urls, log_function=log_function)
        http_server = tornado.httpserver.HTTPServer(app)
        sockets = tornado.netutil.bind_sockets(port=bind_port, address=bind_address)
        http_server.add_sockets(sockets)
        actual_port = sockets[0].getsockname()[1]

        global global_static_content_source
        if global_static_content_source is None:
            global_static_content_source = static.get_default_static_content_source()

        if bind_address == '0.0.0.0':
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


class VolumeInfoHandler(BaseRequestHandler):
    def get(self, token):
        vol = self.server.get_volume(token)
        if vol is None:
            self.send_error(404)
            return
        self.finish(json.dumps(vol.info(), default=json_encoder_default).encode())


class SubvolumeHandler(BaseRequestHandler):
    @tornado.web.asynchronous
    def get(self, data_format, token, scale_key, start_x, end_x, start_y, end_y, start_z, end_z):
        start = (int(start_x), int(start_y), int(start_z))
        end = (int(end_x), int(end_y), int(end_z))
        vol = self.server.get_volume(token)
        if vol is None:
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
            data_format, start, end, scale_key=scale_key).add_done_callback(
                lambda f: self.server.ioloop.add_callback(lambda: handle_subvolume_result(f)))


class MeshHandler(BaseRequestHandler):
    @tornado.web.asynchronous
    def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.get_volume(key)
        if vol is None:
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
    @tornado.web.asynchronous
    def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.get_volume(key)
        if vol is None:
            self.send_error(404)
        if vol.skeletons is None:
            self.send_error(405, message='Skeletons not supported for volume')
            return

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
            get_encoded_skeleton, vol.skeletons, object_id).add_done_callback(
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
            ioloop.close()
        global_server.ioloop.add_callback(stop_ioloop)
        global_server = None


def get_server_url():
    return global_server.server_url


def start():
    global global_server
    if global_server is None:
        ioloop = tornado.ioloop.IOLoop()
        ioloop.make_current()
        global_server = Server(ioloop=ioloop, **global_server_args)
        thread = threading.Thread(target=ioloop.start)
        thread.daemon = True
        thread.start()


def register_viewer(viewer):
    start()
    global_server.viewers[viewer.token] = viewer

def defer_callback(callback, *args, **kwargs):
    """Register `callback` to run in the server event loop thread."""
    start()
    global_server.ioloop.add_callback(lambda: callback(*args, **kwargs))
