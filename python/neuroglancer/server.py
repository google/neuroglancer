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
import threading
import json
import socket
import re

try:
    # Python 2 case
    from SocketServer import ThreadingMixIn  # pylint: disable=import-error
    from BaseHTTPServer import HTTPServer, BaseHTTPRequestHandler  # pylint: disable=import-error
except ImportError:
    # Python 3 case
    from socketserver import ThreadingMixIn  # pylint: disable=import-error
    from http.server import HTTPServer, BaseHTTPRequestHandler  # pylint: disable=import-error

from .randomtoken import make_random_token
from . import static
from . import volume
from collections import OrderedDict

from tornado import web, ioloop
from sockjs.tornado import SockJSConnection, SockJSRouter

global_static_content_source = None
global_server_args = dict(bind_address='127.0.0.1', bind_port=8000)
global_server = None
debug = True


VOLUME_PATH_REGEX = re.compile(r'^/neuroglancer/([^/]+)/(.*)/?$')
STATIC_PATH_REGEX = re.compile(r'/static/([^/]+)/((?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$')

class Server(ThreadingMixIn, HTTPServer):
    def __init__(self, viewer, bind_address='127.0.0.1', bind_port=0):
        HTTPServer.__init__(self, (bind_address, bind_port), RequestHandler)
        self.daemon_threads = True
        self.volumes = dict()
        self.token = make_random_token()
        self.viewer = viewer
        global global_static_content_source
        if global_static_content_source is None:
            global_static_content_source = static.get_default_static_content_source()

        if bind_address == '0.0.0.0':
            hostname = socket.getfqdn()
        else:
            hostname = bind_address
        self.server_url = 'http://%s:%s' % (hostname, self.server_address[1])

    def start(self):
        self.serve_forever()

    def shutdown():
        self.shutdown()

    def handle_error(self, request, client_address):
        if debug:
            HTTPServer.handle_error(self, request, client_address)

class RequestHandler(BaseHTTPRequestHandler):

    def do_GET(self):  # pylint: disable=invalid-name
        m = re.match(VOLUME_PATH_REGEX, self.path)
        if m is not None:
            token, path  = m.groups()
            vol = self.server.volumes.get(token)
            if vol is None:
                self.send_error(404)
                return
            vol.handle_request(path, self)
            return
        m = re.match(STATIC_PATH_REGEX, self.path)
        if m is not None:
            self.handle_static_request(m.group(1), m.group(2))
            return
        self.send_error(404)
        
    def handle_static_request(self, token, path):
        if token != self.server.token:
            self.send_error(404)
        try:
            data, content_type = global_static_content_source.get(path)
        except ValueError as e:
            self.send_error(404, e.args[0])
            return
        self.send_response(200)
        self.send_header('Content-type', content_type)
        self.send_header('Content-length', len(data))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)   

    def log_message(self, format, *args):
        if debug:
            BaseHTTPRequestHandler.log_message(self, format, *args)



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
        global_server.shutdown()
        global_server = None

def get_server_url():
    return global_server.server_url

def start(viewer):
    global global_server
    if global_server is None:
        global_server = Server(viewer, **global_server_args)
        thread = threading.Thread(target=global_server.start)
        thread.daemon = True
        thread.start()

def register_volume(volume):
    global_server.volumes[volume.token] = volume
