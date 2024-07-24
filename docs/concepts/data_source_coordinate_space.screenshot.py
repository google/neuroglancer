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

# rec.highlight_element_with_outline(
#     elements=(
#         rec.webdriver.driver.find_elements(
#             By.CSS_SELECTOR, '.neuroglancer-coordinate-space-transform-source-label') +
#         rec.webdriver.driver.find_elements(
#             By.CSS_SELECTOR, '.neuroglancer-coordinate-space-transform-input-scale-container')),
#     caption='Data source coordinate space',
#     direction='left',
# )

# rec.highlight_element_with_outline(
#     elements=(rec.webdriver.driver.find_elements(By.CSS_SELECTOR,
#                                                  '.neuroglancer-coordinate-space-transform-coeff') +
#               rec.webdriver.driver.find_elements(
#                   By.CSS_SELECTOR, '.neuroglancer-coordinate-space-transform-output-label')),
#     caption='Coordinate transform',
#     direction='left')


rec.add_label(
    elements=(
        rec.webdriver.driver.find_elements(
            By.CSS_SELECTOR, ".neuroglancer-coordinate-space-transform-source-label"
        )
        + rec.webdriver.driver.find_elements(
            By.CSS_SELECTOR,
            ".neuroglancer-coordinate-space-transform-input-scale-container",
        )
    ),
    caption="Data source coordinate space",
)

rec.add_label(
    elements=(
        rec.webdriver.driver.find_elements(
            By.CSS_SELECTOR, ".neuroglancer-coordinate-space-transform-coeff"
        )
        + rec.webdriver.driver.find_elements(
            By.CSS_SELECTOR, ".neuroglancer-coordinate-space-transform-output-label"
        )
    ),
    caption="Coordinate transform",
)
