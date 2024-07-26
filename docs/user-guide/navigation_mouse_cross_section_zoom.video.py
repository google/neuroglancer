rec.begin(
    {
        "dimensions": {"x": [8e-9, "m"], "y": [8e-9, "m"], "z": [8e-9, "m"]},
        "position": [3242.833251953125, 3334.499755859375, 4045.5],
        "crossSectionScale": 1,
        "projectionOrientation": [
            0.23160003125667572,
            0.20444951951503754,
            -0.017615893855690956,
            0.9509214162826538,
        ],
        "projectionScale": 512,
        "layers": [
            {
                "type": "image",
                "source": "precomputed://gs://neuroglancer-public-data/flyem_fib-25/image",
                "tab": "source",
                "name": "image",
            }
        ],
        "selectedLayer": {"layer": "image"},
        "layout": "4panel",
    }
)
panel = rec.get_data_panels()[0]
rec.move_to_element_smoothly(panel, 0.8, 0.7)
time.sleep(0.5)
with rec.keys_held("leftctrl"):
    rec.mouse_wheel_smoothly(-0.3)
    rec.mouse_wheel_smoothly(0.3)
