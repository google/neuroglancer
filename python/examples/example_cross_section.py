from __future__ import print_function, division

import argparse
import copy
import numpy as np
import time

import neuroglancer
import neuroglancer.cli

from example import add_example_layers

if __name__ == '__main__':

    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)

    viewer = neuroglancer.Viewer()
    with viewer.txn() as s:
        a, b = add_example_layers(s)
        s.layout.type = '3d'
        s.layout.cross_sections['a'] = neuroglancer.CrossSection()


    def interpolate_to(final_state, frames_per_second=5, seconds=1):
        total_frames = int(round(seconds * frames_per_second))
        initial_state = viewer.state
        for frame_i in range(total_frames):
            t = frame_i / total_frames
            viewer.set_state(neuroglancer.ViewerState.interpolate(initial_state, final_state, t))
            time.sleep(1 / frames_per_second)
        viewer.set_state(final_state)



    def move_by(offset, **kwargs):
        final_state = copy.deepcopy(viewer.state)
        final_state.voxel_coordinates += offset
        interpolate_to(final_state, **kwargs)


    def do_move_by():
      move_by([100, 0, 0], seconds=1, frames_per_second=10)


    print(viewer)
