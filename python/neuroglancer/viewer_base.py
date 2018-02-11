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

import contextlib
import json
import re
import threading

import six

from . import local_volume, trackable_state, viewer_config_state, viewer_state
from .json_utils import decode_json, encode_json, json_encoder_default
from .random_token import make_random_token


class LocalVolumeManager(trackable_state.ChangeNotifier):
    def __init__(self, token_prefix):
        super(LocalVolumeManager, self).__init__()
        self.volumes = dict()
        self.__token_prefix = token_prefix

    def register_volume(self, v):
        if v.token not in self.volumes:
            self.volumes[v.token] = v
            self._dispatch_changed_callbacks()
        return 'python://%s' % (self.get_volume_key(v))

    def get_volume_key(self, v):
        return self.__token_prefix + v.token

    def update(self, json_str):
        pattern = '|'.join(self.volumes)
        present_tokens = set()
        for m in re.finditer(pattern, json_str):
            present_tokens.add(m.group(0))
        volumes_to_delete = []
        for x in self.volumes:
            if x not in present_tokens:
                volumes_to_delete.append(x)
        for x in volumes_to_delete:
            del self.volumes[x]
        if volumes_to_delete:
            self._dispatch_changed_callbacks()


class ViewerCommonBase(object):
    def __init__(self):
        self.token = make_random_token()
        self.config_state = trackable_state.TrackableState(viewer_config_state.ConfigState)

        def set_actions(actions):
            def func(s):
                s.actions = actions

            self.config_state.retry_txn(func)

        self.actions = viewer_config_state.Actions(set_actions)

        self.volume_manager = LocalVolumeManager(self.token + '.')

        self.__watched_volumes = dict()

        self.volume_manager.add_changed_callback(self._handle_volumes_changed)

        self._next_screenshot_id = 0
        self._screenshot_callbacks = {}
        self.actions.add('screenshot', self._handle_screenshot_reply)

    def async_screenshot(self, callback):
        screenshot_id = str(self._next_screenshot_id)
        self._next_screenshot_id += 1
        def set_screenshot_id(s):
            s.screenshot = screenshot_id
        self.config_state.retry_txn(set_screenshot_id)
        self._screenshot_callbacks[screenshot_id] = callback

    def screenshot(self):
        event = threading.Event()
        result = [None]
        def handler(s):
            result[0] = s
            event.set()
        self.async_screenshot(handler)
        event.wait()
        return result[0]

    def _handle_screenshot_reply(self, s):
        def set_screenshot_id(s):
            s.screenshot = None

        self.config_state.retry_txn(set_screenshot_id)
        screenshot_id = s.screenshot.id
        callback = self._screenshot_callbacks.pop(screenshot_id, None)
        if callback is not None:
            callback(s)

    def _handle_volumes_changed(self):
        volumes = self.volume_manager.volumes
        for key in volumes:
            if key not in self.__watched_volumes:
                volume = volumes[key]
                self.__watched_volumes[key] = volume
                volume.add_changed_callback(self._update_source_generations)
        keys_to_remove = [key for key in self.__watched_volumes if key not in volumes]
        for key in keys_to_remove:
            volume = self.__watched_volumes.pop(key)
            volume.remove_changed_callback(self._update_source_generations)

    def _update_source_generations(self):
        def func(s):
            volume_manager = self.volume_manager
            s.source_generations = {
                volume_manager.get_volume_key(x): x.change_count for x in six.viewvalues(self.volume_manager.volumes)
            }

        self.config_state.retry_txn(func)

    def _transform_viewer_state(self, new_state):
        if isinstance(new_state, viewer_state.ViewerState):
            new_state = new_state.to_json()

            def encoder(x):
                if isinstance(x, local_volume.LocalVolume):
                    return self.volume_manager.register_volume(x)
                return json_encoder_default(x)

            new_state = decode_json(json.dumps(new_state, default=encoder))
        return new_state

    def txn(self):
        raise NotImplementedError


class ViewerBase(ViewerCommonBase):
    def __init__(self):
        super(ViewerBase, self).__init__()
        self.shared_state = trackable_state.TrackableState(viewer_state.ViewerState,
                                                           self._transform_viewer_state)
        self.shared_state.add_changed_callback(
            lambda: self.volume_manager.update(encode_json(self.shared_state.raw_state)))

    @property
    def state(self):
        return self.shared_state.state

    def set_state(self, *args, **kwargs):
        return self.shared_state.set_state(*args, **kwargs)

    def txn(self, *args, **kwargs):
        return self.shared_state.txn(*args, **kwargs)

    def retry_txn(self, *args, **kwargs):
        return self.shared_state.retry_txn(*args, **kwargs)


class UnsynchronizedViewerBase(ViewerCommonBase):
    def __init__(self):
        super(UnsynchronizedViewerBase, self).__init__()
        self.state = viewer_state.ViewerState()

    @property
    def raw_state(self):
        return self._transform_viewer_state(self.state)

    def set_state(self, new_state):
        self.state = viewer_state.ViewerState(new_state)

    @contextlib.contextmanager
    def txn(self):
        yield self.state

    def retry_txn(self, func, retries=None):  # pylint: disable=unused-argument
        return func(self.state)
