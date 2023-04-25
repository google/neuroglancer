"""Converts a Neuroglancer state to display a cross-section cube."""

import argparse

import neuroglancer
import neuroglancer.coordinate_space
import neuroglancer.cli

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument("--cube-size",
                    type=neuroglancer.coordinate_space.parse_unit,
                    default=(4e-6, "m"))
    neuroglancer.cli.add_server_arguments(ap)
    neuroglancer.cli.add_state_arguments(ap, required=True)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)

    state = args.state

    cube_size = args.cube_size[0]

    canonical_scale = min(d.scale for d in state.dimensions)

    state.show_axis_lines = False
    state.show_slices = False
    state.show_default_annotations = False
    state.projection_scale = 2 * cube_size / canonical_scale

    #  x+y+:  [0, 0, 0, 1]
    # z-y+:    [ 0,0.7071067690849304,0,0.7071067690849304]
    # z+y+:    [ 0,-0.7071067690849304,0,0.7071067690849304]
    # z+x-:   [0.5, -0.5, 0.5, 0.5]
    # z+x+:   [0.5, 0.5, 0.5, -0.5]
    # x+z-:   [ -0.7071067690849304,0, 0, 0.7071067690849304]

    orientations = [
        [0, 0.7071067690849304, 0, 0.7071067690849304],  # z-y+
        [0.5, 0.5, 0.5, -0.5],  # z+x+
        [0, 0, 0, 1],  # x+y+
    ]


    # Add 6 cube faces
    for face_dim in range(3):
        for face_dir in range(2):
            state.layout.type = '3d'
            position = list(state.position)
            position[face_dim] += ((face_dir * 2 - 1) * cube_size / 2 /
                                   state.dimensions[face_dim].scale)
            state.layout.cross_sections['%d_%d' % (face_dim, face_dir)] = neuroglancer.CrossSection(
                width=cube_size / canonical_scale,
                height=cube_size / canonical_scale,
                position=neuroglancer.LinkedPosition(link='relative', value=position),
                orientation=neuroglancer.LinkedOrientationState(
                    link='unlinked',
                    value=orientations[face_dim],
                ),
                scale=neuroglancer.LinkedZoomFactor(link='unlinked', value=1),
            )

    print(neuroglancer.to_url(state))
