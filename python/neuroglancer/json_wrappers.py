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


import copy
import inspect
import numbers
import threading
from typing import Any, Callable, ClassVar, Generic, TypeVar, Union

import numpy as np

from .json_utils import encode_json_for_repr


def to_json(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    try:
        method = value.to_json
    except AttributeError:
        return value
    return method()


_T = TypeVar("_T")


class JsonObjectWrapper:
    supports_readonly = True
    supports_validation = True

    __slots__ = ("_json_data", "_cached_wrappers", "_lock", "_readonly")

    _json_data: Any
    _cached_wrappers: dict[str, Any]
    _lock: threading.RLock
    _readonly: bool

    def __init__(self, json_data=None, _readonly=False, **kwargs):
        if json_data is None:
            json_data = {}
        elif isinstance(json_data, type(self)):
            json_data = json_data.to_json()
        elif not isinstance(json_data, dict):
            raise TypeError
        object.__setattr__(self, "_json_data", json_data)
        object.__setattr__(self, "_cached_wrappers", dict())
        object.__setattr__(self, "_lock", threading.RLock())
        object.__setattr__(self, "_readonly", 1 if _readonly else False)
        for k in kwargs:
            setattr(self, k, kwargs[k])
        object.__setattr__(self, "_readonly", _readonly)

    def to_json(self):
        if self._readonly:
            return self._json_data
        with self._lock:
            r = self._json_data.copy()
            for k, (wrapper, _) in self._cached_wrappers.items():
                if wrapper is not None:
                    r[k] = to_json(wrapper)
                else:
                    r.pop(k, None)
            return r

    def __deepcopy__(self, memo):
        return type(self)(copy.deepcopy(self.to_json(), memo))

    def __eq__(self, other):
        return type(self) == type(other) and self.to_json() == other.to_json()

    def __repr__(self):
        return f"{type(self).__name__}({encode_json_for_repr(self.to_json())})"

    def _get_wrapped(self, key, wrapped_type):
        with self._lock:
            json_value = self._json_data.get(key)
            cached_value = self._cached_wrappers.get(key)
            if cached_value is not None and cached_value[1] is json_value:
                return cached_value[0]
            kwargs = dict()
            if self._readonly and hasattr(wrapped_type, "supports_readonly"):
                kwargs["_readonly"] = True
            wrapper = wrapped_type(json_value, **kwargs)
            self._cached_wrappers[key] = wrapper, json_value
            return wrapper

    def _set_wrapped(self, key, value, validator):
        if self._readonly is True:
            raise AttributeError
        value = validator(value)
        with self._lock:
            self._cached_wrappers[key] = (value, self._json_data.get(key))


_types_supporting_validation = frozenset([np.uint64, float, int])


def _normalize_validator(wrapped_type, validator):
    if validator is None:
        supports_validation = getattr(wrapped_type, "supports_validation", None)
        if (
            inspect.isroutine(wrapped_type)
            or supports_validation is not None
            or wrapped_type in _types_supporting_validation
        ):
            if inspect.isroutine(supports_validation):
                validator = supports_validation
            else:
                validator = wrapped_type
        else:

            def validator_func(x):
                if not isinstance(x, wrapped_type):
                    raise TypeError(wrapped_type, x)
                return x

            validator = validator_func
    return validator


def wrapped_property(json_name, wrapped_type, validator=None, doc=None):
    validator = _normalize_validator(wrapped_type, validator)
    return property(
        fget=lambda self: self._get_wrapped(json_name, wrapped_type),
        fset=lambda self, value: self._set_wrapped(json_name, value, validator),
        doc=doc,
    )


def array_wrapper(dtype, shape=None):
    if shape is not None:
        if isinstance(shape, numbers.Number):
            shape = (shape,)
        else:
            shape = tuple(shape)

    def wrapper(value, _readonly=False):
        value = np.array(value, dtype=dtype)
        if _readonly:
            value.setflags(write=False)
        if shape is not None:
            if len(shape) != len(value.shape) or any(
                expected_size is not None and expected_size != actual_size
                for expected_size, actual_size in zip(shape, value.shape)
            ):
                raise ValueError("expected shape", shape)
        return value

    wrapper.supports_readonly = True
    return wrapper


def text_type(value):
    return str(value)


def optional(wrapper, default_value=None, validator=None):
    def modified_wrapper(value, **kwargs):
        if value is None:
            return default_value
        return wrapper(value, **kwargs)

    if hasattr(wrapper, "supports_readonly"):
        modified_wrapper.supports_readonly = True

    validator = _normalize_validator(wrapper, validator)

    def modified_validator(value, **kwargs):
        if value is None:
            return default_value
        return validator(value, **kwargs)

    modified_wrapper.supports_validation = modified_validator
    return modified_wrapper


class MapBase:
    __slots__ = ()
    pass


class TypedStringMap(Generic[_T], JsonObjectWrapper, MapBase):
    validator: ClassVar[Callable[[Any], Any]]
    wrapped_type: ClassVar[Callable[[Any], Any]]
    supports_validation = True
    __slots__ = ()

    def __init__(self, json_data=None, _readonly=False):
        validator = type(self).validator
        if isinstance(json_data, MapBase):
            json_data = json_data.to_json()
        elif json_data is not None:
            new_map = {}
            for k, v in json_data.items():
                validator(v)
                new_map[k] = to_json(v)
            json_data = new_map
        super().__init__(json_data, _readonly=_readonly)

    def clear(self):
        with self._lock:
            self._cached_wrappers.clear()
            self._json_data.clear()

    def keys(self):
        return self._json_data.keys()

    def iteritems(self):
        for key in self:
            yield (key, self[key])

    def itervalues(self):
        for key in self:
            yield self[key]

    def get(self, key: str, default_value=None):
        with self._lock:
            if key in self._json_data:
                return self[key]
            return default_value

    def __len__(self):
        return len(self._json_data)

    def __contains__(self, key):
        return key in self._json_data

    def __getitem__(self, key):
        with self._lock:
            if key not in self._json_data:
                raise KeyError(key)
            return self._get_wrapped(key, type(self).wrapped_type)

    def __setitem__(self, key, value):
        with self._lock:
            self._set_wrapped(key, value, type(self).validator)
            self._json_data[key] = None  # placeholder

    def __delitem__(self, key):
        if self._readonly:
            raise AttributeError
        with self._lock:
            del self._json_data[key]
            self._cached_wrappers.pop(key, None)

    def __iter__(self):
        return iter(self._json_data)


def typed_string_map(
    wrapped_type: Callable[[Any], _T], validator=None
) -> type[TypedStringMap[_T]]:
    _wrapped_type = wrapped_type
    _validator = _normalize_validator(wrapped_type, validator)

    class Map(TypedStringMap):
        wrapped_type = _wrapped_type
        validator = _validator

    return Map


def typed_map(key_type, value_type, key_validator=None, value_validator=None):
    key_validator = _normalize_validator(key_type, key_validator)
    value_validator = _normalize_validator(value_type, value_validator)

    class Map(JsonObjectWrapper, MapBase):
        supports_validation = True
        __slots__ = ()

        def __init__(self, json_data=None, _readonly=False):
            if isinstance(json_data, MapBase):
                json_data = json_data.to_json()
            elif json_data is not None:
                new_map = {}
                for k, v in json_data.items():
                    key_validator(k)
                    value_validator(v)
                    new_map[str(k)] = to_json(v)
                json_data = new_map
            super().__init__(json_data, _readonly=_readonly)

        def clear(self):
            with self._lock:
                self._cached_wrappers.clear()
                self._json_data.clear()

        def keys(self):
            return [key_validator(k) for k in self._json_data.keys()]

        def iteritems(self):
            for key in self:
                yield (key, self[key])

        def itervalues(self):
            for key in self:
                yield self[key]

        def get(self, key, default_value=None):
            key = str(key)
            with self._lock:
                if key in self._json_data:
                    return self._get_wrapped(key, value_type)
                return default_value

        def __len__(self):
            return len(self._json_data)

        def __contains__(self, key):
            return str(key) in self._json_data

        def __getitem__(self, key):
            key = str(key)
            with self._lock:
                if key not in self._json_data:
                    raise KeyError(key)
                return self._get_wrapped(key, value_type)

        def __setitem__(self, key, value):
            key = str(key)
            with self._lock:
                self._set_wrapped(key, value, value_validator)
                self._json_data[key] = None  # placeholder

        def __delitem__(self, key):
            if self._readonly:
                raise AttributeError
            key = str(key)
            with self._lock:
                del self._json_data[key]
                self._cached_wrappers.pop(key, None)

        def __iter__(self):
            for key in self._json_data:
                yield key_validator(key)

    return Map


def segments():
    key_type = np.uint64
    value_type = bool
    value_validator = _normalize_validator(value_type, None)

    class Map(typed_map(key_type, value_type)):
        def to_json(self):
            return [
                segment if visible else "!" + segment
                for segment, visible in self._json_data.items()
            ]

        def __init__(self, json_data=None, _readonly=False):
            if json_data is None:
                json_data = dict()
            else:
                json_data = dict(
                    (key_type(v[1:]), False)
                    if str(v).startswith("!")
                    else (key_type(v), True)
                    for v in json_data
                )
            super().__init__(json_data, _readonly=_readonly)

        def __setitem__(self, key, value):
            key = str(key)
            with self._lock:
                self._set_wrapped(key, value, value_validator)
                self._json_data[key] = value  # using the value

    return Map


def typed_set(wrapped_type: Callable[[Any], _T]):
    def wrapper(x, _readonly=False) -> Callable[[Any], Union[set[_T], frozenset[_T]]]:
        set_type = frozenset if _readonly else set
        kwargs: dict[str, Any] = dict()
        if hasattr(wrapped_type, "supports_readonly"):
            kwargs.update(_readonly=True)
        if x is None:
            return set_type()
        return set_type(wrapped_type(v, **kwargs) for v in x)

    wrapper.supports_readonly = True  # type: ignore[attr-defined]
    return wrapper


class TypedList(Generic[_T]):
    supports_readonly = True
    supports_validation = True
    __slots__ = ("_readonly", "_data")
    validator: ClassVar[Callable[[Any], Any]]

    _readonly: bool
    _data: list[_T]

    def __init__(self, json_data=None, _readonly=False):
        if json_data is None:
            json_data = []
        if not isinstance(json_data, (list, tuple, np.ndarray)):
            raise ValueError
        self._readonly = _readonly
        validator = type(self).validator
        self._data = [validator(x) for x in json_data]

    def __len__(self):
        return len(self._data)

    def __getitem__(self, key):
        return self._data[key]

    def __delitem__(self, key):
        if self._readonly:
            raise AttributeError
        del self._data[key]

    def __setitem__(self, key, value):
        if self._readonly:
            raise AttributeError
        if isinstance(key, slice):
            values = [type(self).validator(x) for x in value]
            self._data[key] = values
        else:
            value = type(self).validator(value)
            self._data[key] = value

    def __iter__(self):
        return iter(self._data)

    def append(self, x):
        if self._readonly:
            raise AttributeError
        x = type(self).validator(x)
        self._data.append(x)

    def extend(self, values):
        for x in values:
            self.append(x)

    def insert(self, index, x):
        x = type(self).validator(x)
        self._data.insert(index, x)

    def pop(self, index=-1):
        return self._data.pop(index)

    def to_json(self):
        return [to_json(x) for x in self._data]

    def __deepcopy__(self, memo):
        return type(self)(copy.deepcopy(self.to_json(), memo))

    def __repr__(self):
        return encode_json_for_repr(self.to_json())


def typed_list(
    wrapped_type: Callable[[Any], _T], validator=None
) -> type[TypedList[_T]]:
    val = _normalize_validator(wrapped_type, validator)

    class DerivedTypedList(TypedList):
        validator = val

    return DerivedTypedList


def number_or_string(value):
    if not isinstance(value, numbers.Real) and not isinstance(value, str):
        raise TypeError
    return value
