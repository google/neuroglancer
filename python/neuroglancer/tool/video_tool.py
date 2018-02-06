#!/usr/bin/env python
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
"""Tool for creating videos (sequences of screenshots) from Neuroglancer.

The video is specified by a "script", which is a text file of the form:

  <neuroglancer-url>
  <transition-duration>
  <neuroglancer-url>
  ...
  <neuroglancer-url>
  <transition-duration>
  <neuroglancer-url>

The transition-duration is a floating point number encoded in text format that
specifies the length of the transition between the two states in seconds.  Each
transition corresponds to smoothly interpolating between the adjacent states
over the specified duration: positions are interpolated linearly, orientations
are interpolated using spherical linear interpolation, and zoom factors are
interpolated exponentially.

Note that combining zooming with position movement in a single transition (as
can occur when using the mouse wheel rather than the keyboard commands to zoom
out) may produce a poor interpolation result, because the position will appear
to move at a much faster rate when zoomed in than when zoomed out.

Using the `edit` command, you can interactively create or edit a script.

The `render` command is used to render an existing script to a sequence of PNG
images.  Frames are captured only once all data has been loaded; because of
this, rendering can be slow.

The layer panel and other UI widgets, as well as the borders around panels, are
disabled when rendering.  Additionally, the image size is determined by the
command line `--width` and `--height` arguments, rather than the size of the
browser window.  However, the states in the script determine whether the scale
bar and axis lines are shown.  Therefore, make sure to set their visibility
appropriately when creating the script.

The `toggle-play` command in the editor can be used to preview the transitions.
However, due to limitations in the Neuroglancer Python interface, the frame rate
is limited to 5 frames per second, and what is displayed differs from what will
be rendered in several ways:
  - it does not wait for all data to be loaded;
  - the UI controls and panel borders are shown;
  - the width and height are based on the browser size.
"""

from __future__ import print_function, division

import argparse
import bisect
import math
import os
import threading
import time
import webbrowser

import neuroglancer


class PlaybackManager(object):
    def __init__(self, keypoints, frames_per_second):
        self.keypoints = keypoints
        self.frames_per_second = frames_per_second

        self.total_frames = 0
        self.keypoint_start_frame = []
        self.keypoint_end_frame = []
        for k in keypoints[:-1]:
            duration = k['transition_duration']
            if duration == 0:
                cur_frames = 0
            else:
                cur_frames = max(1, int(round(k['transition_duration'] * frames_per_second)))
            self.keypoint_start_frame.append(self.total_frames)
            self.total_frames += cur_frames
            self.keypoint_end_frame.append(self.total_frames)
        self.keypoint_start_frame.append(self.total_frames)
        self.total_frames += 1
        self.keypoint_end_frame.append(self.total_frames)

    def get_keypoint_from_frame(self, frame_i):
        if frame_i < 0 or frame_i >= self.total_frames:
            raise ValueError
        return bisect.bisect_right(self.keypoint_start_frame, frame_i) - 1

    def get_frame_from_elapsed_time(self, elapsed_time):
        return int(math.floor(elapsed_time * self.frames_per_second))

    def get_frame(self, frame_i):
        start_keypoint = self.get_keypoint_from_frame(frame_i)
        a = self.keypoints[start_keypoint]['state']
        if start_keypoint == len(self.keypoints) - 1:
            return a
        else:
            end_keypoint = start_keypoint + 1
            b = self.keypoints[end_keypoint]['state']
            start_frame = self.keypoint_start_frame[start_keypoint]
            end_frame = self.keypoint_end_frame[start_keypoint]
            t = (frame_i - start_frame) / (end_frame - start_frame)
            return neuroglancer.ViewerState.interpolate(a, b, t)

    def get_frames(self, start_frame, end_frame):
        return [
            self.get_frame(frame_i)
            for frame_i in range(start_frame, min(end_frame, self.total_frames))
        ]

    def set_state(self, viewer, frame_i, prefetch_frames):
        states = self.get_frames(frame_i, frame_i + prefetch_frames)
        viewer.set_state(states[0])
        with viewer.config_state.txn() as s:
            del s.prefetch[:]
            for i, state in enumerate(states[1:]):
                s.prefetch.append(
                    neuroglancer.PrefetchState(state=state, priority=prefetch_frames - i))


class EditorPlaybackManager(object):
    def __init__(self, script_editor, playing=True, frames_per_second=5):
        self.script_editor = script_editor
        self.frames_per_second = frames_per_second
        self.playback_manager = PlaybackManager(script_editor.keypoints, frames_per_second=self.frames_per_second)
        self.current_keypoint_index = max(1, script_editor.keypoint_index)
        self.script_editor._set_keypoint_index(self.current_keypoint_index)
        self.playing = playing
        script_editor.playback_manager = self
        self.current_frame = self.playback_manager.keypoint_start_frame[self.current_keypoint_index - 1]
        self.start_time = (
            time.time() - self.current_frame /
            self.playback_manager.frames_per_second)
        t = threading.Thread(target=self._thread_func)
        t.daemon = True
        t.start()
        self.should_stop = threading.Event()
        self._update()

    def _update_current_frame(self):
        elapsed_time = time.time() - self.start_time
        self.current_frame = self.playback_manager.get_frame_from_elapsed_time(elapsed_time)

    def _display_frame(self):
        frame_i = self.current_frame
        keypoint_index = self.playback_manager.get_keypoint_from_frame(
            min(frame_i, self.playback_manager.total_frames - 1)) + 1
        current_duration = self.script_editor.keypoints[keypoint_index - 1]['transition_duration']
        transition_time = (frame_i - self.playback_manager.keypoint_start_frame[keypoint_index - 1]
                           ) / self.playback_manager.frames_per_second
        self.playback_status = '%s frame %d/%d transition %.1f/%g' % (
            'PLAYING' if self.playing else 'PAUSED', frame_i, self.playback_manager.total_frames, transition_time, current_duration)
        if keypoint_index != self.current_keypoint_index:
            self.script_editor._set_keypoint_index(keypoint_index)
            self.current_keypoint_index = keypoint_index
        if frame_i >= self.playback_manager.total_frames:
            self.script_editor.playback_manager = None
            self.script_editor._update_status()
            self.should_stop.set()
            return
        self.playback_manager.set_state(self.script_editor.viewer, frame_i, prefetch_frames=10)
        self.script_editor._update_status()

    def reload(self):
        self.playback_manager = PlaybackManager(self.script_editor.keypoints, frames_per_second=self.frames_per_second)
        self.current_keypoint_index = None
        self.seek_frame(0)

    def pause(self):
        if self.playing:
            self.seek_frame(0)
        else:
            self.start_time = time.time() - self.current_frame / self.playback_manager.frames_per_second
            self.playing = True
    def seek_frame(self, amount):
        if self.playing:
            self.playing = False
            self._update_current_frame()
        self.current_frame += amount
        self.current_frame = max(0, min(self.current_frame, self.playback_manager.total_frames - 1))
        self._display_frame()

    def _thread_func(self):
        while True:
            time.sleep(0.2)
            self.script_editor.viewer.defer_callback(self._update)
            if self.should_stop.is_set():
                return

    def _update(self):
        if self.script_editor.playback_manager is not self:
            self.should_stop.set()
            return
        if not self.playing:
            return
        self._update_current_frame()
        self._display_frame()


def load_script(script_path, transition_duration=1):
    keypoints = []
    with open(script_path, 'r') as f:
        while True:
            url = f.readline()
            if not url:
                break
            line = f.readline()
            if not line:
                duration = transition_duration
            else:
                duration = float(line)
            keypoints.append({
                'state': neuroglancer.parse_url(url),
                'transition_duration': duration
            })
    return keypoints


def save_script(script_path, keypoints):
    temp_path = script_path + '.tmp'
    with open(temp_path, 'w') as f:
        for x in keypoints:
            f.write(neuroglancer.to_url(x['state']) + '\n')
            f.write(str(x['transition_duration']) + '\n')
    os.rename(temp_path, script_path)


class ScriptEditor(object):
    def __init__(self, script_path, transition_duration, fullscreen_width, fullscreen_height, frames_per_second):
        self.script_path = script_path
        self.viewer = neuroglancer.Viewer()
        self.frames_per_second = frames_per_second
        self.default_transition_duration = transition_duration
        self.fullscreen_width = fullscreen_width
        self.fullscreen_height = fullscreen_height
        self.keypoint_index = 0
        if os.path.exists(script_path):
            self.keypoints = load_script(script_path, self.default_transition_duration)
        else:
            self.keypoints = []

        self.transition_duration = transition_duration
        self.viewer.shared_state.add_changed_callback(self._viewer_state_changed)
        self.quit_event = threading.Event()
        self.is_dirty = True
        self.is_fullscreen = False
        keybindings = [
            ('keyk', 'add-keypoint'),
            ('bracketleft', 'prev-keypoint'),
            ('bracketright', 'next-keypoint'),
            ('backspace', 'delete-keypoint'),
            ('shift+bracketleft', 'decrease-duration'),
            ('shift+bracketright', 'increase-duration'),
            ('home', 'first-keypoint'),
            ('end', 'last-keypoint'),
            ('keyq', 'quit'),
            ('enter', 'toggle-play'),
            ('keyf', 'toggle-fullscreen'),
            ('keyj', 'revert-script'),
            ('comma', 'prev-frame'),
            ('period', 'next-frame'),
        ]
        with self.viewer.config_state.txn() as s:
            for k, a in keybindings:
                s.input_event_bindings.viewer[k] = a
                s.input_event_bindings.slice_view[k] = a
                s.input_event_bindings.perspective_view[k] = a
        self._keybinding_message = ' '.join('%s=%s' % x for x in keybindings)
        self.viewer.actions.add('add-keypoint', self._add_keypoint)
        self.viewer.actions.add('prev-keypoint', self._prev_keypoint)
        self.viewer.actions.add('next-keypoint', self._next_keypoint)
        self.viewer.actions.add('delete-keypoint', self._delete_keypoint)
        self.viewer.actions.add('increase-duration', self._increase_duration)
        self.viewer.actions.add('decrease-duration', self._decrease_duration)
        self.viewer.actions.add('first-keypoint', self._first_keypoint)
        self.viewer.actions.add('last-keypoint', self._last_keypoint)
        self.viewer.actions.add('quit', self._quit)
        self.viewer.actions.add('toggle-play', self._toggle_play)
        self.viewer.actions.add('toggle-fullscreen', self._toggle_fullscreen)
        self.viewer.actions.add('revert-script', self._revert_script)
        self.viewer.actions.add('next-frame', self._next_frame)
        self.viewer.actions.add('prev-frame', self._prev_frame)
        self.playback_manager = None
        self._set_keypoint_index(1)

    def _revert_script(self, s):
        if os.path.exists(self.script_path):
            self.keypoints = load_script(self.script_path, self.default_transition_duration)
            if self.playback_manager is not None:
                self.playback_manager.reload()
            else:
                self._set_keypoint_index(self.keypoint_index)

    def _toggle_fullscreen(self, s):
        self.is_fullscreen = not self.is_fullscreen
        with self.viewer.config_state.txn() as s:
            if self.is_fullscreen:
                s.show_ui_controls = False
                s.show_panel_borders = False
                s.viewer_size = [self.fullscreen_width, self.fullscreen_height]
            else:
                s.show_ui_controls = True
                s.show_panel_borders = True
                s.viewer_size = None

    def _next_frame(self, s):
        if self.playback_manager is None:
            EditorPlaybackManager(self, playing=False, frames_per_second=self.frames_per_second)
        self.playback_manager.seek_frame(1)

    def _prev_frame(self, s):
        if self.playback_manager is None:
            EditorPlaybackManager(self, playing=False, frames_per_second=self.frames_per_second)
        self.playback_manager.seek_frame(-1)

    def _add_keypoint(self, s):
        self.keypoints.insert(
            self.keypoint_index,
            {'state': s.viewer_state,
             'transition_duration': self.transition_duration})
        self.keypoint_index += 1
        self.is_dirty = False
        self.save()
        self._update_status()

    def _toggle_play(self, s):
        if self.playback_manager is not None:
            self.playback_manager.pause()
        else:
            EditorPlaybackManager(self, playing=True)

    def _stop_playback(self):
        self.playback_manager = None

    def _set_transition_duration(self, value):
        self._stop_playback()
        self.transition_duration = value
        if self.keypoint_index > 0:
            self.keypoints[self.keypoint_index - 1]['transition_duration'] = value
        self.save()
        self._update_status()

    def save(self):
        save_script(self.script_path, self.keypoints)

    def _increase_duration(self, s):
        self._set_transition_duration(self.transition_duration + 0.1)

    def _decrease_duration(self, s):
        self._set_transition_duration(self.transition_duration - 0.1)

    def _get_is_dirty(self):
        if self.keypoint_index == 0:
            return True
        state = self.keypoints[self.keypoint_index - 1]['state']
        return state.to_json() != self.viewer.state.to_json()

    def _viewer_state_changed(self):
        if self.playback_manager is not None:
            return
        is_dirty = self._get_is_dirty()
        if is_dirty != self.is_dirty:
            self.is_dirty = is_dirty
            self._update_status()

    def _delete_keypoint(self, s):
        self._stop_playback()
        if self.keypoint_index > 0:
            del self.keypoints[self.keypoint_index - 1]
            self.save()
            self.keypoint_index = self.keypoint_index - 1
            self.is_dirty = self._get_is_dirty()
            self._update_status()

    def _set_keypoint_index(self, index):
        index = max(0, min(index, len(self.keypoints)))
        self.keypoint_index = index
        state_index = max(0, index - 1)
        if len(self.keypoints) > 0:
            self.viewer.set_state(self.keypoints[state_index]['state'])
            self.transition_duration = self.keypoints[state_index]['transition_duration']
            self.is_dirty = False
        else:
            self.is_dirty = True
        self._update_status()

    def _prev_keypoint(self, s):
        self._stop_playback()
        if self.is_dirty:
            self._set_keypoint_index(self.keypoint_index)
        else:
            self._set_keypoint_index(self.keypoint_index - 1)

    def _next_keypoint(self, s):
        self._stop_playback()
        self._set_keypoint_index(self.keypoint_index + 1)

    def _first_keypoint(self, s):
        self._stop_playback()
        self._set_keypoint_index(0)

    def _last_keypoint(self, s):
        self._stop_playback()
        self._set_keypoint_index(len(self.keypoints))

    def _update_status(self):
        if self.playback_manager is not None:
            dirty_message = self.playback_manager.playback_status
        elif self.is_dirty:
            dirty_message = ' [ CHANGED ]'
        else:
            dirty_message = ''

        status = '[ Keypoint %d/%d ]%s [ transition duration %g s ]  %s' % (
            self.keypoint_index,
            len(self.keypoints),
            dirty_message,
            self.transition_duration,
            self._keybinding_message, )
        with self.viewer.config_state.txn() as s:
            s.status_messages['status'] = status

    def _quit(self, s):
        self.quit_event.set()


def run_edit(args):
    editor = ScriptEditor(script_path=args.script, transition_duration=args.duration, fullscreen_width=args.width, fullscreen_height=args.height, frames_per_second=args.fps)
    print(editor.viewer)
    if args.browser:
        webbrowser.open_new(editor.viewer.get_viewer_url())
    editor.quit_event.wait()


def run_render(args):
    keypoints = load_script(args.script)
    for keypoint in keypoints:
        keypoint['state'].gpu_memory_limit = args.gpu_memory_limit
        keypoint['state'].system_memory_limit = args.system_memory_limit
        keypoint['state'].concurrent_downloads = args.concurrent_downloads
    viewers = [neuroglancer.Viewer() for _ in range(args.shards)]
    for viewer in viewers:
        with viewer.config_state.txn() as s:
            s.show_ui_controls = False
            s.show_panel_borders = False
            s.viewer_size = [args.width, args.height]

        print('Open the specified URL to begin rendering')
        print(viewer)
        if args.browser:
            webbrowser.open_new(viewer.get_viewer_url())
    lock = threading.Lock()
    num_frames_written = [0]
    fps = args.fps
    total_frames = sum(max(1, k['transition_duration'] * fps) for k in keypoints[:-1])

    def render_func(viewer, start_frame, end_frame):
        with lock:
            saver = neuroglancer.ScreenshotSaver(viewer, args.output_directory)
        for i in range(len(keypoints) - 1):
            a = keypoints[i]['state']
            b = keypoints[i + 1]['state']
            duration = keypoints[i]['transition_duration']
            num_frames = max(1, int(duration * fps))
            for frame_i in range(num_frames):
                t = frame_i / num_frames
                index, path = saver.get_next_path()
                if index >= end_frame:
                    return

                if index < start_frame:
                    saver.index += 1
                    continue

                if args.resume and os.path.exists(path):
                    saver.index += 1
                    with lock:
                        num_frames_written[0] += 1
                else:
                    cur_state = neuroglancer.ViewerState.interpolate(a, b, t)
                    viewer.set_state(cur_state)
                    index, path = saver.capture()
                    with lock:
                        num_frames_written[0] += 1
                        cur_num_frames_written = num_frames_written[0]
                        print('[%07d/%07d] keypoint %.3f/%5d: %s' %
                              (cur_num_frames_written, total_frames, i + t, len(keypoints), path))

    shard_frames = []
    frames_per_shard = int(math.ceil(total_frames / args.shards))
    for shard in range(args.shards):
        start_frame = frames_per_shard * shard
        end_frame = min(total_frames, start_frame + frames_per_shard)
        shard_frames.append((start_frame, end_frame))
    render_threads = [
        threading.Thread(target=render_func, args=(viewer, start_frame, end_frame))
        for viewer,
        (start_frame, end_frame) in zip(viewers, shard_frames)
    ]
    for t in render_threads:
        t.start()
    for t in render_threads:
        t.join()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument(
        '-a',
        '--bind-address',
        help='Bind address for Python web server.  Use 127.0.0.1 (the default) to restrict access '
        'to browers running on the local machine, use 0.0.0.0 to permit access from remote browsers.'
    )
    ap.add_argument(
        '--static-content-url', help='Obtain the Neuroglancer client code from the specified URL.')
    sub_aps = ap.add_subparsers(help='command to run')
    ap_edit = sub_aps.add_parser('edit', help='Create or edit a script.')
    ap_edit.set_defaults(func=run_edit)
    ap_render = sub_aps.add_parser('render', help='Render a script.')
    ap_render.set_defaults(func=run_render)
    for ap_sub in [ap_edit, ap_render]:
        ap_sub.add_argument('script', help='Path to script file to read and write.')

    ap_edit.add_argument(
        '-d', '--duration', type=float, help='Default transition duration in seconds.', default=1)
    ap_edit.add_argument('--browser', action='store_true', help='Open web browser automatically.')
    ap_edit.add_argument('--width', type=int, help='Frame width', default=1920)
    ap_edit.add_argument('--height', type=int, help='Frame height', default=1080)
    ap_edit.add_argument('-f', '--fps', type=float, help='Frames per second.', default=5)

    ap_render.add_argument(
        'output_directory', help='Directory in which to write screenshot frames.')
    ap_render.add_argument('-f', '--fps', type=float, help='Frames per second.', default=24)
    ap_render.add_argument('--width', type=int, help='Frame width', default=1920)
    ap_render.add_argument('--height', type=int, help='Frame height', default=1080)
    ap_render.add_argument('--browser', action='store_true', help='Open web browser automatically.')
    ap_render.add_argument('--resume', action='store_true', help='Skip already rendered frames.')
    ap_render.add_argument(
        '--shards', type=int, default=1, help='Number of browsers to use concurrently.')
    ap_render.add_argument(
        '--system-memory-limit', type=int, default=3000000000, help='System memory limit')
    ap_render.add_argument(
        '--gpu-memory-limit', type=int, default=3000000000, help='GPU memory limit')
    ap_render.add_argument(
        '--concurrent-downloads', type=int, default=32, help='Concurrent downloads')

    args = ap.parse_args()
    if args.bind_address:
        neuroglancer.set_server_bind_address(args.bind_address)
    if args.static_content_url:
        neuroglancer.set_static_content_source(url=args.static_content_url)
    args.func(args)
