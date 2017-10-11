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
"""Facilities for converting JSON <-> Python objects"""

from __future__ import absolute_import

import collections
import copy
import inspect
import numbers
import threading

import numpy as np
import six

from six.moves import range

from .json_utils import encode_json_for_repr


def to_json(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    try:
        method = value.to_json
    except AttributeError:
        return value
    return method()


class JsonObjectWrapper(object):
    supports_readonly = True

    __slots__ = ('_json_data', '_cached_wrappers', '_lock', '_readonly')

    def __init__(self, json_data=None, _readonly=False, **kwargs):
        if json_data is None:
            json_data = collections.OrderedDict()
        object.__setattr__(self, '_json_data', json_data)
        object.__setattr__(self, '_cached_wrappers', dict())
        object.__setattr__(self, '_lock', threading.RLock())
        object.__setattr__(self, '_readonly', _readonly)

        for k in kwargs:
            setattr(self, k, kwargs[k])

    def to_json(self):
        with self._lock:
            r = self._json_data.copy()
            for k, (wrapper, _) in six.iteritems(self._cached_wrappers):
                r[k] = to_json(wrapper)
            return r

    def __deepcopy__(self, memo):
        return type(self)(copy.deepcopy(self.to_json(), memo))

    def __repr__(self):
        return u'%s(%s)' % (type(self).__name__, encode_json_for_repr(self.to_json()))

    def _get_wrapped(self, key, wrapped_type):
        with self._lock:
            json_value = self._json_data.get(key)
            cached_value = self._cached_wrappers.get(key)
            if cached_value is not None and cached_value[1] is json_value:
                return cached_value[0]
            kwargs = dict()
            if self._readonly and hasattr(wrapped_type, 'supports_readonly'):
                kwargs['_readonly'] = True
            wrapper = wrapped_type(json_value, **kwargs)
            self._cached_wrappers[key] = wrapper, json_value
            return wrapper

    def _set_wrapped(self, key, value, validator):
        if self._readonly:
            raise AttributeError
        value = validator(value)
        with self._lock:
            self._cached_wrappers[key] = (value, self._json_data.get(key))


def _normalize_validator(wrapped_type, validator):
    if validator is None:
        if inspect.isroutine(wrapped_type):
            validator = wrapped_type
        else:
            def validator_func(x):
                if not isinstance(x, wrapped_type):
                    raise TypeError
                return x
            validator = validator_func
    return validator


def wrapped_property(json_name, wrapped_type, validator=None, doc=None):
    validator = _normalize_validator(wrapped_type, validator)
    return property(fget=lambda self: self._get_wrapped(json_name, wrapped_type),
                    fset=lambda self, value: self._set_wrapped(json_name, value, validator),
                    doc=doc)


def array_wrapper(dtype, shape=None):
    if shape is not None:
        if isinstance(shape, numbers.Number):
            shape = (shape, )
        else:
            shape = tuple(shape)

    def wrapper(value, _readonly=False):
        value = np.array(value, dtype=dtype)
        if _readonly:
            value.setflags(write=False)
        if shape is not None:
            if len(shape) != len(value.shape) or any(
                    expected_size is not None and expected_size != actual_size
                    for expected_size, actual_size in zip(shape, value.shape)):
                raise ValueError('expected shape', shape)
        return value

    wrapper.supports_readonly = True
    return wrapper


def text_type(value):
    return six.text_type(value)


def optional(wrapper, default_value=None):
    def modified_wrapper(value, **kwargs):
        if value is None:
            return default_value
        return wrapper(value, **kwargs)

    if hasattr(wrapper, 'supports_readonly'):
        modified_wrapper.supports_readonly = True
    return modified_wrapper

def typed_string_map(wrapped_type, validator=None):
    validator = _normalize_validator(wrapped_type, validator)
    class Map(JsonObjectWrapper):
        def clear(self):
            with self._lock:
                self._cached_wrappers.clear()
                self._json_data.clear()

        def keys(self):
            return six.viewkeys(self._json_data)

        def iteritems(self):
            for key in self:
                yield (key, self[key])

        def itervalues(self):
            for key in self:
                yield self[key]

        def get(self, key, default_value=None):
            with self._lock:
                if key in self._json_data:
                    return self[key]
                return default_value

        def __len__(self):
            return len(self._json_data)

        def __getitem__(self, key):
            with self._lock:
                if key not in self._json_data:
                    raise KeyError
                return self._get_wrapped(key, wrapped_type)

        def __setitem__(self, key, value):
            with self._lock:
                self._set_wrapped(key, value, validator)
                self._json_data[key] = None # placeholder

        def __delitem__(self, key):
            if self._readonly:
                raise AttributeError
            with self._lock:
                del self._json_data[key]
                self._cached_wrappers.pop(key, None)

        def __iter__(self):
            return iter(self._json_data)

    return Map

def typed_set(wrapped_type):
    def wrapper(x, _readonly=False):
        set_type = frozenset if _readonly else set
        kwargs = dict()
        if hasattr(wrapped_type, 'supports_readonly'):
            kwargs.update(_readonly=True)
        if x is None:
            return set_type()
        return set_type(wrapped_type(v, **kwargs) for v in x)
    wrapper.supports_readonly = True
    return wrapper

def typed_list(wrapped_type, validator=None):
    validator = _normalize_validator(wrapped_type, validator)
    class TypedList(object):
        supports_readonly = True
        def __init__(self, json_data=None, _readonly=False):
            if json_data is None:
                json_data = []
            if not isinstance(json_data, (list, tuple)):
                raise ValueError
            self._readonly = _readonly
            self._json_data = json_data
            self._cached_wrappers = [None] * len(json_data)
            self._lock = threading.RLock()

        def _get_wrapped(self, key):
            with self._lock:
                json_value = self._json_data[key]
                cached_value = self._cached_wrappers[key]
                if cached_value is not None:
                    return cached_value[0]
                kwargs = dict()
                if self._readonly and hasattr(wrapped_type, 'supports_readonly'):
                    kwargs['_readonly'] = True
                wrapper = wrapped_type(json_value, **kwargs)
                self._cached_wrappers[key] = (wrapper,)
                return wrapper

        def _set_wrapped(self, key, value):
            if self._readonly:
                raise AttributeError
            value = validator(value)
            with self._lock:
                self._cached_wrappers[key] = (value,)

        def __len__(self):
            return len(self._json_data)

        def __getitem__(self, key):
            if isinstance(key, slice):
                return [self._get_wrapped(i) for i in range(*key.indices(len(self)))]
            return self._get_wrapped(key)

        def __delitem__(self, key):
            if self._readonly:
                raise AttributeError
            with self._lock:
                del self._json_data[key]
                del self._cached_wrappers[key]

        def __setitem__(self, key, value):
            if self._readonly:
                raise AttributeError
            if isinstance(key, slice):
                values = [validator(x) for x in value]
                with self._lock:
                    self._json_data[key] = values
                    self._cached_wrappers[key] = [(x,) for x in values]

        def __iter__(self):
            for i in range(len(self._json_data)):
                yield self._get_wrapped(i)

        def append(self, x):
            x = validator(x)
            with self._lock:
                self._json_data.append(None)
                self._cached_wrappers.append((x,))

        def extend(self, values):
            with self._lock:
                for x in values:
                    self.append(x)
        def insert(self, index, x):
            x = validator(x)
            with self._lock:
                self._json_data.insert(index, x)
                self._cached_wrappers.insert(index, (x,))

        def pop(self, index=-1):
            with self._lock:
                value = self[index]
                del self[index]
                return value

        def to_json(self):
            with self._lock:
                r = list(self._json_data)
                for k, cache_data in enumerate(self._cached_wrappers):
                    if cache_data is not None:
                        r[k] = to_json(cache_data[0])
                return r

        def __deepcopy__(self, memo):
            return type(self)(copy.deepcopy(self.to_json(), memo))

        def __repr__(self):
            return encode_json_for_repr(self.to_json())
    return TypedList
