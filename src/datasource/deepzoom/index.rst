.. _deepzoom-datasource:

Deep Zoom
=========

The Deep Zoom :ref:`data format driver<data-formats>` supports the Deep Zoom XML
format.

URL syntax
----------

- :file:`{KVSTORE-URL.dzi}|deepzoom:`

Examples
--------

- `https://data-proxy.ebrains.eu/api/v1/buckets/localizoom/14122_mPPC_BDA_s186.tif/14122_mPPC_BDA_s186.dzi|deepzoom: <https://neuroglancer-demo.appspot.com/#!%7B%22dimensions%22:%7B%22x%22:%5B1e-9%2C%22m%22%5D%2C%22y%22:%5B1e-9%2C%22m%22%5D%7D%2C%22position%22:%5B10387071%2C5347131%5D%2C%22crossSectionScale%22:263.74955563693914%2C%22projectionScale%22:65536%2C%22layers%22:%5B%7B%22type%22:%22image%22%2C%22source%22:%7B%22url%22:%22deepzoom://https://data-proxy.ebrains.eu/api/v1/buckets/localizoom/14122_mPPC_BDA_s186.tif/14122_mPPC_BDA_s186.dzi%22%2C%22transform%22:%7B%22outputDimensions%22:%7B%22x%22:%5B1e-9%2C%22m%22%5D%2C%22y%22:%5B1e-9%2C%22m%22%5D%2C%22c%5E%22:%5B1%2C%22%22%5D%7D%2C%22inputDimensions%22:%7B%22x%22:%5B3.25e-7%2C%22m%22%5D%2C%22y%22:%5B3.25e-7%2C%22m%22%5D%2C%22c%5E%22:%5B1%2C%22%22%5D%7D%7D%7D%2C%22tab%22:%22rendering%22%2C%22shader%22:%22void%20main%28%29%7BemitRGB%28vec3%28toNormalized%28getDataValue%280%29%29%2CtoNormalized%28getDataValue%281%29%29%2CtoNormalized%28getDataValue%282%29%29%29%29%3B%7D%22%2C%22channelDimensions%22:%7B%22c%5E%22:%5B1%2C%22%22%5D%7D%2C%22name%22:%2214122_mPPC_BDA_s186.dzi%22%7D%5D%2C%22selectedLayer%22:%7B%22layer%22:%2214122_mPPC_BDA_s186.dzi%22%7D%2C%22layout%22:%22xy%22%7D>`__

  `Olsen, G. M., Hovde, K., Sakshaug, T., Sømme H., H., Monterotti, B., Laja, A., Reiten, I., Leergaard, T. B., & Witter, M. P. (2020). Anterogradely labeled axonal projections from the posterior parietal cortex in rat [Data set]. EBRAINS. <https://doi.org/10.25493/FKM4-ZCC>`__

  Coronal section of rat brain at 325 nanometer resolution.

Auto detection
--------------

Deep Zoom files are detected automatically based on the signature at the start
of the file.
