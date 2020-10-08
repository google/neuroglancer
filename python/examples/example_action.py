from __future__ import print_function

import argparse
import webbrowser

import neuroglancer
import neuroglancer.cli

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)

    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        s.layers['image'] = neuroglancer.ImageLayer(
            source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/image',
        )

    def my_action(s):
        print('Got my-action')
        print('  Mouse position: %s' % (s.mouse_voxel_coordinates, ))
        print('  Layer selected values: %s' % (s.selected_values, ))

    viewer.actions.add('my-action', my_action)
    with viewer.config_state.txn() as s:
        s.input_event_bindings.viewer['keyt'] = 'my-action'
        s.status_messages['hello'] = 'Welcome to this example'

    print(viewer)
    webbrowser.open_new(viewer.get_viewer_url())
