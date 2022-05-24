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
    with viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(names=["x", "y"], units="nm", scales=[1, 1])
        s.position = [150, 150]
        s.layers.append(
            name="a",
            layer=neuroglancer.LocalAnnotationLayer(
                dimensions=s.dimensions,
                annotation_properties=[
                    neuroglancer.AnnotationPropertySpec(
                        id='color',
                        type='rgb',
                        default='red',
                    ),
                    neuroglancer.AnnotationPropertySpec(
                        id='size',
                        type='float32',
                        default=10,
                    ),
                    neuroglancer.AnnotationPropertySpec(
                        id='p_int8',
                        type='int8',
                        default=10,
                    ),
                    neuroglancer.AnnotationPropertySpec(
                        id='p_uint8',
                        type='uint8',
                        default=10,
                    ),
                ],
                annotations=[
                    neuroglancer.PointAnnotation(
                        id='1',
                        point=[150, 150],
                        props=['#0f0', 5, 6, 7],
                    ),
                    neuroglancer.PointAnnotation(
                        id='2',
                        point=[250, 100],
                        props=['#ff0', 30, 7, 9],
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
    print('Use `Control+right click` to display annotation details.')
    print(viewer)
