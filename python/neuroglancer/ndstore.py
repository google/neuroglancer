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

from __future__ import print_function

try:
  # Python 2 case
  from SocketServer import ThreadingMixIn
  from BaseHTTPServer import HTTPServer, BaseHTTPRequestHandler
  from urllib import quote as urlquote
except ImportError:
  # Python 3 case
  from socketserver import ThreadingMixIn
  from http.server import HTTPServer, BaseHTTPRequestHandler
  from urllib.parse import quote as urlquote

import threading
import re
import os
import collections
import json
import posixpath
import io
import time
import shutil
from volume import ServedVolume
from chunks import encode_jpeg, encode_npz, encode_raw
from token import make_random_token
from static import content

info_path_regex = re.compile(r'^/ocp/ca/([^/]+)/info/$')

data_path_regex = re.compile(r'^/ocp/ca/([^/]+)/channel/([^/]+)/0/([0-9]+),([0-9]+)/([0-9]+),([0-9]+)/([0-9]+),([0-9]+)/neariso/')

static_path_regex = re.compile(r'/static/([^/]+)/((?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$')

mime_type_map = {
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.html': 'text/html',
    '.map': 'application/json'
}

def guess_mime_type_from_path(path):
  return mime_type_map.get(posixpath.splitext(path)[1],
                           'application/octet-stream')

class NDStoreCompatibleServer(ThreadingMixIn, HTTPServer):
  def __init__(self,
               bind_address='127.0.0.1',
               bind_port=8888,
               static_file_open=open,
               static_file_path=None):
    HTTPServer.__init__(self, (bind_address, bind_port), NDStoreCompatibleRequestHandler)
    self.daemon_threads = True
    if static_file_path is None:
      static_file_path = os.path.join(os.path.dirname(__file__), '../dist/dev')
    self.static_file_path = static_file_path
    self.static_file_open = static_file_open
    self.volumes = dict()
    self.token = make_random_token()

num_requests = 0

class NDStoreCompatibleRequestHandler(BaseHTTPRequestHandler):
  protocol_version = 'HTTP/1.1'
  def do_GET(self):
    #print('GET %s' % self.path)

    m = re.match(info_path_regex, self.path)
    if m is not None:
      self.handle_info_request(m.group(1))
      return
    m = re.match(data_path_regex, self.path)
    if m is not None:
      global num_requests
      start_time = time.time()
      self.handle_data_request(
          token=m.group(1),
          data_format=m.group(2),
          start=(int(m.group(3)), int(m.group(5)), int(m.group(7))),
          end=(int(m.group(4)), int(m.group(6)), int(m.group(8))))
      end_time = time.time()
      num_requests += 1
      # print('Request %d took %.4f' % (num_requests, end_time - start_time))
      return
    m = re.match(static_path_regex, self.path)
    if m is not None:
      self.handle_static_request(m.group(1), m.group(2))
      return
    self.send_error(404)

  def handle_static_request(self, token, path):
    if token != self.server.token:
      self.send_error(404)
    if path == '':
      path = 'index.html'
    try:
      mime_type = guess_mime_type_from_path(path)
      data = content[path]
      self.send_response(200)
      self.send_header('Content-type', mime_type)
      self.send_header('Content-length', len(data))
      self.end_headers()
      self.wfile.write(data)
    except Exception as e:
      self.send_error(404)

  def handle_data_request(self, token, data_format, start, end):

    volume = self.server.volumes.get(token)
    if volume is None:
      self.send_error(404)
    offset = volume.offset
    shape = volume.shape
    for i in xrange(3):
      if offset[i] > start[i] or end[i] - offset[i] > shape[i]:
        self.send_error(404, 'Out of bounds data request.')
        return

    subvol = volume.data[start[2]:end[2]-offset[2],start[1]:end[1]-offset[1],start[0]:end[0]-offset[0]]
    content_type = 'application/octet-stream'
    if data_format == 'jpeg':
      data = encode_jpeg(subvol)
      content_type = 'image/jpeg'
    elif data_format == 'npz':
      data = encode_npz(subvol)
    elif data_format == 'raw':
      data = encode_raw(subvol)
    else:
      self.send_error(400, 'Invalid data format requested.')
      return
    self.send_response(200)
    self.send_header('Content-type', content_type)
    self.send_header('Content-length', len(data))
    self.send_header('Access-Control-Allow-Origin', '*')
    self.end_headers()
    self.wfile.write(data)

  def handle_info_request(self, token):
    volume = self.server.volumes.get(token)
    if volume is None:
      self.send_error(404)
    info = dict(
        channels=dict(
            channel=dict(
                channel_type=volume.channel_type,
                datatype=volume.data_type,
                description='channel',
            ),
        ),
        dataset=dict(
            resolutions=[0],
            neariso_voxelres={
                '0': volume.voxel_size,
            },
            neariso_offset={
                '0': volume.offset,
            },
            neariso_imagesize={
                '0': volume.shape,
            },
        ),
    )
    data = json.dumps(info)
    self.send_response(200)
    self.send_header('Content-type', 'application/json')
    self.send_header('Content-length', len(data))
    self.send_header('Access-Control-Allow-Origin', '*')
    self.end_headers()
    self.wfile.write(data)

global_server = None

def stop():
  global global_server
  if global_server is not None:
    global_server.shutdown()
    global_server = None

def serve(layers, voxel_size=(1,1,1),
          server_args=dict()):
  global global_server
  if global_server is None:
    global_server = NDStoreCompatibleServer(**server_args)
    thread = threading.Thread(target=lambda: global_server.serve_forever())
    thread.daemon = True
    thread.start()

  sources = []
  for name, spec in layers:
    if isinstance(spec, str):
      sources.append((name, spec))
    else:
      cur_voxel_size = voxel_size
      offset = (0, 0, 0)
      if hasattr(spec, 'attrs'):
        if 'resolution' in spec.attrs:
          cur_voxel_size = tuple(spec.attrs['resolution'])[::-1]
        if 'offset' in spec.attrs:
          offset = tuple(spec.attrs['offset'])[::-1]
      volume = ServedVolume(data=spec, voxel_size=cur_voxel_size, offset=offset)
      global_server.volumes[volume.token] = volume
      sources.append((name, volume))
  output_layers = collections.OrderedDict()
  server_base_url = 'http://%s:%d' % global_server.server_address
  for name, spec in sources:
    if isinstance(spec, ServedVolume):
      spec = 'ndstore://%s/%s?encoding=raw' % (server_base_url, spec.token)
    output_layers[name] = spec
  state_str = (urlquote(json.dumps(dict(layers=output_layers),
                                   separators=(',',':')), '/:?=,'))
  url = "%s/static/%s/#!%s" % (server_base_url, global_server.token, state_str)
  return url
