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


import collections
import collections.abc
import contextlib
import json
import re
import typing
from concurrent.futures import Future

import numpy as np

from . import (
    coordinate_space,
    local_volume,
    skeleton,
    trackable_state,
    viewer_config_state,
    viewer_state,
)
from .json_utils import decode_json, encode_json, json_encoder_default
from .random_token import make_random_token

try:
    import tensorstore as ts
except ImportError:
    pass


class LocalVolumeManager(trackable_state.ChangeNotifier):
    def __init__(self, token_prefix: str) -> None:
        super().__init__()
        self.volumes: dict[str, local_volume.LocalVolume | skeleton.SkeletonSource] = (
            dict()
        )
        self.__token_prefix: str = token_prefix

    def register_volume(
        self, v: local_volume.LocalVolume | skeleton.SkeletonSource
    ) -> str:
        if v.token not in self.volumes:
            self.volumes[v.token] = v
            self._dispatch_changed_callbacks()
        if isinstance(v, local_volume.LocalVolume):
            source_type = "volume"
        else:
            source_type = "skeleton"
        return f"python://{source_type}/{self.get_volume_key(v)}"

    def get_volume_key(
        self, v: local_volume.LocalVolume | skeleton.SkeletonSource
    ) -> str:
        return self.__token_prefix + v.token

    def update(self, json_str: str) -> None:
        pattern = "|".join(self.volumes)
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


class ViewerCommonBase:
    def __init__(
        self, token: str | None = None, allow_credentials: bool | None = None
    ) -> None:
        if token is None:
            token = make_random_token()
            if allow_credentials is None:
                allow_credentials = True
        else:
            if allow_credentials is None:
                allow_credentials = False
        self.allow_credentials = allow_credentials
        self.token = token
        self.config_state: trackable_state.TrackableState[
            viewer_config_state.ConfigState
        ] = trackable_state.TrackableState(viewer_config_state.ConfigState)

        def set_actions(actions):
            def func(s):
                s.actions = actions

            self.config_state.retry_txn(func, lock=True)

        self.actions = viewer_config_state.Actions(set_actions)

        self.volume_manager = LocalVolumeManager(self.token + ".")

        self.__watched_volumes: dict[
            str, local_volume.LocalVolume | skeleton.SkeletonSource
        ] = dict()

        self.volume_manager.add_changed_callback(self._handle_volumes_changed)

        self._next_screenshot_id = 0
        self._screenshot_callbacks: dict[
            str,
            tuple[
                typing.Callable[[viewer_config_state.ActionState], None],
                typing.Callable[[viewer_config_state.ScreenshotStatistics], None]
                | None,
            ],
        ] = {}
        self._volume_info_promises: dict[
            str, Future[viewer_config_state.VolumeInfo]
        ] = {}
        self._volume_chunk_promises: dict[str, Future[np.ndarray]] = {}
        self.actions.add("screenshot", self._handle_screenshot_reply)
        self.actions.add("screenshotStatistics", self._handle_screenshot_statistics)

    @typing.overload
    def async_screenshot(
        self,
        callback: typing.Callable[[viewer_config_state.ActionState], None],
        *,
        include_depth: bool = False,
        statistics_callback: typing.Callable[
            [viewer_config_state.ScreenshotStatistics], None
        ]
        | None = None,
    ) -> None: ...

    @typing.overload
    def async_screenshot(
        self,
        *,
        include_depth: bool = False,
        statistics_callback: typing.Callable[
            [viewer_config_state.ScreenshotStatistics], None
        ]
        | None = None,
    ) -> Future[viewer_config_state.ActionState]: ...

    def async_screenshot(
        self,
        callback: typing.Callable[[viewer_config_state.ActionState], None]
        | None = None,
        *,
        include_depth: bool = False,
        statistics_callback: typing.Callable[
            [viewer_config_state.ScreenshotStatistics], None
        ]
        | None = None,
    ) -> Future[viewer_config_state.ActionState] | None:
        """Captures a screenshot asynchronously."""

        future: Future[viewer_config_state.ActionState] | None = None

        if callback is None:
            future = Future()

            def callback(s: viewer_config_state.ActionState) -> None:
                future.set_result(s)

        screenshot_id = str(self._next_screenshot_id)
        if include_depth:
            screenshot_id = screenshot_id + "_includeDepth"
        self._next_screenshot_id += 1

        def set_screenshot_id(s):
            s.screenshot = screenshot_id

        self.config_state.retry_txn(set_screenshot_id, lock=True)
        self._screenshot_callbacks[screenshot_id] = (callback, statistics_callback)

        return future

    def screenshot(
        self,
        size: tuple[int, int] | None = None,
        include_depth: bool = False,
        statistics_callback: typing.Callable[
            [viewer_config_state.ScreenshotStatistics], None
        ]
        | None = None,
    ) -> viewer_config_state.ActionState:
        """Captures a screenshot synchronously.

        :param size: Optional.  List of [width, height] specifying the dimension
                     in pixels of the canvas to use.  If specified, UI controls
                     are hidden and the canvas is resized to the specified
                     dimensions while the screenshot is captured.

        :param include_depth: Optional.  Specifies whether to also return depth
                              information.

        :returns: The screenshot.
        """
        try:
            if size is not None:
                prior_state = self.config_state.state
                with self.config_state.txn() as s:
                    s.show_ui_controls = False
                    s.show_panel_borders = False
                    s.viewer_size = size
            for _ in range(5):
                # Allow multiple retries in case size is not respected on first attempt
                result = self.async_screenshot(
                    include_depth=include_depth,
                    statistics_callback=statistics_callback,
                ).result()
                if result.screenshot is None:
                    continue
                if (
                    size is not None
                    and (result.screenshot.width, result.screenshot.height) != size
                ):
                    continue
                break
        finally:
            if size is not None:
                self.config_state.set_state(prior_state)
        return result

    def _handle_screenshot_reply(self, s: viewer_config_state.ActionState):
        def set_screenshot_id(s):
            s.screenshot = None

        self.config_state.retry_txn(set_screenshot_id, lock=True)
        screenshot_id = s.screenshot.id
        callback = self._screenshot_callbacks.pop(screenshot_id, None)
        if callback is not None:
            callback[0](s)

    def _handle_screenshot_statistics(self, s: viewer_config_state.ActionState):
        screenshot_id = s.screenshot_statistics.id
        callback = self._screenshot_callbacks.get(screenshot_id)
        if callback is None or callback[1] is None:
            return
        callback[1](s.screenshot_statistics)

    def volume_info(
        self,
        layer: str,
        *,
        dimensions: coordinate_space.CoordinateSpace | None = None,
    ) -> "Future[viewer_config_state.VolumeInfo]":
        request_id = make_random_token()
        future: Future[viewer_config_state.VolumeInfo] = Future()
        self._volume_info_promises[request_id] = future

        def add_request(s):
            s.volume_requests.append(
                viewer_config_state.VolumeRequest(
                    kind="volume_info",
                    id=request_id,
                    layer=layer,
                    dimensions=dimensions,
                )
            )

        try:
            self.config_state.retry_txn(add_request, lock=True)
        except:
            self._volume_info_promises.pop(request_id, None)
            raise
        return future

    def volume(
        self,
        layer: str,
        *,
        dimensions: coordinate_space.CoordinateSpace | None = None,
    ) -> "Future[ts.TensorStore]":
        future: Future[ts.TensorStore] = Future()

        def info_done(info_future):
            try:
                info = info_future.result()
                dimension_units = [
                    f"{scale} {unit}"
                    for scale, unit in zip(
                        info.dimensions.scales, info.dimensions.units
                    )
                ]

                def read_function(
                    domain: ts.IndexDomain,
                    array: np.ndarray,
                    params: ts.VirtualChunkedReadParameters,
                ) -> ts.Future[None]:
                    read_promise, read_future = ts.Promise[None].new()
                    origin = domain.origin
                    grid_origin = info.grid_origin
                    chunk_shape = info.chunk_shape
                    chunk_pos = [
                        (origin[i] - grid_origin[i]) / chunk_shape[i]
                        for i in range(domain.rank)
                    ]

                    def chunk_done(chunk_future):
                        try:
                            chunk = chunk_future.result()
                            array[...] = chunk[domain.translate_to[0].index_exp]
                            read_promise.set_result(None)
                        except Exception as e:
                            read_promise.set_exception(e)

                    self._volume_chunk(layer, info, chunk_pos).add_done_callback(
                        chunk_done
                    )
                    return read_future

                future.set_result(
                    ts.virtual_chunked(
                        read_function=read_function,
                        rank=info.rank,
                        dtype=ts.dtype(info.data_type),
                        domain=ts.IndexDomain(
                            labels=info.dimensions.names,
                            inclusive_min=info.lower_bound,
                            exclusive_max=info.upper_bound,
                        ),
                        dimension_units=dimension_units,
                        chunk_layout=ts.ChunkLayout(read_chunk_shape=info.chunk_shape),
                    )
                )
            except Exception as e:
                future.set_exception(e)

        info_future = self.volume_info(layer, dimensions=dimensions)
        info_future.add_done_callback(info_done)
        return future

    def _volume_chunk(
        self,
        layer: str,
        info: viewer_config_state.VolumeInfo,
        chunk_grid_position: collections.abc.Sequence[int],
    ) -> Future[np.ndarray]:
        request_id = make_random_token()
        # promise, future = ts.Promise.new()
        future: Future[np.ndarray]
        promise: Future[np.ndarray]
        future = promise = Future()
        self._volume_chunk_promises[request_id] = promise

        def add_request(s):
            s.volume_requests.append(
                viewer_config_state.VolumeRequest(
                    kind="volume_chunk",
                    id=request_id,
                    layer=layer,
                    volume_info=info,
                    chunk_grid_position=chunk_grid_position,
                )
            )

        try:
            self.config_state.retry_txn(add_request, lock=True)
        except:
            self._volume_chunk_promises.pop(request_id, None)
            raise
        return future

    def _handle_volume_info_reply(self, request_id, reply):
        def remove_request(s):
            s.volume_requests = [r for r in s.volume_requests if r.id != request_id]

        self.config_state.retry_txn(remove_request, lock=True)
        promise = self._volume_info_promises.pop(request_id, None)
        if promise is None:
            return
        if not isinstance(reply, dict):
            return
        error = reply.get("error")
        if error is not None:
            promise.set_exception(ValueError(error))
        else:
            promise.set_result(viewer_config_state.VolumeInfo(reply))

    def _handle_volume_chunk_reply(self, request_id, params, data):
        def remove_request(s):
            s.volume_requests = [r for r in s.volume_requests if r.id != request_id]

        self.config_state.retry_txn(remove_request, lock=True)
        promise = self._volume_chunk_promises.pop(request_id, None)
        if promise is None:
            return
        if not isinstance(params, dict):
            return
        error = params.get("error")
        if error is not None:
            promise.set_exception(ValueError(error))
            return
        array = np.frombuffer(data, dtype=np.dtype(params["dtype"]))
        order = params["order"]
        rank = len(order)
        shape = params["chunkDataSize"]
        inverse_order = [0] * rank
        for physical_dim, logical_dim in enumerate(order):
            inverse_order[logical_dim] = physical_dim
        if params.get("isFillValue"):
            array = np.broadcast_to(array.reshape([]), shape[::-1])
        else:
            array = array.reshape(shape[::-1])
        array = array.transpose(inverse_order)
        promise.set_result(array)

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
                volume_manager.get_volume_key(x): x.change_count
                for x in self.volume_manager.volumes.values()
            }

        self.config_state.retry_txn(func, lock=True)

    def _transform_viewer_state(self, new_state):
        if isinstance(new_state, viewer_state.ViewerState):
            new_state = new_state.to_json()

            def encoder(x):
                if isinstance(x, local_volume.LocalVolume | skeleton.SkeletonSource):
                    return self.volume_manager.register_volume(x)
                return json_encoder_default(x)

            new_state = decode_json(json.dumps(new_state, default=encoder))
        return new_state

    def txn(self) -> typing.ContextManager[viewer_state.ViewerState]:
        raise NotImplementedError


class ViewerBase(ViewerCommonBase):
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.shared_state: trackable_state.TrackableState[viewer_state.ViewerState] = (
            trackable_state.TrackableState(
                viewer_state.ViewerState, self._transform_viewer_state
            )
        )
        self.shared_state.add_changed_callback(
            lambda: self.volume_manager.update(encode_json(self.shared_state.raw_state))
        )

    @property
    def state(self) -> viewer_state.ViewerState:
        return self.shared_state.state

    def set_state(self, *args, **kwargs):
        return self.shared_state.set_state(*args, **kwargs)

    def txn(self, *args, **kwargs) -> typing.ContextManager[viewer_state.ViewerState]:
        return self.shared_state.txn(*args, **kwargs)

    def retry_txn(self, *args, **kwargs):
        return self.shared_state.retry_txn(*args, **kwargs)


class UnsynchronizedViewerBase(ViewerCommonBase):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.state = viewer_state.ViewerState()

    @property
    def raw_state(self) -> typing.Any:
        return self._transform_viewer_state(self.state)

    def set_state(self, new_state: typing.Any | viewer_state.ViewerState) -> None:
        self.state = viewer_state.ViewerState(new_state)

    @contextlib.contextmanager
    def txn(self) -> collections.abc.Iterator[viewer_state.ViewerState]:
        yield self.state

    def retry_txn(
        self,
        func: typing.Callable[[viewer_state.ViewerState], None],
        retries: int | None = None,
    ):
        del retries
        return func(self.state)
