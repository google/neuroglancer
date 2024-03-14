import neuroglancer
import numpy as np


def test_max_projection(webdriver):
    def create_volume():
        shape = (10, 40, 50)

        # Create the volume
        volume = np.zeros(shape)

        # Fill each row across the last dimension with 90 random data points and 10 data points that are 1s
        rng = np.random.default_rng()
        for i in range(shape[0]):
            for j in range(shape[1]):
                random_indices = rng.choice(shape[2], size=40, replace=False)
                volume[i, j, random_indices] = rng.random(40)
                volume[i, j, ~np.isin(np.arange(shape[2]), random_indices)] = 1
        return volume

    def get_shader():
        return """
#uicontrol invlerp normalized(range=[0,1])
void main() {
    emitGrayscale(normalized());
}
"""

    with webdriver.viewer.txn() as s:
        s.dimensions = neuroglancer.CoordinateSpace(
            names=["x", "y", "z"], units="nm", scales=[1, 1, 1]
        )
        s.layers["image"] = neuroglancer.ImageLayer(
            source=neuroglancer.LocalVolume(create_volume(), dimensions=s.dimensions),
            volume_rendering_mode="MAX",
            shader=get_shader(),
        )
        # s.layout = "3d"
        s.show_axis_lines = False

    assert webdriver.viewer.state.layers["image"].volume_rendering_mode == "MAX"
    webdriver.sync()
    screenshot = webdriver.viewer.screenshot(size=[100, 100]).screenshot
    np.testing.assert_array_equal(
        screenshot.image_pixels,
        np.tile(np.array([255, 255, 255, 255], dtype=np.uint8), (100, 100, 1)),
    )
