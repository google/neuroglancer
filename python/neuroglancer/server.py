# @license
# Copyright 2016 Google Inc.
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

import weakref

import sockjs.tornado
import tornado.ioloop
import tornado.web
import tornado.httpserver
import tornado.netutil

import threading
import socket
import json
from .token import make_random_token
from . import static
from . import volume
from .trackable import TrackableContext

from .operational_transformation import make_operation_from_state
from .operational_transformation import default_json_encode

INFO_PATH_REGEX = r'^/neuroglancer/info/([^/]+)$'

DATA_PATH_REGEX = r'^/neuroglancer/([^/]+)/([^/]+)/([^/]+)/([0-9]+),([0-9]+)/([0-9]+),([0-9]+)/([0-9]+),([0-9]+)$'

MESH_PATH_REGEX = r'^/neuroglancer/mesh/([^/]+)/([0-9]+)$'

STATIC_PATH_REGEX = r'/static/([^/]+)/((?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$'

global_static_content_source = None

global_server_args = dict(bind_address='127.0.0.1', bind_port=0)

debug = False

class Server(object):
    def __init__(self, ioloop, bind_address='127.0.0.1', bind_port=0):
        self.volumes = dict()
        self.viewers = weakref.WeakValueDictionary()
        self.token = make_random_token()

        self.ioloop = ioloop
        sockjs_router = sockjs.tornado.SockJSRouter(
            SockJSHandler, '/socket/' + self.token, io_loop=ioloop)
        sockjs_router.neuroglancer_server = self
        app = self.app = tornado.web.Application([
            (STATIC_PATH_REGEX, StaticPathHandler, dict(server=self)),
            (INFO_PATH_REGEX, VolumeInfoHandler, dict(server=self)),
            (DATA_PATH_REGEX, SubvolumeHandler, dict(server=self)),
            (MESH_PATH_REGEX, MeshHandler, dict(server=self)),
        ] + sockjs_router.urls)
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


class BaseRequestHandler(tornado.web.RequestHandler):
    def initialize(self, server):
        self.server = server


class SockJSHandler(sockjs.tornado.SockJSConnection):
    def on_open(self, info):
        server = self.session.server.neuroglancer_server
        viewerToken = self.viewerToken = info.get_argument('v')
        viewer = self.viewer = server.viewers.get(viewerToken)
        viewer.managed_state.add_client(self)
        self.last_op_id = None
        self.last_generation = None

        if viewer is None:
            self.close()
            return

    def on_message(self, message_text):
        managed_state = self.viewer.managed_state
        try:
            message = json.loads(message_text)
            if isinstance(message, dict):
                print('got message: ' + repr(message))
                t = message['t']
                if t == 'getState':
                    self.last_generation = managed_state.generation
                    self.send(
                        json.dumps(
                            {
                                't': 'setState',
                                'g': managed_state.generation,
                                's': managed_state.cumulative_op,
                            },
                            default=default_json_encode))
                    return
                if t == 'update':
                    state_generation = message['g']
                    op_id = message['i']
                    client_op = message['o']
                    self.last_generation = state_generation
                    if op_id is not None:
                        self.last_op_id = op_id
                        managed_state.apply_change(state_id=state_generation,
                                                   op_id=op_id,
                                                   client_op=client_op)
                    self.on_new_operation()
                    return
        except:
            import pdb
            pdb.post_mortem()
            # import traceback
            # traceback.print_exc()
            # Ignore malformed JSON

    def on_new_operation(self):
        print('on_new_operation')
        last_generation = self.last_generation
        if last_generation is None:
            print('  skipping due to last_generation =None')
            # We don't yet have the base generation for this client
            return

        op = self.viewer.managed_state.get_update(
            state_id=last_generation, op_id_to_skip=self.last_op_id)
        generation = self.last_generation = self.viewer.managed_state.generation
        if op is not None or self.last_op_id is not None:
            print('  sending update to client, last_op_id=%r' % (self.last_op_id,))
            message = {
                't': 'update',
                'g': generation,
                'o': op,
                'a': self.last_op_id,
            }
            self.send(json.dumps(message))
            self.last_op_id = None
        else:
            print('  skipping due to op being None')

    def on_close(self):
        self.viewer.managed_state.remove_client(self)


class StaticPathHandler(BaseRequestHandler):
    def get(self, token, path):
        if token != self.server.token:
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
        vol = self.server.volumes.get(token)
        if vol is None:
            self.send_error(404)
            return
        self.finish(vol.info())


class SubvolumeHandler(BaseRequestHandler):
    def get(self, data_format, token, scale_key, start_x, end_x, start_y, end_y, start_z, end_z):
        start = (int(start_x), int(start_y), int(start_z))
        end = (int(end_x), int(end_y), int(end_z))
        vol = self.server.volumes.get(token)
        if vol is None:
            self.send_error(404)
            return
        try:
            data, content_type = vol.get_encoded_subvolume(
                data_format, start, end, scale_key=scale_key)
        except ValueError as e:
            self.send_error(400, message=e.args[0])
            return

        self.set_header('Content-type', content_type)
        self.finish(data)


class MeshHandler(BaseRequestHandler):
    def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.volumes.get(key)
        if vol is None:
            self.send_error(404)
        try:
            encoded_mesh = vol.get_object_mesh(object_id)
        except volume.MeshImplementationNotAvailable:
            self.send_error(501, message='Mesh implementation not available')
            return
        except volume.MeshesNotSupportedForVolume:
            self.send_error(405, message='Meshes not supported for volume')
            return
        except volume.InvalidObjectIdForMesh:
            self.send_error(404, message='Mesh not available for specified object id')
            return
        except ValueError as e:
            self.send_error(400, message=e.args[0])
            return

        self.set_header('Content-type', 'application/octet-stream')
        self.finish(encoded_mesh)


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
        global_server = Server(ioloop=ioloop, **global_server_args)
        thread = threading.Thread(target=ioloop.start)
        thread.daemon = True
        thread.start()


def register_volume(vol):
    start()
    global_server.volumes[vol.token] = vol

def register_viewer(viewer):
    start()
    global_server.viewers[viewer.token] = viewer

def make_context():
    start()
    return TrackableContext(global_server.ioloop)
