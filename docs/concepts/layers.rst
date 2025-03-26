.. _layer:

Layer
=====

.. _layer-data-source:

Layer data source
-----------------

TODO

Layer kinds
-----------

.. _image-layer:

Image layer
^^^^^^^^^^^

Image layers display generic volumetric data in a user-configurable way.

.. _image-layer-shader:

Image layer shader
~~~~~~~~~~~~~~~~~~

TODO

.. _segmentation-layer:

Segmentation layer
^^^^^^^^^^^^^^^^^^

Segmentation layers display *segmentations* where each object/class, each
identified by a integer label, is (typically) shown with a distinct color.

Several kinds of data sources are supported:

- multi-resolution volumes, which maps spatial locations to the corresponding
  object label;
- object surface meshes, which map each object label to a corresponding to mesh;
- object skeleton representations, which map each object label to a
  corresponding skeleton representation.
