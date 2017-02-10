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

class TrackableContext(object):
    def __init__(self, io_loop):
        self.lock = threading.RLock()
        self.io_loop = io_loop

    def wrap_callback(self, callback):
        def wrapped(*args, **kwargs):
            def helper():
                with self.lock:
                    callback(*args, **kwargs)
            self.io_loop.add_callback(helper)
        return wrapped

class TrackableSignal(object):
    def __init__(self, context):
        self.context = context
        self._handlers = set()
        self._immediate_handlers = set()
        self.count = 0

    def add(self, handler):
        self._handlers.add(handler)

    def add_immediate(self, handler):
        self._immediate_handlers.add(handler)

    def remove(self, handler):
        self._handlers.remove(handler)

    def remove_immediate(self, handler):
        self._immediate_handlers.remove(handler)

    def dispatch(self, *args, **kwargs):
        self.count += 1
        for handler in self._immediate_handlers:
            handler(*args, **kwargs)
        for handler in self._handlers:
            self.context.wrap_callback(handler)(*args, **kwargs)

class CompoundTrackable(object):
    def __init__(self, context):
        self.children = dict()
        self.changed = TrackableSignal(context)

    @property
    def context(self):
        return self.changed.context

    def __getitem__(self, key):
        return self.children[key]

    def __contains__(self, key):
        return key in self.children

    def __setitem__(self, key, value):
        with self.changed.context.lock:
            self.children[key] = value
            value.changed.add_immediate(self.changed.dispatch)
            self.changed.dispatch()

    def __delitem__(self, key):
        with self.changed.context.lock:
            value = self.children.pop(key)
            value.changed.remove_immediate(self.changed.dispatch)

    def items(self):
        return self.children.iteritems()

class TrackableValue(object):
    def __init__(self, context, value):
        self.changed = TrackableSignal(context)
        self._value = value

    @property
    def context(self):
        return self.changed.context

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, value):
        with self.changed.context.lock:
            if value != self._value:
                self._value = value
                self.changed.dispatch()

class TrackableList(object):
    def __init__(self, context, *args):
        self.changed = TrackableSignal(context)
        self._children = list(*args)
        for child in self._children:
            child.changed.add_immediate(self.changed.dispatch)

    @property
    def context(self):
        return self.changed.context

    def append(self, child):
        self._children.append(child)
        child.changed.add_immediate(self.changed.dispatch)

    def __getitem__(self, k):
        return self._children[k]

    def __setitem__(self, k, v):
        with self.changed.context.lock:
            if isinstance(k, slice):
                for child in self._children[k]:
                    child.changed.remove_immediate(self.changed.dispatch)
                self._children[k] = v
                for child in v:
                    child.changed.add_immediate(self.changed.dispatch)
            else:
                self._children[k].changed.remove_immediate(self.changed.dispatch)
                self._children[k] = v
                v.changed.add_immediate(self.changed.dispatch)

    def __iter__(self):
        return iter(self._children)

    def __delitem__(self, k):
        with self.changed.context.lock:
            v = self._children[k]
            v.changed.remove_immediate(self.changed.dispatch)
            del self._children[k]

    def __repr__(self):
        return repr(self._children)

    def __str__(self):
        return str(self._children)

def make_trackable(context, value):
    if (isinstance(value, CompoundTrackable) or isinstance(value, TrackableValue) or
            isinstance(value, TrackableList)):
        return value
    return TrackableValue(context, value)
