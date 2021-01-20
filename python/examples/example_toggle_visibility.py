from __future__ import print_function

import argparse
import neuroglancer
import neuroglancer.cli

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()
    def toggle_visibility(s):
        with viewer.txn() as s:
            if s.layers['a'].visible == True:
                s.layers['a'].visible = False
                print('Setting visibility to false')
            else:
                s.layers['a'].visible = True
                print('Setting visibility to true')

    viewer.actions.add('toggle-visibility', toggle_visibility)
    with viewer.config_state.txn() as s:
        s.input_event_bindings.viewer['keys'] = 'toggle-visibility'

    with viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y"], units="nm", scales=[1, 1])
        s.position = [150, 150]
        s.layers.append(
            name="a",
            layer=neuroglancer.LocalAnnotationLayer(
                dimensions=s.dimensions,
                annotations=[
                    neuroglancer.PointAnnotation(
                        id='1',
                        point=[150, 150],
                    ),
                ],
                shader='''
void main() {
  setColor(prop_color());
  setPointMarkerSize(prop_size());
}
''',
            ),
        )
        s.layout = 'xy'
        s.selected_layer.layer = 'a'
    print(viewer)
