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

from __future__ import absolute_import

import json
import re

import six

import sockjs.tornado

from . import trackable_state, viewer_config_state
from .json_utils import decode_json, encode_json

SOCKET_PATH_REGEX_WITHOUT_GROUP = r'^/socket/(?:[^/]+)'
SOCKET_PATH_REGEX = r'^/socket/(?P<viewer_token>[^/]+)'

class ClientCredentialsHandler(object):
    def __init__(self, io_loop, private_state, config_state, credentials_manager):
        self.private_state = private_state
        self.config_state = config_state
        self._on_changed_callback = (lambda: io_loop.add_callback(self._on_changed))
        private_state.add_changed_callback(self._on_changed_callback)
        self._previous_invalid_credentials = dict()
        self.credentials_manager = credentials_manager
        self._closed = False
        self.io_loop = io_loop

    def close(self):
        self.private_state.remove_changed_callback(self._on_changed_callback)
        self._closed = True

    def _on_changed(self):
        credentials = self.private_state.state.credentials
        try:
            for key, value in credentials.iteritems():
                prev_value = self._previous_invalid_credentials.get(key, 'invalid')
                if prev_value != value:
                    parsed_key = json.loads(key)
                    provider = self.credentials_manager.get(parsed_key['key'], parsed_key.get('parameters'))
                    if provider is not None:
                        def handle_credentials(f, key=key):
                            if self._closed:
                                return
                            try:
                                credentials = f.result()
                                def func(s):
                                    s.credentials[key] = credentials
                                self.config_state.retry_txn(func)
                            except:
                                import traceback
                                traceback.print_exc()

                        provider.get(value).add_done_callback(handle_credentials)
        except:
            import traceback
            traceback.print_exc()

class StateHandler(object):
    def __init__(self, state, io_loop, send_update, receive_updates=True):
        self.state = state
        self._send_update = send_update
        self._receive_updates = receive_updates
        self.io_loop = io_loop
        self._last_generation = None
        if send_update is not None:
            self._on_state_changed_callback = (
                lambda: self.io_loop.add_callback(self._on_state_changed))
            self.state.add_changed_callback(self._on_state_changed_callback)

    def _on_state_changed(self):
        """Invoked when the viewer state changes."""
        raw_state, generation = self.state.raw_state_and_generation
        if generation != self._last_generation:
            self._last_generation = generation
            self._send_update(raw_state, generation)

    def request_send_state(self, generation):
        if self._send_update is not None:
            self._last_generation = generation
            self._on_state_changed()

    def receive_update(self, raw_state, generation):
        if self._receive_updates:
            self._last_generation = generation
            self.state.set_state(raw_state, generation)

    def close(self):
        if self._send_update is not None:
            self.state.remove_changed_callback(self._on_state_changed_callback)
            del self._on_state_changed_callback


class SockJSHandler(sockjs.tornado.SockJSConnection):

    @property
    def io_loop(self):
        return self.session.server.io_loop

    def on_open(self, info):
        server = self.session.server.neuroglancer_server
        m = re.match(SOCKET_PATH_REGEX, info.path)
        if m is None:
            self.close()
            return

        viewer_token = self.viewer_token = m.group('viewer_token')
        viewer = self.viewer = server.viewers.get(viewer_token)

        if viewer is None:
            self.close()
            return

        private_state = self.private_state = trackable_state.TrackableState(
            viewer_config_state.PrivateState)

        managed_states = [
            dict(key='c', state=viewer.config_state, send_updates=True, receive_updates=False),
            dict(key='p', state=private_state, send_updates=False, receive_updates=True),
        ]
        if hasattr(viewer, 'shared_state'):
            managed_states.append(
                dict(key='s', state=viewer.shared_state, send_updates=True, receive_updates=True))

        self._state_handlers = dict()
        from .default_credentials_manager import default_credentials_manager
        self._credentials_handler = ClientCredentialsHandler(io_loop=self.io_loop,
                                                             private_state=private_state,
                                                             config_state=viewer.config_state,
                                                             credentials_manager=default_credentials_manager)

        def make_state_handler(key, state, send_updates, receive_updates):
            def send_update(raw_state, generation):
                if not self.is_open:
                    return
                message = {'t': 'setState', 'k': key, 's': raw_state, 'g': generation}
                self.send(encode_json(message))

            handler = StateHandler(
                state=state,
                io_loop=self.io_loop,
                send_update=send_update if send_updates else None,
                receive_updates=receive_updates)
            self._state_handlers[key] = handler

        for x in managed_states:
            make_state_handler(**x)

        self.is_open = True

    def on_message(self, message_text):
        if self.viewer is None:
            return
        try:
            message = decode_json(message_text)
            if isinstance(message, dict):
                t = message['t']
                if t == 'getState':
                    handler = self._state_handlers[message['k']]
                    handler.request_send_state(six.text_type(message['g']))
                    return
                if t == 'setState':
                    handler = self._state_handlers[message['k']]
                    handler.receive_update(message['s'], six.text_type(message['g']))
                    return
                if t == 'action':
                    for action in message['actions']:
                        self.io_loop.add_callback(self.viewer.actions.invoke, action['action'], action['state'])
                    self.io_loop.add_callback(self.send, json.dumps({'t': 'ackAction', 'id': message['id']}))
        except:
            # import pdb
            # pdb.post_mortem()
            import traceback
            traceback.print_exc()
            # Ignore malformed JSON

    def on_close(self):
        viewer = self.viewer
        self.is_open = False
        if viewer is not None:
            for state_handler in six.itervalues(self._state_handlers):
                state_handler.close()
            self._credentials_handler.close()
        del self._state_handlers
