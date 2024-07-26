from selenium.webdriver.common.by import By

rec.begin(
    {
        "layers": [
            {
                "type": "image",
                "source": "precomputed://gs://neuroglancer-public-data/flyem_fib-25/image",
                "tab": "source",
                "name": "image",
            }
        ],
        "selectedLayer": {"layer": "image", "visible": True},
    }
)


rec.add_labels(
    [
        (
            rec.webdriver.driver.find_elements(
                By.CSS_SELECTOR,
                ".neuroglancer-coordinate-space-transform-input-scale-container",
            ),
            "top",
            "Source dimension units",
        ),
        (
            rec.webdriver.driver.find_elements(
                By.CSS_SELECTOR, ".neuroglancer-coordinate-space-transform-coeff"
            ),
            "bottom",
            "Affine transform matrix",
        ),
        (
            rec.webdriver.driver.find_elements(
                By.CSS_SELECTOR, ".neuroglancer-coordinate-space-transform-output-label"
            ),
            "left",
            "Output dimension labels",
        ),
        (
            rec.webdriver.driver.find_elements(
                By.CSS_SELECTOR,
                ".neuroglancer-coordinate-space-transform-output-scale-container",
            ),
            "bottom",
            "Output dimension units",
        ),
        (
            rec.webdriver.driver.find_elements(
                By.CSS_SELECTOR,
                ".neuroglancer-coordinate-space-transform-output-extend",
            ),
            "left",
            "Extend output space",
        ),
    ]
)
