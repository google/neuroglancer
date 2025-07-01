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


import contextlib
import copy
import threading
import typing

from .random_token import make_random_token


class ConcurrentModificationError(RuntimeError):
    """Indicates a concurrent modification during an update to `.TrackableState`.

    Group:
      trackable-state
    """

    pass


class ChangeNotifier:
    """Notifies registered callbacks in response to changes.

    Group:
      trackable-state
    """

    change_count: int
    """Total number of changes that have occurred."""

    def __init__(self):
        self.__changed_callbacks = set()
        self.change_count = 0
        self.__lock = threading.Lock()

    def add_changed_callback(self, callback: typing.Callable[[], None]):
        """Registers a callback to be invoked when the state changes.

        Registering an already-registered callback is a no-op.

        The callback is invoked immediately with no arguments.  The callback must not block.
        """
        with self.__lock:
            self.__changed_callbacks.add(callback)

    def remove_changed_callback(self, callback: typing.Callable[[], None]):
        """Removes a previously-registered callback."""
        with self.__lock:
            self.__changed_callbacks.remove(callback)

    def _dispatch_changed_callbacks(self):
        with self.__lock:
            self.change_count += 1
            for callback in self.__changed_callbacks:
                callback()


State = typing.TypeVar("State")

Generation = str


class TrackableState(ChangeNotifier, typing.Generic[State]):
    """State object that supports registering change notification callbacks.

    Type parameters:
      State: Value type.

    Group:
      trackable-state
    """

    def __init__(self, wrapper_type, transform_state=None):
        super().__init__()
        self._raw_state = {}
        self._lock = threading.RLock()
        self._generation = make_random_token()
        self._wrapped_state = None
        self._wrapper_type = wrapper_type
        if transform_state is None:

            def transform_state_function(new_state):
                if isinstance(new_state, wrapper_type):
                    return new_state.to_json()
                return new_state

            transform_state = transform_state_function
        self._transform_state = transform_state

    def set_state(
        self,
        new_state: typing.Union[typing.Any, State],
        generation: typing.Optional[Generation] = None,
        existing_generation: typing.Optional[Generation] = None,
    ) -> Generation:
        """
        Sets a new value.

        Args:
          new_state: New state value to assign.
          generation: Generation associated with :py:param:`.new_state`.  If
            not specified, a new unique generation is generated.
          existing_generation: Atomically assign the new state only if the
            existing state has the specified generation.
        Returns:
          Generation associated with the new state.
        Raises:
          ConcurrentModificationError: If :py:param:`.existing_generation` is
            specified and does not match.
        """
        with self._lock:
            if (
                existing_generation is not None
                and self._generation != existing_generation
            ):
                raise ConcurrentModificationError
            new_state = self._transform_state(new_state)
            if new_state != self._raw_state or (
                generation is not None and generation != self._generation
            ):
                if generation is None:
                    generation = make_random_token()
                self._raw_state = new_state
                self._wrapped_state = None
                self._generation = generation
                self._dispatch_changed_callbacks()
            return self._generation

    @property
    def state_and_generation(self) -> tuple[State, Generation]:
        with self._lock:
            return (self.state, self.state_generation)

    @property
    def raw_state_and_generation(self) -> tuple[typing.Any, Generation]:
        with self._lock:
            return (self.raw_state, self.state_generation)

    @property
    def state_generation(self) -> Generation:
        return self._generation

    @property
    def raw_state(self) -> typing.Any:
        return self._raw_state

    @property
    def state(self) -> State:
        with self._lock:
            wrapped_state = self._wrapped_state
            if wrapped_state is None:
                wrapped_state = self._wrapped_state = self._wrapper_type(
                    self._raw_state, _readonly=True
                )
            return wrapped_state

    @contextlib.contextmanager
    def txn(self, overwrite: bool = False, lock: bool = True):
        """Context manager for a state modification transaction."""
        if lock:
            self._lock.acquire()
        try:
            existing_generation: typing.Optional[Generation]
            new_state, existing_generation = self.state_and_generation
            new_state = copy.deepcopy(new_state)
            yield new_state
            if overwrite:
                existing_generation = None
            self.set_state(new_state, existing_generation=existing_generation)
        finally:
            if lock:
                self._lock.release()

    def retry_txn(self, func, retries: int = 10, lock: bool = False):
        for retry in range(retries):
            try:
                with self.txn(lock=lock) as s:
                    return func(s)
            except ConcurrentModificationError:
                if retry + 1 < retries:
                    pass
                raise

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.state!r})"


__all__ = [
    "ChangeNotifier",
    "TrackableState",
    "ConcurrentModificationError",
]
