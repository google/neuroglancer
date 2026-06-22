import argparse

import neuroglancer
import neuroglancer.cli
import neuroglancer.random_token

if __name__ == "__main__":
    cube_size_meters = 10e-6

    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()

    def add_cube(s):
        with viewer.txn() as state:
            scale = state.dimensions.scales
            center_point = s.mouse_voxel_coordinates * scale / 1e-9
            layer = state.layers["annotations"]
            layer.annotations.append(
                neuroglancer.AxisAlignedBoundingBoxAnnotation(
                    id=neuroglancer.random_token.make_random_token(),
                    point_a=center_point - cube_size_meters * 1e9,
                    point_b=center_point + cube_size_meters * 1e9,
                )
            )

    viewer.actions.add("add-cube", add_cube)
    with viewer.config_state.txn() as cs:
        cs.input_event_bindings.viewer["keyt"] = "add-cube"

    with viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y", "z"],
            units="nm",
            scales=[8, 8, 8],
        )
        s.layers.append(
            name="image",
            layer=neuroglancer.ImageLayer(
                source="precomputed://gs://neuroglancer-public-data/flyem_fib-25/image",
            ),
        )
        s.layers.append(
            name="annotations",
            layer=neuroglancer.LocalAnnotationLayer(
                dimensions=neuroglancer.CoordinateSpace(
                    names=["x", "y", "z"],
                    units="nm",
                    scales=[1, 1, 1],
                ),
            ),
        )
    print(viewer)
