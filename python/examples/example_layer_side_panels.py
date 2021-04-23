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
            panels=[
                neuroglancer.LayerSidePanelState(
                    side='left',
                    col = 0,
                    row = 0,
                    tab='render',
                    tabs=['source', 'rendering'],
                ),
                neuroglancer.LayerSidePanelState(
                    side='left',
                    col = 0,
                    row=1,
                    tab='render',
                    tabs=['annotations'],
                ),
            ],
        )
        s.layers['ground_truth'] = neuroglancer.SegmentationLayer(
            source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth',
        )
    print(viewer.state)
    print(viewer)
    webbrowser.open_new(viewer.get_viewer_url())
