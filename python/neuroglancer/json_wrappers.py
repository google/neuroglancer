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

import collections
import copy
import inspect
import numbers
import threading
from collections.abc import (
    Callable,
    ItemsView,
    Iterable,
    Iterator,
    KeysView,
    ValuesView,
)
from typing import (
    Any,
    ClassVar,
    Generic,
    Literal,
    TypeVar,
    cast,
    overload,
)

import numpy as np
import numpy.typing

from .json_utils import encode_json_for_repr

__all__ = []


def export(obj):
    __all__.append(obj.__name__)
    return obj


def to_json(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    try:
        method = value.to_json
    except AttributeError:
        return value
    return method()


T = TypeVar("T")
K = TypeVar("K")
V = TypeVar("V")


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


def _map_type_annotation(target, source, callback):
    annotation = _get_type_annotation(source)
    if annotation is None:
        return
    new_annotation = callback(annotation)
    if new_annotation is None:
        return
    _set_type_annotation(target, new_annotation)


def _set_type_annotation(target, annotation):
    setattr(target, "_neuroglancer_annotation", annotation)


def _get_type_annotation(wrapped_type):
    annotation = getattr(wrapped_type, "_neuroglancer_annotation", None)
    if annotation is not None:
        return annotation
    if isinstance(wrapped_type, type):
        return wrapped_type
    return None


def wrapped_property(json_name, wrapped_type, validator=None, doc=None):
    validator = _normalize_validator(wrapped_type, validator)

    def fget(self):
        return self._get_wrapped(json_name, wrapped_type)

    annotation = _get_type_annotation(wrapped_type)
    if annotation is not None:
        fget.__annotations__ = {"return": annotation}

    def fset(self, value):
        return self._set_wrapped(json_name, value, validator)

    return property(
        fget=fget,
        fset=fset,
        doc=doc,
    )


def array_wrapper(dtype, shape=None):
    if shape is not None:
        if isinstance(shape, numbers.Number):
            shape = (shape,)
        else:
            shape = tuple(shape)
        shape_annotation = tuple[tuple(Literal[s] for s in shape)]
    else:
        shape_annotation = Any

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
    _set_type_annotation(
        wrapper,
        (
            np.ndarray[shape_annotation, dtype]
            if shape_annotation is not Any
            else np.typing.NDArray[dtype]
        ),
    )
    return wrapper


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

    if default_value is None:
        _map_type_annotation(modified_wrapper, wrapper, lambda t: t | None)
    else:
        _map_type_annotation(modified_wrapper, wrapper, lambda t: t)

    return modified_wrapper


@export
class Map(Generic[K, V], JsonObjectWrapper):
    """Maps keys of type :py:param:`.K` to values of type :py:param:`.V`.

    Type parameters:
      K:
        Key type.
      V:
        Mapped value type.

    Group:
      json-containers
    """

    _key_validator: ClassVar[Callable[[Any], Any]]
    _value_validator: ClassVar[Callable[[Any], Any]]
    _value_type: type
    supports_validation = True
    __slots__ = ()

    def __init__(self, json_data=None, _readonly=False):
        if isinstance(json_data, Map):
            json_data = json_data.to_json()
        elif json_data is not None:
            new_map = {}
            key_validator = type(self)._key_validator
            value_validator = type(self)._value_validator
            for k, v in json_data.items():
                key_validator(k)
                value_validator(v)
                new_map[str(k)] = to_json(v)
            json_data = new_map
        super().__init__(json_data, _readonly=_readonly)

    def clear(self):
        """Clears the map."""
        with self._lock:
            self._cached_wrappers.clear()
            self._json_data.clear()

    def keys(self) -> KeysView[K]:
        """Returns a dynamic view of the keys in the map."""
        return _MapKeysView(self)

    def values(self) -> ValuesView[V]:
        """Returns a dynamic view of the values in the map."""
        return _MapValuesView(self)

    def items(self) -> ItemsView[K, V]:
        """Returns a dynamic view of the items in the map."""
        return _MapItemsView(self)

    @overload
    def get(self, key: K) -> V | None: ...

    @overload
    def get(self, key: K, default: V) -> V: ...

    @overload
    def get(self, key: K, default: T) -> V | T: ...

    def get(self, key: K, default=None):
        """Returns the mapped value, or the specified default."""
        key = str(key)  # type: ignore[assignment]
        with self._lock:
            if key in self._json_data:
                return self._get_wrapped(key, type(self)._value_type)
            return default

    def __len__(self) -> int:
        """Returns the number of entries in the map."""
        return len(self._json_data)

    def __contains__(self, key: K) -> bool:
        return str(key) in self._json_data

    def __getitem__(self, key: K) -> V:
        """Returns the mapped value associated with the specified key.

        Raises:
          KeyError: if the key is not present in the map.
        """
        str_key = str(key)
        with self._lock:
            if str_key not in self._json_data:
                raise KeyError(key)
            return self._get_wrapped(str_key, type(self)._value_type)

    def __setitem__(self, key: K, value: V):
        """Sets the specified key to the specified value."""
        str_key = str(key)
        with self._lock:
            self._set_wrapped(str_key, value, type(self)._value_validator)
            self._json_data[str_key] = None  # placeholder

    def __delitem__(self, key: K):
        """Deletes the entry with the specified key.

        Raises:
          KeyError: if the key is not present in the map.
        """
        if self._readonly:
            raise AttributeError
        str_key = str(key)
        with self._lock:
            del self._json_data[str_key]
            self._cached_wrappers.pop(str_key, None)

    def __iter__(self) -> Iterator[K]:
        key_validator = type(self)._key_validator
        for key in self._json_data:
            yield key_validator(key)

    @overload
    def pop(self, key: K, /) -> V: ...

    @overload
    def pop(self, key: K, default: V, /) -> V: ...

    @overload
    def pop(self, key: K, default: T, /) -> V | T: ...

    def pop(self, key: K, /, *args):
        """Removes and returns the mapped value associated with the specified key.

        Returns:
          The mapped value, or :py:param:`default` if :py:param:`key` is not
          specified and :py:param:`default` is specified.

        Raises:
          KeyError: if the key is not present and :py:param:`default` is not
            specified.
        """
        if self._readonly:
            raise AttributeError
        str_key = str(key)
        if len(args) > 1:
            raise ValueError("Expected at most one default argument")
        with self._lock:
            if str_key in self._json_data:
                value = self._get_wrapped(str_key, type(self)._value_type)
                del self._json_data[str_key]
                self._cached_wrappers.pop(str_key, None)
                return value
            if len(args) == 0:
                raise KeyError(key)
            return args[0]


class _MapKeysView(Generic[K], collections.abc.KeysView[K]):
    _mapping: Map[K, Any]
    _base_view: KeysView[str]
    _key_validator: Callable[[str], K]

    def __init__(self, map: Map[K, Any]):
        self._mapping = map
        self._base_view = map._json_data.keys()
        self._key_validator = type(map)._key_validator

    def __contains__(self, key) -> bool:
        return str(key) in self._base_view

    def __len__(self) -> int:
        return len(self._base_view)

    def __iter__(self) -> Iterator[K]:
        key_validator = self._key_validator
        for key in self._base_view:
            yield key_validator(key)


class _MapItemsView(Generic[K, V], collections.abc.ItemsView[K, V]):
    _mapping: Map[K, V]

    def __init__(self, map: Map[K, V]):
        self._mapping = map

    def __contains__(self, item) -> bool:
        key, value = item
        m = self._mapping
        return key in m and m[key] == value

    def __len__(self) -> int:
        return len(self._mapping)

    def __iter__(self) -> Iterator[tuple[K, V]]:
        m = self._mapping
        for key in m:
            yield (key, m[key])


class _MapValuesView(Generic[V], collections.abc.ValuesView[V]):
    _mapping: Map[Any, V]

    def __init__(self, map: Map[Any, V]):
        self._mapping = map

    def __contains__(self, value) -> bool:
        return any(value == x for x in self)

    def __len__(self) -> int:
        return len(self._mapping)

    def __iter__(self) -> Iterator[V]:
        m = self._mapping
        for key in m:
            yield m[key]


def typed_map(key_type, value_type, key_validator=None, value_validator=None):
    key_validator = _normalize_validator(key_type, key_validator)
    value_validator = _normalize_validator(value_type, value_validator)

    class _Map(Map):
        __slots__ = ()
        _key_validator = key_validator
        _value_validator = value_validator
        _value_type = value_type

    if (key_annotation := _get_type_annotation(key_type)) is not None and (
        value_annotation := _get_type_annotation(value_type)
    ) is not None:
        _set_type_annotation(Map, Map[key_annotation, value_annotation])

    return _Map


def typed_set(wrapped_type: Callable[[Any], T]):
    def wrapper(x, _readonly=False) -> set[T] | frozenset[T]:
        set_type = frozenset if _readonly else set
        kwargs: dict[str, Any] = dict()
        if hasattr(wrapped_type, "supports_readonly"):
            kwargs.update(_readonly=True)
        if x is None:
            return set_type()
        return set_type(wrapped_type(v, **kwargs) for v in x)

    wrapper.supports_readonly = True  # type: ignore[attr-defined]
    _map_type_annotation(
        wrapper,
        wrapped_type,
        lambda t: set[t],  # type: ignore[valid-type]
    )
    return wrapper


@export
class List(Generic[T]):
    """List of values of type :py:param:`.T`.

    Type parameters:
      T: Element type.

    Group:
      json-containers
    """

    supports_readonly = True
    supports_validation = True
    __slots__ = ("_readonly", "_data")
    _validator: ClassVar[Callable[[Any], Any]]

    _readonly: bool
    _data: list[T]

    def __init__(self, json_data=None, _readonly=False):
        if json_data is None:
            json_data = []
        if not isinstance(json_data, list | tuple | np.ndarray):
            raise ValueError
        self._readonly = _readonly
        validator = type(self)._validator
        self._data = [validator(x) for x in json_data]

    def __len__(self) -> int:
        """Returns the length of the list."""
        return len(self._data)

    def __getitem__(self, key: int) -> T:
        """Returns the element at the specified index."""
        return self._data[key]

    def __delitem__(self, key: int):
        """Removes the element at the specified index."""
        if self._readonly:
            raise AttributeError
        del self._data[key]

    @overload
    def __setitem__(self, key: int, value: T): ...

    @overload
    def __setitem__(self, key: slice, value: Iterable[T]): ...

    def __setitem__(self, key: int | slice, value: T | Iterable[T]):
        """Assigns to the specified index or slice."""
        if self._readonly:
            raise AttributeError
        if isinstance(key, slice):
            values = [type(self)._validator(x) for x in cast(Iterable[T], value)]
            self._data[key] = values
        else:
            value = type(self)._validator(value)
            self._data[key] = cast(T, value)

    def __iter__(self) -> Iterator[T]:
        """Iterates over the values in the list."""
        return iter(self._data)

    def append(self, value: T):
        """Appends a value to the end of the list."""
        if self._readonly:
            raise AttributeError
        value = type(self)._validator(value)
        self._data.append(value)

    def extend(self, values: Iterable[T]):
        """Extends the list with the specified values."""
        for x in values:
            self.append(x)

    def insert(self, index: int, value: T):
        """Inserts the specified value at the specified index."""
        value = type(self)._validator(value)
        self._data.insert(index, value)

    def pop(self, index: int = -1) -> T:
        """Removes and returns the element at the specified index."""
        return self._data.pop(index)

    def to_json(self):
        """Returns the representation as a JSON array."""
        return [to_json(x) for x in self._data]

    def __deepcopy__(self, memo):
        return type(self)(copy.deepcopy(self.to_json(), memo))

    def __repr__(self):
        return encode_json_for_repr(self.to_json())


def typed_list(wrapped_type: Callable[[Any], T], validator=None) -> type[List[T]]:
    val = _normalize_validator(wrapped_type, validator)

    class _List(List):
        _validator = val

    _map_type_annotation(_List, wrapped_type, lambda t: List[t])  # type: ignore[valid-type]

    return _List


def number_or_string(value):
    if not isinstance(value, numbers.Real | str):
        raise TypeError
    return value


_set_type_annotation(number_or_string, numbers.Real | str)


def bool_or_string(value):
    if not isinstance(value, bool | str):
        raise TypeError
    return value


_set_type_annotation(bool_or_string, bool | str)
