import argparse
import atexit
import os
import shutil
import tempfile

import neuroglancer
import neuroglancer.cli
import neuroglancer.static_file_server
import neuroglancer.write_annotations
import numpy as np


def write_some_annotations(
    output_dir: str, coordinate_space: neuroglancer.CoordinateSpace
):
    writer = neuroglancer.write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space,
        annotation_type="point",
        properties=[
            neuroglancer.AnnotationPropertySpec(id="size", type="float32"),
            neuroglancer.AnnotationPropertySpec(id="cell_type", type="uint16"),
            neuroglancer.AnnotationPropertySpec(id="point_color", type="rgba"),
        ],
    )

    writer.add_point([20, 30, 40], size=10, cell_type=16, point_color=(0, 255, 0, 255))
    writer.add_point([50, 51, 52], size=30, cell_type=16, point_color=(255, 0, 0, 255))
    writer.write(os.path.join(output_dir, "point"))

    writer = neuroglancer.write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space,
        annotation_type="polyline",
        properties=[
            neuroglancer.AnnotationPropertySpec(id="size", type="float32"),
            neuroglancer.AnnotationPropertySpec(id="cell_type", type="uint16"),
            neuroglancer.AnnotationPropertySpec(id="point_color", type="rgba"),
        ],
    )
    writer.add_polyline(
        [[25, 10, 20], [10, 15, 20]],
        size=10,
        cell_type=16,
        point_color=(0, 255, 0, 255),
    )
    writer.add_polyline(
        [[5, 17, 29], [10, 15, 30], [40, 20, 25]],
        size=30,
        cell_type=16,
        point_color=(255, 0, 0, 255),
    )
    writer.write(os.path.join(output_dir, "polyline"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()

    tempdir = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, tempdir)

    coordinate_space = neuroglancer.CoordinateSpace(
        names=["x", "y", "z"], units=["nm", "nm", "nm"], scales=[10, 10, 10]
    )
    write_some_annotations(output_dir=tempdir, coordinate_space=coordinate_space)

    server = neuroglancer.static_file_server.StaticFileServer(
        static_dir=tempdir, bind_address=args.bind_address or "127.0.0.1", daemon=True
    )

    with viewer.txn() as s:
        s.layers["image"] = neuroglancer.ImageLayer(
            source=neuroglancer.LocalVolume(
                data=np.full(fill_value=200, shape=(100, 100, 100), dtype=np.uint8),
                dimensions=coordinate_space,
            ),
        )
        s.layers["points"] = neuroglancer.AnnotationLayer(
            source=f"precomputed://{server.url}/point",
            tab="rendering",
            shader="""
void main() {
  setColor(prop_point_color());
  setPointMarkerSize(prop_size());
}
        """,
        )
        s.layers["polylines"] = neuroglancer.AnnotationLayer(
            source=f"precomputed://{server.url}/polyline",
            tab="rendering",
            shader="""
void main() {
setColor(prop_point_color());
setLineWidth(prop_size());
}
        """,
        )
        s.selected_layer.layer = "points"
        s.selected_layer.visible = True
        s.show_slices = False
    print(viewer)
