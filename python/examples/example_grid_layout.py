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
        s.layers['ground_truth'] = neuroglancer.SegmentationLayer(
            source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth',
        )
        s.layout = neuroglancer.row_layout([
            neuroglancer.column_layout([
                neuroglancer.LayerGroupViewer(layers=['image', 'ground_truth']),
                neuroglancer.LayerGroupViewer(layers=['image', 'ground_truth']),
            ]),
            neuroglancer.column_layout([
                neuroglancer.LayerGroupViewer(layers=['ground_truth']),
                neuroglancer.LayerGroupViewer(layers=['ground_truth']),
            ]),
        ])
    print(viewer.state)
    print(viewer)
    webbrowser.open_new(viewer.get_viewer_url())
