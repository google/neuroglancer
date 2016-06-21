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
import binascii
import numpy as np
import io
import zlib
import time
import shutil
import time

from PIL import Image

info_path_regex = re.compile(r'^/neuroglancer/info/([^/]+)$')

data_path_regex = re.compile(
    r'^/neuroglancer/([^/]+)/([^/]+)/([0-9]+),([0-9]+)/([0-9]+),([0-9]+)/([0-9]+),([0-9]+)$')

mesh_path_regex = re.compile(
    r'^/neuroglancer/mesh/([^/]+)/([0-9]+)$')

static_path_regex = re.compile(
    r'/static/([^/]+)/((?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$')


def encode_jpeg(subvol):
  shape = subvol.shape
  reshaped = subvol.reshape(shape[0] * shape[1], shape[2])
  img = Image.fromarray(reshaped)
  f = io.BytesIO()
  img.save(f, "JPEG")
  return f.getvalue()


def encode_npz(subvol):
  fileobj = io.BytesIO()
  np.save(fileobj, subvol.reshape((1,) + subvol.shape))
  cdz = zlib.compress(fileobj.getvalue())
  return cdz


def encode_raw(subvol):
  return subvol.tostring('C')


def make_random_token():
  return binascii.hexlify(os.urandom(20))


mime_type_map = {
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.html': 'text/html',
    '.map': 'application/json'
}


def guess_mime_type_from_path(path):
  return mime_type_map.get(
      posixpath.splitext(path)[1], 'application/octet-stream')


class Server(ThreadingMixIn, HTTPServer):

  def __init__(self,
               bind_address='127.0.0.1',
               static_file_open=open,
               static_file_path=None):
    HTTPServer.__init__(self, (bind_address, 0), RequestHandler)
    self.daemon_threads = True
    if static_file_path is None:
      static_file_path = os.path.join(os.path.dirname(__file__), '../dist/dev')
    self.static_file_path = static_file_path
    self.static_file_open = static_file_open
    self.volumes = dict()
    self.token = make_random_token()


class ServedVolume(object):

  def __init__(self,
               data,
               offset=(0, 0, 0),
               channel_type=None,
               voxel_size=(1, 1, 1),
               encoding='npz',
               volume_type=None):
    self.token = make_random_token()
    if len(data.shape) == 3:
      self.num_channels = 1
      self.shape = data.shape[::-1]
    else:
      self.num_channels = data.shape[0]
      self.shape = data.shape[:1:-1]

    self.data = data
    self.voxel_size = voxel_size
    self.offset = offset
    self.data_type = data.dtype.name
    self.encoding = encoding
    if volume_type is None:
      if self.num_channels == 1 and (self.data_type == 'uint16' or
                                     self.data_type == 'uint32' or
                                     self.data_type == 'uint64'):
        volume_type = 'segmentation'
      else:
        volume_type = 'image'
    self.volume_type = volume_type
    self.mesh_generator = None
    self.mesh_generator_pending = False
    self.mesh_generator_lock = threading.Condition()
    if self.volume_type == 'segmentation':
      self.get_mesh_generator()
  def get_mesh_generator(self):
    if self.mesh_generator is not None:
      return self.mesh_generator
    with self.mesh_generator_lock:
      if self.mesh_generator is not None:
        return self.mesh_generator
      if self.mesh_generator_pending:
        while self.mesh_generator is None:
          self.mesh_generator_lock.wait()
        return self.mesh_generator
      try:
        import _neuroglancer
      except ImportError:
        return None
      if not (self.num_channels == 1 and
              (self.data_type == 'uint8' or self.data_type == 'uint16' or
               self.data_type == 'uint32' or self.data_type == 'uint32')):
        return None
      self.mesh_generator_pending = True
    if len(self.data.shape) == 4:
      data = self.data[0,:,:,:]
    else:
      data = self.data
    start_time = time.time()
    self.mesh_generator = _neuroglancer.OnDemandObjectMeshGenerator(
        data, self.voxel_size, self.offset)
    end_time = time.time()
    print('generated meshes in %.3f seconds' % (end_time - start_time))
    with self.mesh_generator_lock:
      self.mesh_generator_pending = False
      self.mesh_generator_lock.notify_all()
    return self.mesh_generator

num_requests = 0


class RequestHandler(BaseHTTPRequestHandler):
  protocol_version = 'HTTP/1.1'

  def do_GET(self):
    #print('GET %s' % self.path)
    m = re.match(data_path_regex, self.path)
    if m is not None:
      global num_requests
      start_time = time.time()
      self.handle_data_request(
          token=m.group(2),
          data_format=m.group(1),
          start=(int(m.group(3)), int(m.group(5)), int(m.group(7))),
          end=(int(m.group(4)), int(m.group(6)), int(m.group(8))))
      end_time = time.time()
      num_requests += 1
      # print('Request %d took %.4f' % (num_requests, end_time - start_time))
      return
    m = re.match(mesh_path_regex, self.path)
    if m is not None:
      self.handle_mesh_request(m.group(1), int(m.group(2)))
      return
    m = re.match(info_path_regex, self.path)
    if m is not None:
      self.handle_info_request(m.group(1))
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
    static_path = os.path.join(self.server.static_file_path, path)
    try:
      with self.server.static_file_open(static_path) as f:
        mime_type = guess_mime_type_from_path(path)
        data = f.read()
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
    try:
      encoded_data, content_type = volume.get_encoded_subvolume(data_format, start, end)
    except ValueError as e:
      self.send_error(400, x.args[0])
      return
    self.send_response(200)
    self.send_header('Content-type', content_type)
    self.send_header('Content-length', len(data))
    self.send_header('Access-Control-Allow-Origin', '*')
    self.end_headers()
    self.wfile.write(data)

  def handle_mesh_request(self, key, object_id):
    volume = self.server.volumes.get(key)
    if volume is None:
      self.send_error(404)
    mesh_generator = volume.get_mesh_generator()
    if mesh_generator is None:
      self.send_response(404, 'Volume has invalid data type for meshing')
      return
    data = mesh_generator.get_mesh(object_id)
    if data is None:
      self.send_response(404, 'Object not found.')
    else:
      self.send_response(200)
      self.send_header('Content-type', 'application/octet-stream')
      self.send_header('Content-length', len(data))
      self.send_header('Access-Control-Allow-Origin', '*')
      self.end_headers()
      self.wfile.write(data)

  def handle_info_request(self, key):
    volume = self.server.volumes.get(key)
    if volume is None:
      self.send_error(404)
    info = dict(volumeType=volume.volume_type,
                dataType=volume.data_type,
                encoding=volume.encoding,
                numChannels=volume.num_channels,
                scales=[
                    dict(key=key,
                         lowerVoxelBound=volume.offset,
                         upperVoxelBound=tuple(np.array(volume.offset) + np.array(volume.shape)),
                         voxelSize=volume.voxel_size,),
                ],)
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


def serve(layers, voxel_size=(1, 1, 1), server_args=dict()):
  global global_server
  if global_server is None:
    global_server = Server(**server_args)
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
      spec = 'python://%s/%s' % (server_base_url, spec.token)
    output_layers[name] = spec
  state_str = (urlquote(
      json.dumps(
          dict(layers=output_layers),
          separators=(',', ':')),
      '/:?=,'))
  url = "%s/static/%s/#!%s" % (server_base_url, global_server.token, state_str)
  return url
