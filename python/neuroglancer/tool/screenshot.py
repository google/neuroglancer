#!/usr/bin/env python
# @license
# Copyright 2020 Google Inc.
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
"""Tool for creating screenshots with Neuroglancer.

The Neuroglancer state may be specified either by a URL or by a path to a JSON
state file.

Rendering requires a web browser.  By default, a headless chromedriver is
started in the background.  It is also possible to use non-headless chromedriver
or a manually-opened browser.

There are several methods by which the screenshot image may be rendered:

1. The state can be rendered directly as a single frame by Neuroglancer.  This
   is the simplest and fastest method and works for most states.

2. If the output image size exceeds what Neuroglancer/the browser can support
   (usually about 4096x4096), tiled rendering can be used.  In this case,
   Neuroglancer will render the image as multiple tiles which are assembled
   automatically into a single image.  This is enabled automatically if the
   requested image size exceeds the specified tile dimensions.  All normal
   functionality is supported, except for the "show_slices" option whereby
   cross-section panels are also shown in the 3-d view.  Manually-specified
   cross sections via the "cross_sections" property are supported, however.

3. If a very large number of 3-d objects are to be rendered, it may be
   impossible for Neuroglancer to render them all simultaneously due to memory
   limits.  The `--segment-shard-size` option may be specified to enable a
   special rendering mode in which subsets of the objects are rendered
   independently and then combined together into a single image.  Depth
   information is used to combine the images together.  Currently, transparent
   rendering of objects is not supported, though.  As the final image is
   produced incrementally, the state is saved in a `.npz` file, which allows
   resuming if the screenshot process is interrupted.  To avoid resuming if you
   change options, delete the `.npz` file.

Tips:

- The Neuroglancer UI controls are not shown, and in the case of multi-panel
  layouts, there is no border between panels.  In most cases it is desirable to
  capture a single-panel layout.

- The layer side panel and statistics panel, if open, will be closed for the
  screenshot.

- The specified image dimensions will be used, rather than the dimensions of
  your browser window.  This, in combination with the removal of the normal
  Neuroglancer UI controls, means that the field of view may differ somewhat.

- The axis lines and volume bounding boxes will be shown if they are enabled in
  the Neuroglancer state.  If you don't want them in the screenshot, you should
  disable them in the Neuroglancer state.  You may also use the
  `--hide-axis-lines` and `--hide-default-annotations` options.  In most cases
  it is desirable to hide the axis lines and default annotations.

- The scale bars will be shown if they are enabled in the Neuroglancer state.
  If you specify a large image size, you may want to increase the size of the
  scale bar, using the `--scale-bar-scale` option.

"""

import argparse
import collections
import contextlib
import copy
import datetime
import itertools
import numbers
import os
import threading
import time
from typing import NamedTuple, Tuple, Callable, Iterator, List, Optional

import PIL
import numpy as np

import neuroglancer
import neuroglancer.cli
import neuroglancer.webdriver


def _get_total_segments(state):
    num_segments = 0
    for layer in state.layers:
        if not isinstance(layer.layer, neuroglancer.SegmentationLayer):
            continue
        num_segments += len(layer.segments)
    return num_segments


def _should_shard_segments(state, segment_shard_size):
    return _get_total_segments(state) > segment_shard_size


def _calculate_num_shards(state, segment_shard_size):
    total_segments = _get_total_segments(state)
    return -(-total_segments // segment_shard_size)


def _get_sharded_states(state, segment_shard_size, reverse_bits):
    if reverse_bits:
        sort_key = lambda x: int('{:064b}'.format(x)[::-1], 2)
    else:
        sort_key = None
    num_shards = _calculate_num_shards(state, segment_shard_size)
    for shard_i in range(num_shards):
        new_state = copy.deepcopy(state)
        cum_retained = 0
        cum_skipped = segment_shard_size * shard_i
        for i, layer in enumerate(new_state.layers):
            if not isinstance(layer.layer, neuroglancer.SegmentationLayer):
                continue
            segments = sorted(layer.segments, key=sort_key)
            num_to_skip = min(cum_skipped, len(segments))
            segments = segments[num_to_skip:]
            cum_skipped += num_to_skip
            num_to_retain = min(segment_shard_size - cum_retained, len(segments))
            cum_retained += num_to_retain
            layer.segments = set(segments[:num_to_retain])
        yield new_state


class TileGenerator:
    def __init__(self, shape, tile_shape):
        self.tile_shape = tuple(tile_shape)
        self.shape = tuple(shape)
        self.tile_grid_shape = tuple(-(-self.shape[i] // self.tile_shape[i]) for i in range(2))
        self.tile_shape = tuple(-(-self.shape[i] // self.tile_grid_shape[i]) for i in range(2))
        self.num_tiles = self.tile_grid_shape[0] * self.tile_grid_shape[1]

    def get_tile_states(self, state):
        for tile_y in range(self.tile_grid_shape[1]):
            for tile_x in range(self.tile_grid_shape[0]):
                x_offset = tile_x * self.tile_shape[0]
                y_offset = tile_y * self.tile_shape[1]
                tile_width = min(self.tile_shape[0], self.shape[0] - x_offset)
                tile_height = min(self.tile_shape[1], self.shape[1] - y_offset)
                new_state = copy.deepcopy(state)
                new_state.partial_viewport = [
                    x_offset / self.shape[0], y_offset / self.shape[1], tile_width / self.shape[0],
                    tile_height / self.shape[1]
                ]
                params = {
                    'tile_x': tile_x,
                    'tile_y': tile_y,
                    'x_offset': x_offset,
                    'y_offset': y_offset,
                    'tile_width': tile_width,
                    'tile_height': tile_height,
                }
                yield params, new_state


class ShardedTileGenerator(TileGenerator):
    def __init__(self, state, segment_shard_size, reverse_bits, **kwargs):
        super(ShardedTileGenerator, self).__init__(**kwargs)
        self.state = state
        self.reverse_bits = reverse_bits
        self.total_segments = _get_total_segments(self.state)
        self.segment_shard_size = segment_shard_size
        self.num_shards = _calculate_num_shards(self.state, self.segment_shard_size)
        self.num_tiles *= self.num_shards

    def get_states(self):
        for shard_i, state in enumerate(
                _get_sharded_states(self.state,
                                    self.segment_shard_size,
                                    reverse_bits=self.reverse_bits)):
            for params, state in self.get_tile_states(state):
                params['segment_shard'] = shard_i
                yield params, state


class CaptureScreenshotRequest(NamedTuple):
    state: neuroglancer.ViewerState
    description: str
    config_callback: Callable[[neuroglancer.viewer_config_state.ConfigState], None]
    response_callback: neuroglancer.viewer_config_state.ScreenshotReply
    include_depth: bool = False


def buffered_iterator(base_iter, lock, buffer_size):
    while True:
        with lock:
            buffered_items = list(itertools.islice(base_iter, buffer_size))
        if not buffered_items: break
        for item in buffered_items:
            yield item


def capture_screenshots(viewer: neuroglancer.Viewer,
                        request_iter: Iterator[CaptureScreenshotRequest],
                        refresh_browser_callback: Callable[[], None],
                        refresh_browser_timeout: int,
                        num_to_prefetch: int = 1) -> None:
    prefetch_buffer = list(itertools.islice(request_iter, num_to_prefetch + 1))
    while prefetch_buffer:
        with viewer.config_state.txn() as s:
            s.show_ui_controls = False
            s.show_panel_borders = False
            del s.prefetch[:]
            for i, request in enumerate(prefetch_buffer[1:]):
                s.prefetch.append(
                    neuroglancer.PrefetchState(state=request.state, priority=num_to_prefetch - i))
            request = prefetch_buffer[0]
            request.config_callback(s)
        viewer.set_state(request.state)
        print('%s [%s] Requesting screenshot' % (
            datetime.datetime.now().strftime('%Y-%m-%dT%H:%M%S.%f'),
            request.description,
        ))
        last_statistics_time = time.time()

        def statistics_callback(statistics):
            nonlocal last_statistics_time
            last_statistics_time = time.time()
            total = statistics.total
            print(
                '%s [%s] Screenshot in progress: %6d/%6d chunks loaded (%10d bytes), %3d downloading'
                % (
                    datetime.datetime.now().strftime('%Y-%m-%dT%H:%M%S.%f'),
                    request.description,
                    total.visible_chunks_gpu_memory,
                    total.visible_chunks_total,
                    total.visible_gpu_memory,
                    total.visible_chunks_downloading,
                ))

        event = threading.Event()
        screenshot = None

        def result_callback(s):
            nonlocal screenshot
            screenshot = s.screenshot
            event.set()

        viewer.async_screenshot(
            result_callback,
            include_depth=request.include_depth,
            statistics_callback=statistics_callback,
        )

        def get_timeout():
            return max(0, last_statistics_time + refresh_browser_timeout - time.time())

        while True:
            if event.wait(get_timeout()):
                break
            if get_timeout() > 0:
                continue
            last_statistics_time = time.time()
            refresh_browser_callback()
        request.response_callback(screenshot)
        del prefetch_buffer[0]
        next_request = next(request_iter, None)
        if next_request is not None:
            prefetch_buffer.append(next_request)


def capture_screenshots_in_parallel(viewers: List[Tuple[neuroglancer.Viewer, Callable[[], None]]],
                                    request_iter: Iterator[CaptureScreenshotRequest],
                                    refresh_browser_timeout: numbers.Number, num_to_prefetch: int,
                                    total_requests: Optional[int] = None,
                                    buffer_size: Optional[int] = None):
    if buffer_size is None:
        if total_requests is None:
            copy_of_requests = list(request_iter)
            total_requests = len(copy_of_requests)
            request_iter = iter(copy_of_requests)
        buffer_size = max(1, total_requests // (len(viewers) * 4))
    request_iter = iter(request_iter)
    threads = []
    buffer_lock = threading.Lock()
    for viewer, refresh_browser_callback in viewers:

        def capture_func(viewer, refresh_browser_callback):
            viewer_request_iter = buffered_iterator(base_iter=request_iter,
                                                    lock=buffer_lock,
                                                    buffer_size=buffer_size)
            capture_screenshots(
                viewer=viewer,
                request_iter=viewer_request_iter,
                num_to_prefetch=num_to_prefetch,
                refresh_browser_timeout=refresh_browser_timeout,
                refresh_browser_callback=refresh_browser_callback,
            )

        t = threading.Thread(target=capture_func, args=(viewer, refresh_browser_callback))
        t.start()
        threads.append(t)
    for t in threads:
        t.join()


class MultiCapturer:
    def __init__(self,
                 shape,
                 include_depth,
                 output,
                 config_callback,
                 num_to_prefetch,
                 checkpoint_interval=60):
        self.include_depth = include_depth
        self.checkpoint_interval = checkpoint_interval
        self.config_callback = config_callback
        self.num_to_prefetch = num_to_prefetch
        self.output = output
        self._processed = set()
        self.state_file = output + '.npz'
        self.temp_state_file = self.state_file + '.tmp'
        self.image_array = np.zeros((shape[1], shape[0], 4), dtype=np.uint8)
        if self.include_depth:
            self.depth_array = np.zeros((shape[1], shape[0]), dtype=np.float32)
        self._load_state()
        self._add_image_lock = threading.Lock()
        self._last_save_time = time.time()
        self._save_state_in_progress = threading.Event()
        self._save_state_in_progress.set()
        self._num_states_processed = 0
        self._start_time = time.time()

    def _load_state(self):
        if not os.path.exists(self.state_file):
            return
        with np.load(self.state_file, allow_pickle=True) as f:
            if self.include_depth:
                self.depth_array = f['depth']
            self.image_array = f['image']
            self._processed = set(f['processed'].ravel()[0])

    def _save_state(self, save_image=False):
        with self._add_image_lock:
            processed = set(self._processed)
        with open(self.temp_state_file, 'wb') as f:
            save_arrays = {
                'image': self.image_array,
                'processed': processed,
            }
            if self.include_depth:
                save_arrays['depth'] = self.depth_array
            np.savez_compressed(f, **save_arrays)
        os.replace(self.temp_state_file, self.state_file)
        if save_image:
            self._save_image()

    def _save_state_async(self, save_image=False):
        print('Starting checkpointing')

        def func():
            try:
                self._save_state()
                print('Done checkpointing')
            finally:
                self._save_state_in_progress.set()

        threading.Thread(target=func, daemon=True).start()

    def _save_image(self):
        im = PIL.Image.fromarray(self.image_array)
        im.save(self.output)

    def _add_image(self, params, screenshot):
        with self._add_image_lock:
            tile_image = screenshot.image_pixels
            tile_selector = np.s_[params['y_offset']:params['y_offset'] + params['tile_height'],
                                  params['x_offset']:params['x_offset'] + params['tile_width']]
            if self.include_depth:
                tile_depth = screenshot.depth_array
                depth_array_part = self.depth_array[tile_selector]
                mask = np.logical_and(np.logical_or(tile_depth != 0, depth_array_part == 0),
                                      tile_depth >= depth_array_part)
                depth_array_part[mask] = tile_depth[mask]
            else:
                mask = Ellipsis
            self.image_array[tile_selector][mask] = tile_image[mask]
            self._processed.add(self._get_description(params))
            self._num_states_processed += 1
            elapsed = time.time() - self._start_time
            print('%4d tiles rendered in %5d seconds: %.1f seconds/tile' %
                  (self._num_states_processed, elapsed, elapsed / self._num_states_processed))

    def _maybe_save_state(self):
        if not self._save_state_in_progress.is_set(): return
        with self._add_image_lock:
            if self._last_save_time + self.checkpoint_interval < time.time():
                self._last_save_time = time.time()
                self._save_state_in_progress.clear()
                self._save_state_async(save_image=False)

    def _get_description(self, params):
        segment_shard = params.get('segment_shard')
        if segment_shard is not None:
            prefix = 'segment_shard=%d ' % (segment_shard, )
        else:
            prefix = ''
        return '%stile_x=%d tile_y=%d' % (prefix, params['tile_x'], params['tile_y'])

    def _make_capture_request(self, params, state):
        description = self._get_description(params)

        if description in self._processed: return None

        def config_callback(s):
            s.viewer_size = (params['tile_width'], params['tile_height'])
            self.config_callback(s)

        def response_callback(screenshot):
            self._add_image(params, screenshot)
            self._maybe_save_state()

        return CaptureScreenshotRequest(state=state,
                                        description=self._get_description(params),
                                        config_callback=config_callback,
                                        response_callback=response_callback,
                                        include_depth=self.include_depth)

    def _get_capture_screenshot_request_iter(self, state_iter):
        for params, state in state_iter:
            request = self._make_capture_request(params, state)
            if request is not None: yield request

    def capture(self, viewers, state_iter, refresh_browser_timeout: int, save_depth: bool, total_requests: int):
        capture_screenshots_in_parallel(
            viewers=viewers,
            request_iter=self._get_capture_screenshot_request_iter(state_iter),
            refresh_browser_timeout=refresh_browser_timeout,
            num_to_prefetch=self.num_to_prefetch,
            total_requests=total_requests)
        if not self._save_state_in_progress.is_set():
            print('Waiting for previous save state to complete')
            self._save_state_in_progress.wait()
        if save_depth:
            self._save_state()
        else:
            self._save_image()
            if os.path.exists(self.state_file):
                os.remove(self.state_file)


def capture_image(viewers, args, state):
    def config_callback(s):
        s.scale_bar_options.scale_factor = args.scale_bar_scale

    segment_shard_size = args.segment_shard_size
    tile_parameters = dict(
        shape=(args.width, args.height),
        tile_shape=(args.tile_width, args.tile_height),
    )
    if segment_shard_size is not None and _should_shard_segments(state, segment_shard_size):
        gen = ShardedTileGenerator(state=state,
                                   segment_shard_size=segment_shard_size,
                                   reverse_bits=args.sort_segments_by_reversed_bits,
                                   **tile_parameters)
        num_states = gen.num_tiles
        state_iter = gen.get_states()
        include_depth = True
    else:
        gen = TileGenerator(**tile_parameters)
        num_states = gen.num_tiles
        state_iter = gen.get_tile_states(state)
        include_depth = False

    capturer = MultiCapturer(
        shape=tile_parameters['shape'],
        include_depth=include_depth,
        output=args.output,
        config_callback=config_callback,
        num_to_prefetch=args.prefetch,
        checkpoint_interval=args.checkpoint_interval,
    )
    num_output_shards = args.num_output_shards
    tiles_per_output_shard = args.tiles_per_output_shard
    output_shard = args.output_shard
    if (output_shard is None) != (num_output_shards is None and tiles_per_output_shard is None):
        raise ValueError(
            '--output-shard must be specified in combination with --num-output-shards or --tiles-per-output-shard'
        )
    if output_shard is not None:
        if num_output_shards is not None:
            if num_output_shards < 1:
                raise ValueError('Invalid --num-output-shards: %d' % (num_output_shards, ))
            states_per_shard = -(-num_states // num_output_shards)
        else:
            if tiles_per_output_shard < 1:
                raise ValueError('Invalid --tiles-per-output-shard: %d' %
                                 (tiles_per_output_shard, ))
            num_output_shards = -(-num_states // tiles_per_output_shard)
            states_per_shard = tiles_per_output_shard
        if output_shard < 0 or output_shard >= num_output_shards:
            raise ValueError('Invalid --output-shard: %d' % (output_shard, ))
        print('Total states: %d, Number of output shards: %d' % (num_states, num_output_shards))
        state_iter = itertools.islice(state_iter, states_per_shard * output_shard,
                                      states_per_shard * (output_shard + 1))
    else:
        states_per_shard = num_states
    capturer.capture(
        viewers=viewers,
        state_iter=state_iter,
        refresh_browser_timeout=args.refresh_browser_timeout,
        save_depth=output_shard is not None,
        total_requests=states_per_shard,
    )


def define_state_modification_args(ap: argparse.ArgumentParser):
    ap.add_argument('--hide-axis-lines',
                    dest='show_axis_lines',
                    action='store_false',
                    help='Override showAxisLines setting in state.')
    ap.add_argument('--hide-default-annotations',
                    action='store_false',
                    dest='show_default_annotations',
                    help='Override showDefaultAnnotations setting in state.')
    ap.add_argument('--projection-scale-multiplier',
                    type=float,
                    help='Multiply projection view scale by specified factor.')
    ap.add_argument('--system-memory-limit',
                    type=int,
                    default=3 * 1024 * 1024 * 1024,
                    help='System memory limit')
    ap.add_argument('--gpu-memory-limit',
                    type=int,
                    default=3 * 1024 * 1024 * 1024,
                    help='GPU memory limit')
    ap.add_argument('--concurrent-downloads', type=int, default=32, help='Concurrent downloads')
    ap.add_argument('--layout', type=str, help='Override layout setting in state.')
    ap.add_argument('--cross-section-background-color',
                    type=str,
                    help='Background color for cross sections.')
    ap.add_argument('--scale-bar-scale', type=float, help='Scale factor for scale bar', default=1)


def apply_state_modifications(state: neuroglancer.ViewerState, args: argparse.Namespace):
    state.selected_layer.visible = False
    state.statistics.visible = False
    if args.layout is not None:
        state.layout = args.layout
    if args.show_axis_lines is not None:
        state.show_axis_lines = args.show_axis_lines
    if args.show_default_annotations is not None:
        state.show_default_annotations = args.show_default_annotations
    if args.projection_scale_multiplier is not None:
        state.projection_scale *= args.projection_scale_multiplier
    if args.cross_section_background_color is not None:
        state.cross_section_background_color = args.cross_section_background_color

    state.gpu_memory_limit = args.gpu_memory_limit
    state.system_memory_limit = args.system_memory_limit
    state.concurrent_downloads = args.concurrent_downloads


def define_viewer_args(ap: argparse.ArgumentParser):
    ap.add_argument('--browser', choices=['chrome', 'firefox'], default='chrome')
    ap.add_argument('--no-webdriver',
                    action='store_true',
                    help='Do not open browser automatically via webdriver.')
    ap.add_argument('--no-headless',
                    dest='headless',
                    action='store_false',
                    help='Use non-headless webdriver.')
    ap.add_argument('--docker-chromedriver',
                    action='store_true',
                    help='Run Chromedriver with options suitable for running inside docker')
    ap.add_argument('--debug-chromedriver',
                    action='store_true',
                    help='Enable debug logging in Chromedriver')
    ap.add_argument('--jobs',
                    '-j',
                    type=int,
                    default=1,
                    help='Number of browsers to use concurrently.  '
                    'This may improve performance at the cost of greater memory usage.  '
                    'On a 64GiB 16 hyperthread machine, --jobs=6 works well.')


def define_size_args(ap: argparse.ArgumentParser):
    ap.add_argument('--width', type=int, default=3840, help='Width in pixels of image.')
    ap.add_argument('--height', type=int, default=2160, help='Height in pixels of image.')


def define_tile_args(ap: argparse.ArgumentParser):
    ap.add_argument(
        '--tile-width',
        type=int,
        default=4096,
        help=
        'Width in pixels of single tile.  If total width is larger, the screenshot will be captured as multiple tiles.'
    )
    ap.add_argument(
        '--tile-height',
        type=int,
        default=4096,
        help=
        'Height in pixels of single tile.  If total height is larger, the screenshot will be captured as multiple tiles.'
    )
    ap.add_argument('--segment-shard-size',
                    type=int,
                    help='Maximum number of segments to render simultaneously.  '
                    'If the number of selected segments exceeds this number, '
                    'multiple passes will be used (transparency not supported).')
    ap.add_argument(
        '--sort-segments-by-reversed-bits',
        action='store_true',
        help=
        'When --segment-shard-size is also specified, normally segment ids are ordered numerically before being partitioned into shards.  If segment ids are spatially correlated, then this can lead to slower and more memory-intensive rendering.  If --sort-segments-by-reversed-bits is specified, segment ids are instead ordered by their bit reversed values, which may avoid the spatial correlation.'
    )


def define_capture_args(ap: argparse.ArgumentParser):
    ap.add_argument('--prefetch', type=int, default=1, help='Number of states to prefetch.')
    ap.add_argument(
        '--refresh-browser-timeout',
        type=int,
        default=60,
        help=
        'Number of seconds without receiving statistics while capturing a screenshot before browser is considered unresponsive.'
    )


@contextlib.contextmanager
def get_viewers(args: argparse.Namespace):
    if args.no_webdriver:
        viewers = [neuroglancer.Viewer() for _ in range(args.jobs)]
        print('Open the following URLs to begin rendering')
        for viewer in viewers:
            print(viewer)

        def refresh_browser_callback():
            print('Browser unresponsive, consider reloading')

        yield [(viewer, refresh_browser_callback) for viewer in viewers]
    else:

        def _make_webdriver():
            webdriver = neuroglancer.webdriver.Webdriver(
                headless=args.headless,
                docker=args.docker_chromedriver,
                debug=args.debug_chromedriver,
                browser=args.browser,
            )

            def refresh_browser_callback():
                print('Browser unresponsive, reloading')
                webdriver.reload_browser()

            return webdriver, refresh_browser_callback

        webdrivers = [_make_webdriver() for _ in range(args.jobs)]
        try:
            yield [(webdriver.viewer, refresh_browser_callback)
                   for webdriver, refresh_browser_callback in webdrivers]
        finally:
            for webdriver, _ in webdrivers:
                try:
                    webdriver.__exit__()
                except:
                    pass


def run(args: argparse.Namespace):
    neuroglancer.cli.handle_server_arguments(args)
    state = args.state
    apply_state_modifications(state, args)
    with get_viewers(args) as viewers:
        capture_image(viewers, args, state)


def main(args=None):
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    neuroglancer.cli.add_state_arguments(ap, required=True)

    ap.add_argument('output', help='Output path of screenshot file in PNG format.')

    ap.add_argument('--output-shard', type=int, help='Output shard to write.')
    output_shard_group = ap.add_mutually_exclusive_group(required=False)
    output_shard_group.add_argument('--num-output-shards',
                                    type=int,
                                    help='Number of output shards.')
    output_shard_group.add_argument('--tiles-per-output-shard',
                                    type=int,
                                    help='Number of tiles per output shard.')
    ap.add_argument('--checkpoint-interval',
                    type=float,
                    default=60,
                    help='Interval in seconds at which to save checkpoints.')

    define_state_modification_args(ap)
    define_viewer_args(ap)
    define_size_args(ap)
    define_tile_args(ap)
    define_capture_args(ap)

    run(ap.parse_args(args))


if __name__ == '__main__':
    main()
