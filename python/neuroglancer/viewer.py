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

from . import base_viewer
from . import server


class Viewer(base_viewer.BaseViewer):
    """Viewer based on neuroglancer.server."""

    def __init__(self, *args, **kwargs):
        super(Viewer, self).__init__(*args, **kwargs)
        server.start(self)

    def register_volume(self, volume):
        server.register_volume(volume)

    def get_server_url(self):
        return server.get_server_url()

    def get_viewer_url(self):
        return '%s/static/%s/#!%s' % (self.get_server_url(), server.global_server.token,
                                      self.get_encoded_state())

    def __repr__(self):
        return self.get_viewer_url()

    def _repr_html_(self):
        return '<a href="%s" target="_blank">Viewer</a>' % self.get_viewer_url()

    def initialize_state(self, state):
        # pandas.read_csv can be used to read a list
        # state['layers']['synapse']['points'] = [[530, 557.5, 51], [617, 539.5, 52]]
        # return state
        return None

    def on_state_changed(self, state):
        return None

    def on_closing(self, state):
        #example on how to save synapses
        # print ('saving ', state['layers']['synapse']['points'] )
        pass

    @property
    def server(self):
        return server.global_server

    def broadcast(self):
        return self.server.broadcastState()

    @property
    def state(self):
        return server.global_server.state


def view(*args, **kwargs):
    """View a single array."""
    v = Viewer()
    v.add(*args, **kwargs)
    return v
