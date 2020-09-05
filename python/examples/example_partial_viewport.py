from __future__ import print_function

import argparse
import numpy as np

import neuroglancer
import neuroglancer.cli

from example import add_example_layers


def _make_viewport_adjust_command(adjustments):
    def handler(s):
        with viewer.txn() as s:
            for i, amount in adjustments:
                s.partial_viewport[i] += amount
            s.partial_viewport[:2] = np.clip(s.partial_viewport[:2], 0, 0.9)
            s.partial_viewport[2:] = np.clip(s.partial_viewport[2:], 0.1,
                                             1 - s.partial_viewport[:2])
            partial_viewport = np.array(s.partial_viewport)

        with viewer.config_state.txn() as s:
            s.viewer_size = [256, 256]
            s.status_messages['note'] = 'Viewport: %r' % (partial_viewport, )

    return handler


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        a, b = add_example_layers(s)

    viewer.actions.add('viewport-translate-left', _make_viewport_adjust_command([(0, -0.1)]))
    viewer.actions.add('viewport-translate-right', _make_viewport_adjust_command([(0, 0.1)]))
    viewer.actions.add('viewport-translate-up', _make_viewport_adjust_command([(1, -0.1)]))
    viewer.actions.add('viewport-translate-down', _make_viewport_adjust_command([(1, 0.1)]))
    viewer.actions.add('viewport-shrink-width', _make_viewport_adjust_command([(2, -0.1)]))
    viewer.actions.add('viewport-enlarge-width', _make_viewport_adjust_command([(2, 0.1)]))
    viewer.actions.add('viewport-shrink-height', _make_viewport_adjust_command([(3, -0.1)]))
    viewer.actions.add('viewport-enlarge-height', _make_viewport_adjust_command([(3, 0.1)]))

    with viewer.config_state.txn() as s:
        s.input_event_bindings.viewer['keyh'] = 'viewport-translate-left'
        s.input_event_bindings.viewer['keyl'] = 'viewport-translate-right'
        s.input_event_bindings.viewer['keyj'] = 'viewport-translate-down'
        s.input_event_bindings.viewer['keyk'] = 'viewport-translate-up'
        s.input_event_bindings.viewer['shift+keyu'] = 'viewport-shrink-height'
        s.input_event_bindings.viewer['shift+keyi'] = 'viewport-enlarge-height'
        s.input_event_bindings.viewer['shift+keyy'] = 'viewport-shrink-width'
        s.input_event_bindings.viewer['shift+keyo'] = 'viewport-enlarge-width'

    print(viewer)
