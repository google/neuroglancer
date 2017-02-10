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

from __future__ import absolute_import

import collections
import json

try:
    # Python 2 case
    from urllib import quote as urlquote  # pylint: disable=import-error
except ImportError:
    # Python 3 case
    from urllib.parse import quote as urlquote  # pylint: disable=no-name-in-module,import-error

from . import volume
from .trackable import TrackableContext
from .trackable import CompoundTrackable
from .trackable import TrackableList
from .trackable import make_trackable
from .operational_transformation import ManagedState

class Layer(CompoundTrackable):
    def __init__(self,
                 context,
                 data,
                 name=None,
                 default_voxel_size=(1, 1, 1),
                 voxel_size=None,
                 voxel_offset=None,
                 offset=None,
                 visible=None,
                 shader=None,
                 **kwargs):
        super(Layer, self).__init__(context)
        if offset is None and voxel_offset is None:
            if hasattr(data, 'attrs'):
                if 'resolution' in data.attrs:
                    voxel_size = tuple(data.attrs['resolution'])[::-1]
                if 'offset' in data.attrs:
                    offset = tuple(data.attrs['offset'])[::-1]
        if voxel_size is None:
            voxel_size = default_voxel_size
        self.volume = volume.ServedVolume(
            data=data, offset=offset, voxel_offset=voxel_offset, voxel_size=voxel_size, **kwargs)
        self['name'] = make_trackable(context, name)
        for k, v in kwargs.items():
            self[k] = make_trackable(context, v)
        self['type'] = make_trackable(context, self.volume.volume_type)
        self['source'] = make_trackable(context, 'python://%s' % (self.volume.token,))
        if visible is not None:
            self['visible'] = make_trackable(context, visible)
        if shader is not None:
            self['shader'] = make_trackable(context, shader)


class BaseViewer(object):
    def __init__(self, context, voxel_size=None):
        self.voxel_size = voxel_size
        self.context = context
        self.state = CompoundTrackable(context)
        self.managed_state = ManagedState(self.state)
        self.state['layers'] = make_trackable(context, []) #TrackableList()
        self.layers = self.state['layers'].value
        self.state['navigation'] = CompoundTrackable(context)
        self.state['navigation']['pose'] = CompoundTrackable(context)
        self.state['navigation']['pose']['position'] = make_trackable(context, dict(voxelSize=list(voxel_size)))

    def add(self, *args, **kwargs):
        if self.voxel_size is None:
            default_voxel_size = (1, 1, 1)
        else:
            default_voxel_size = self.voxel_size
        layer = Layer(self.context, *args, default_voxel_size=default_voxel_size, **kwargs)
        self.register_volume(layer.volume)
        self.layers.append(layer)

    def get_json_state(self):
        state = collections.OrderedDict()
        layers = state['layers'] = collections.OrderedDict()
        specified_names = set(layer.name for layer in self.layers)
        for layer in self.layers:
            name = layer.name
            if name is None:
                base_name = layer.volume.volume_type
                name = base_name
                suffix = 2
                while name in specified_names:
                    name = '%s%d' % (base_name, suffix)
                    suffix += 1
                specified_names.add(name)
            layers[name] = layer.get_layer_spec(self.get_server_url())
        if self.voxel_size is not None:
            state['navigation'] = collections.OrderedDict()
            state['navigation']['pose'] = collections.OrderedDict()
            state['navigation']['pose']['voxelSize'] = list(self.voxel_size)
        return state

    def register_volume(self, vol):
        """Registers a volume with the server.

        This must be overridden by a subclass.
        """
        raise NotImplementedError

    def get_server_url(self):
        """Returns the root URL for the server, e.g. 'http://hostname:port'.

        This must be overridden by a subclass.
        """
        raise NotImplementedError

    def get_encoded_state(self):
        return urlquote(
            json.dumps(self.get_json_state(), separators=(',', ':')),
            '~@#$&()*!+=:;,.?/\'')
