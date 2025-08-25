import argparse
import atexit
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
    # Id and type are required for each property. Everything else is optional.
    properties = [
        neuroglancer.AnnotationPropertySpec(
            id="point_color",
            description="Color of the annotation",
            type="rgb",
            default="#ffff00",
        ),
        neuroglancer.AnnotationPropertySpec(
            id="size",
            description="Size of the annotation",
            type="float32",
            default=14.0,
        ),
        neuroglancer.AnnotationPropertySpec(
            id="p_int8",
            type="int8",
            default=10,
        ),
        neuroglancer.AnnotationPropertySpec(
            id="p_uint8",
            type="uint8",
        ),
        neuroglancer.AnnotationPropertySpec(
            id="rgba_color",
            type="rgba",
            default="#00ff00ff",  # default value colors MUST be hex strings
        ),
        neuroglancer.AnnotationPropertySpec(
            id="p_enum1",
            type="uint16",
            default=0,
            enum_values=[0, 1, 2, 3],
            enum_labels=[
                "Option 0",
                "Option 1",
                "Option 2",
                "Option 3",
            ],
        ),
        neuroglancer.AnnotationPropertySpec(
            id="p_fnum32",
            type="float32",
            default=0.0,
            description="A float number property",
            enum_values=[0.0, 1.5, 2.6, 3.0],
            enum_labels=[
                "Zero",
                "One and a half",
                "Two point six",
                "Three",
            ],
        ),
        neuroglancer.AnnotationPropertySpec(
            id="p_boola",
            type="uint16",
            default=1,
            description="A boolean property",
            enum_values=[0, 1],
            enum_labels=["False", "True"],
        ),
    ]

    writer = neuroglancer.write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space,
        annotation_type="point",
        properties=properties,
    )

    # Colors during writing can be int tuples or hex strings.
    # You can specify as many properties as you like, but the
    # properties must be defined in the AnnotationPropertySpec above.
    # Any property not specified will use the default value defined
    # in the AnnotationPropertySpec.
    writer.add_point(
        [20, 30, 40],
        point_color=(0, 255, 0),
        size=10,
        p_int8=1,
        p_uint8=2,
        rgba_color=(0, 255, 0, 255),
        p_enum1=1,
        p_fnum32=1.5,
    )
    writer.add_point(
        [50, 51, 52],
        point_color=(255, 0, 0),
        size=9.5,
        p_int8=2,
        p_uint8=3,
        rgba_color="#ff0000ff",
        p_enum1=2,
        p_fnum32=2.6,
    )
    writer.add_point(
        [40, 50, 20],
        point_color="#0000ff",
        size=20,
        p_int8=3,
        p_uint8=4,
        rgba_color=(0, 200, 255, 14),
        p_enum1=3,
        p_fnum32=3.0,
        p_boola=0,
    )
    writer.add_point([40, 20, 24])
    writer.write(output_dir)


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
        s.layers["annotations"] = neuroglancer.AnnotationLayer(
            source=f"precomputed://{server.url}",
            tab="rendering",
            shader="""
void main() {
  setColor(prop_point_color());
  setPointMarkerSize(prop_size());
}
        """,
        )
        s.selected_layer.layer = "annotations"
        s.selected_layer.visible = True
        s.show_slices = False
    print(viewer)
