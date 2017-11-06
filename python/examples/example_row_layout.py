from __future__ import print_function

import webbrowser

import neuroglancer

viewer = neuroglancer.Viewer()

with viewer.txn() as s:
    s.layers['image'] = neuroglancer.ImageLayer(
        source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/image',
    )
    s.layers['ground_truth'] = neuroglancer.SegmentationLayer(
        source='precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth',
    )
    s.layout = neuroglancer.row_layout([
        neuroglancer.LayerGroupViewer(layers=['image', 'ground_truth']),
        neuroglancer.LayerGroupViewer(layers=['ground_truth']),
    ])
print(viewer.state)
print(viewer)
webbrowser.open_new(viewer.get_viewer_url())
