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
import os
import threading
import time
import webbrowser

import neuroglancer

class PlaybackManager(object):
    def __init__(self, script_editor):
        self.script_editor = script_editor
        script_editor.playback_manager = self
        self.start_time = time.time()
        self.current_keypoint_index = max(1, script_editor.keypoint_index)
        self.cumulative_time = 0
        t = threading.Thread(target=self._thread_func)
        t.daemon = True
        t.start()
        self.should_stop = threading.Event()
        self._update()

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
        elapsed_time = time.time() - self.start_time
        # Advance keypoint index
        while True:
            if self.current_keypoint_index >= len(self.script_editor.keypoints):
                self.script_editor.playback_manager = None
                self.script_editor._update_status()
                self.should_stop.set()
                return
            current_duration = self.script_editor.keypoints[self.current_keypoint_index - 1][
                'transition_duration']
            if elapsed_time >= self.cumulative_time + current_duration:
                self.current_keypoint_index += 1
                self.cumulative_time += current_duration
                self.script_editor._set_keypoint_index(self.current_keypoint_index)
            else:
                break
        transition_time = elapsed_time - self.cumulative_time
        new_state = neuroglancer.ViewerState.interpolate(
            self.script_editor.keypoints[self.current_keypoint_index - 1]['state'],
            self.script_editor.keypoints[self.current_keypoint_index]['state'],
            transition_time / current_duration)
        self.playback_status = 'PLAYING %.1f/%g' % (transition_time, current_duration)
        self.script_editor.viewer.set_state(new_state)
        self.script_editor._update_status()


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


class ScriptEditor(object):
    def __init__(self, script_path, transition_duration):
        self.script_path = script_path
        self.viewer = neuroglancer.Viewer()
        self.keypoint_index = 0
        if os.path.exists(script_path):
            self.keypoints = load_script(script_path, transition_duration)
        else:
            self.keypoints = []

        self.transition_duration = transition_duration
        self.viewer.shared_state.add_changed_callback(self._viewer_state_changed)
        self.quit_event = threading.Event()
        self.is_dirty = True
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
        ]
        with self.viewer.config_state.txn() as s:
            for k, a in keybindings:
                s.input_event_bindings.viewer[k] = a
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
        self.playback_manager = None
        self._set_keypoint_index(len(self.keypoints))

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
            self.playback_manager = None
        else:
            PlaybackManager(self)

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
        temp_path = self.script_path + '.tmp'
        with open(temp_path, 'w') as f:
            for x in self.keypoints:
                f.write(neuroglancer.to_url(x['state']) + '\n')
                f.write(str(x['transition_duration']) + '\n')
        os.rename(temp_path, self.script_path)

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
    editor = ScriptEditor(script_path=args.script, transition_duration=args.duration)
    print(editor.viewer)
    if args.browser:
        webbrowser.open_new(editor.viewer.get_viewer_url())
    editor.quit_event.wait()


def run_render(args):
    keypoints = load_script(args.script)
    viewer = neuroglancer.Viewer()
    print('Open the specified URL to begin rendering')
    print(viewer)
    if args.browser:
        webbrowser.open_new(viewer.get_viewer_url())
    fps = args.fps
    with viewer.config_state.txn() as s:
        s.show_ui_controls = False
        s.show_panel_borders = False
        s.viewer_size = [args.width, args.height]
    saver = neuroglancer.ScreenshotSaver(viewer, args.output_directory)
    total_frames = sum(max(1, k['transition_duration'] * fps) for k in keypoints[:-1])
    for i in range(len(keypoints) - 1):
        a = keypoints[i]['state']
        b = keypoints[i + 1]['state']
        duration = keypoints[i]['transition_duration']
        num_frames = max(1, int(duration * fps))
        for frame_i in range(num_frames):
            t = frame_i / num_frames
            cur_state = neuroglancer.ViewerState.interpolate(a, b, t)
            viewer.set_state(cur_state)
            index, path = saver.capture()
            print('[%07d/%07d] keypoint %.3f/%5d: %s' % (index, total_frames, i + t, len(keypoints), path))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument(
        '-a',
        '--bind-address',
        help='Bind address for Python web server.  Use 127.0.0.1 (the default) to restrict access '
        'to browers running on the local machine, use 0.0.0.0 to permit access from remote browsers.'
    )
    ap.add_argument(
        '--static-content-url',
        help='Obtain the Neuroglancer client code from the specified URL.')
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

    ap_render.add_argument(
        'output_directory', help='Directory in which to write screenshot frames.')
    ap_render.add_argument('-f', '--fps', type=float, help='Frames per second.', default=24)
    ap_render.add_argument('--width', type=int, help='Frame width', default=1920)
    ap_render.add_argument('--height', type=int, help='Frame height', default=1080)
    ap_render.add_argument('--browser', action='store_true', help='Open web browser automatically.')

    args = ap.parse_args()
    if args.bind_address:
        neuroglancer.set_server_bind_address(args.bind_address)
    if args.static_content_url:
        neuroglancer.set_static_content_source(url=args.static_content_url)
    args.func(args)
