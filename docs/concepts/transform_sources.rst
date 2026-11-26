.. _transform-sources:

Transform sources
=================

A :ref:`data source<layer-data-source>` is placed in its layer by its
:ref:`coordinate transform<data-source-coordinate-transform>`, an affine
transform edited in the layer's **Source** tab (the ``"transform"`` of the data
source in the JSON state). A *transform source* extends this with a
transformation loaded from a URL, written in the OME-Zarr 0.6 (RFC-5)
transformation format: any sequence of linear transformations, with at most
one displacement field. The affine transform is still edited in the Source
tab and is applied after the transform source.

Displacement fields are applied without copying data. Each volume chunk shown
is computed from the source's chunks as they are needed; meshes, skeletons and
annotations are moved point by point (see :ref:`transform-source-points`). Any
data source type can use a transform source: OME-Zarr, precomputed, N5, NIfTI,
and so on.

This page describes each way of using one. In the diagrams, boxes are
coordinate spaces, labelled with their dimensions, and arrows are
transformations:

- A **bold arrow** is the transform edited in the Source tab.
- A **dashed arrow** is a displacement field.
- A plain arrow is fixed by the data or by the transform source.

.. _transform-source-split:

How a transformation is applied
-------------------------------

A transformation from the source's space to the layer's space is split into

.. math::

   \text{output} = \text{post} \circ W \circ \text{pre}(\text{input})

where:

- ``pre`` is the linear part before the displacement field;
- ``W`` is the field, in the field's own coordinates;
- ``post`` is the linear part after the field.

Without a field, ``pre`` is the identity and ``post`` is the whole
transformation.

The source's affine transform takes the place of ``post``: it **starts as**
``post`` and can be edited from there. So:

- a transform source that ends in linear transformations sets the affine
  transform;
- one that ends in its displacement field leaves the affine transform as the
  identity.

With :ref:`prepend<transform-source-prepend>`, the affine transform is applied
first instead, before ``pre``.

To draw the source, Neuroglancer pulls each output point back through the
transformation, so it needs the field in the output-to-source direction. A
displacement field holds vectors :math:`u` sampled on one side, and
:math:`p \mapsto p + u(p)` maps that side to the other. The transformation must
therefore give the field of the inverse direction, sampled on the output side,
in one of two ways:

- as ``inverseOf`` a ``displacements``;
- as a ``bijection`` whose ``inverse`` holds it.

A ``displacements`` alone, in the forward direction, is refused with a message
saying so.

1. A source without a transform source
--------------------------------------

This is how sources have always been placed. The affine transform starts as
the source's own placement: for example, the voxel size of a precomputed
volume, or the linear transformations of an OME-Zarr image.

.. graphviz::

   digraph {
     rankdir = LR;
     node [shape=box, style=rounded];
     src [label="precomputed segmentation\nx, y, z\n8 × 8 × 40 nm voxels"];
     out [label="layer\nx, y, z (nm)"];
     src -> out [label="transform\n(default: voxel size)", penwidth=2.5];
   }

2. An OME-Zarr image with linear transformations
------------------------------------------------

This is unchanged. The image's transformations from its intrinsic coordinate
system (scale, translation, affine, rotation, mapAxis, sequence, and their
``inverseOf`` or ``bijection``) are all linear. They are combined into the
default affine transform, so they can all be edited.

.. graphviz::

   digraph {
     rankdir = LR;
     node [shape=box, style=rounded];
     arr [label="array s0\nz, y, x (voxels)\n512 × 512 × 512"];
     out [label="&quot;world&quot;\nz, y, x (µm)"];
     arr -> out [label="transform\n(default: dataset scale,\nthen intrinsic → world)", penwidth=2.5];
   }

.. code-block:: json

   {"type": "image", "source": "zarr3://https://host/image.ome.zarr/"}

3. An OME-Zarr image whose transformation has a displacement field
------------------------------------------------------------------

The image's transformation to its output system may combine linear
transformations with one displacement field. Neuroglancer loads both from the
image's own metadata, with no other setting:

- the image is placed in its intrinsic system by its datasets' scales;
- ``pre`` and the field are applied as is;
- the affine transform starts as ``post``.

The Source tab shows the field's URL in the transform row, marked "(from the
source's metadata)".

.. graphviz::

   digraph {
     rankdir = LR;
     node [shape=box, style=rounded];
     arr [label="array 0\nz, y, x (voxels)\n64 × 64 × 64"];
     img [label="&quot;img&quot;\nz, y, x (µm)"];
     fld [label="field coordinates\nz, y, x (µm)\nfield 3 × 16 × 16 × 16, 4 µm"];
     wf  [label="field coordinates\n(warped)"];
     out [label="&quot;world&quot;\nz, y, x (µm)"];
     arr -> img [label="dataset scale"];
     img -> fld [label="pre: translation,\nthen swap y ↔ x"];
     fld -> wf  [label="W", style=dashed];
     wf  -> out [label="transform\n(default post:\nswap, then mirror x)", penwidth=2.5];
   }

The image's ``coordinateTransformations`` (in the multiscale) for this
example:

.. code-block:: json

   {
     "type": "sequence",
     "input": {"name": "img"},
     "output": {"name": "world"},
     "transformations": [
       {"type": "translation", "translation": [1, -2, 1.5]},
       {
         "type": "inverseOf",
         "transformation": {
           "type": "sequence",
           "transformations": [
             {"type": "affine", "affine": [[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0]]},
             {"type": "displacements", "path": "../field.zarr", "interpolation": "linear"},
             {"type": "affine", "affine": [[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0]]}
           ]
         }
       },
       {"type": "affine", "affine": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, 64]]}
     ]
   }

Here:

- ``pre`` is the translation followed by the field's first swap;
- ``W`` is the field;
- ``post`` is the field's second swap followed by the mirror.

Channel axes of the image pass through unchanged. The field's affines may be
given for its space axes alone (3 × 4 here), even when the image has a channel
axis.

4. Pointing another source at an OME-Zarr transformation
--------------------------------------------------------

Any data source can be given a transform source. This is the ``transform`` row
in the Source tab, or ``"transformSource"`` in JSON. For example, a
precomputed segmentation can be aligned by the transformation of an OME-Zarr
image, scene, or JSON file. The URL may name:

- an **OME-Zarr scene**: a group whose ``"ome"`` metadata has ``"scene"``,
  with ``coordinateSystems`` and ``coordinateTransformations``;
- an **OME-Zarr group of transformations**: ``coordinateSystems`` and
  ``coordinateTransformations`` directly in ``"ome"``;
- an **OME-Zarr image** (0.6, with coordinate systems): its transformation
  from its intrinsic system, as in case 3. This aligns a segmentation, or
  other data, the way an image is aligned;
- a **JSON file** (``.json``) holding such metadata: ``{"ome": {...}}``, a
  ``zarr.json``, or the contents of ``"ome"``.

Relative ``displacements`` paths are resolved against the group, or against
the JSON file's directory.

.. graphviz::

   digraph {
     rankdir = LR;
     node [shape=box, style=rounded];
     src [label="precomputed segmentation\nx, y, z\n1 × 1 × 1 µm voxels"];
     inp [label="transformation input\n&quot;img&quot;: z, y, x (µm)", style="rounded,dashed"];
     fld [label="field coordinates\nz, y, x (µm)"];
     wf  [label="field coordinates\n(warped)"];
     out [label="transformation output\n&quot;world&quot;: z, y, x (µm)"];
     src -> inp [label="source placement\n(dimensions matched\nby name: x, y, z)"];
     inp -> fld [label="pre"];
     fld -> wf  [label="W", style=dashed];
     wf  -> out [label="transform\n(default: post)", penwidth=2.5];
   }

.. code-block:: json

   {
     "type": "segmentation",
     "source": {
       "url": "precomputed://https://host/segmentation",
       "transformSource": "zarr3://https://host/image.ome.zarr/"
     }
   }

The transformation's input axes are matched to the source's dimensions by
name. The source's ``x``, ``y`` and ``z`` above are the transformation's
``x``, ``y`` and ``z``, whatever their order. Units are converted: nanometres
of the source become micrometres of the transformation. A channel axis ``c``
matches the dimension ``c'``. If no name matches, the source's length
dimensions are used in order, when there are as many as the transformation
has axes. Dimensions of the source that the transformation lacks pass through
unchanged.

The output dimensions are the transformation's output axes. Their scales are
about one voxel of the source, so positions still count voxels.

When the source is an OME-Zarr image with a transformation of its own (case
3), a transform source replaces that transformation. The image is then in its
intrinsic coordinate system, and the transform source's input axes are matched
to that system.

5. A linear transform source
----------------------------

When the transformation has no field, it is all ``post``: it becomes the
default affine transform, composed with the source's own placement. This sets
a source's transform from a transformation stored elsewhere.

.. graphviz::

   digraph {
     rankdir = LR;
     node [shape=box, style=rounded];
     src [label="precomputed image\nx, y, z\n1 × 1 × 1 µm voxels"];
     out [label="&quot;world&quot;\nz, y, x (µm)"];
     src -> out [label="transform\n(default: source placement,\nthen the transformation)", penwidth=2.5];
   }

.. code-block:: json

   {
     "url": "precomputed://https://host/image",
     "transformSource": "https://host/transforms/mirror_x.json"
   }

where ``mirror_x.json`` holds:

.. code-block:: json

   {
     "ome": {
       "version": "0.6",
       "scene": {
         "coordinateSystems": [
           {"name": "img", "axes": [{"name": "z", "type": "space", "unit": "micrometer"},
                                    {"name": "y", "type": "space", "unit": "micrometer"},
                                    {"name": "x", "type": "space", "unit": "micrometer"}]},
           {"name": "world", "axes": [{"name": "z", "type": "space", "unit": "micrometer"},
                                      {"name": "y", "type": "space", "unit": "micrometer"},
                                      {"name": "x", "type": "space", "unit": "micrometer"}]}
         ],
         "coordinateTransformations": [
           {"type": "affine", "affine": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, 64]],
            "input": {"name": "img"}, "output": {"name": "world"}}
         ]
       }
     }
   }

6. A displacement field alone
-----------------------------

The URL may name a displacement field itself instead of a transformation.
This is either:

- a warpfield OME-Zarr group: a multiscale with an axis of type
  ``"displacement"``;
- any volume Neuroglancer can open that has no RFC-5 transformations, such
  as a NIfTI ITK/ANTs displacement field, a zarr array, or an OME-Zarr
  0.4/0.5 image whose channel axis holds the vectors.

The source keeps its own placement, which must put it in the field's space.
The field is applied there, and the affine transform starts as the identity
on the field's space.

.. graphviz::

   digraph {
     rankdir = LR;
     node [shape=box, style=rounded];
     src [label="OME-Zarr image\nz, y, x (mm)\n25 µm voxels"];
     fs  [label="field space\nz, y, x (mm)\nfield: vector, z, y, x"];
     wf  [label="field space\n(warped)"];
     out [label="layer\nz, y, x (mm)"];
     src -> fs [label="source placement"];
     fs -> wf  [label="W", style=dashed];
     wf -> out [label="transform\n(default: identity)", penwidth=2.5];
   }

.. code-block:: json

   {
     "url": "zarr3://https://host/template.ome.zarr/",
     "transformSource": "https://host/scene.zarr/coordinateTransformations/forward/"
   }

The field's dimensions are matched to the source's by name, as described in
case 4.

A field given alone has these options:

- ``vectorDimension``: the field dimension that holds the vectors;
- ``vectorDimensions``: the field dimensions they displace;
- ``vectorFrame``: ``"LPS"`` or ``"RAS"``, for NIfTI fields;
- ``vectorUnit``: the unit of the vectors;
- ``fieldTransform``: places the field. This is JSON only.

When a warpfield group belongs to an OME-Zarr scene, a field of the inverse
transformation found in the scene is used to move points (mesh and skeleton
vertices, annotations) directly. Without one, they are found by solving on the
field.

.. _transform-source-prepend:

7. Prepending the transform
---------------------------

With **Prepend the transform** checked in the Source tab, or
``"prependTransform": true`` in JSON, the affine transform is applied
**before** the transform source, to the source's own coordinates. It then:

- starts as the source's own placement;
- moves the source under the transformation, which stays fixed;
- has the transform source's ``post`` applied after it, unchanged.

Use this when the transformation is fixed but the source must first be
brought into the transformation's input space. A common case is a
displacement field alone that needs a source placed, re-oriented or rescaled
into the field's space first: for example, an atlas annotation in PIR voxel
order warped into a template's RAS millimetre space.

.. graphviz::

   digraph {
     rankdir = LR;
     node [shape=box, style=rounded];
     src [label="precomputed annotation\nx, y, z\n10 µm voxels (PIR)"];
     inp [label="field space\nz, y, x (mm, RAS)"];
     wf  [label="field space\n(warped)"];
     out [label="layer\nz, y, x (mm, RAS)"];
     src -> inp [label="transform (prepended)\n(default: source placement;\nhere reoriented to RAS mm)", penwidth=2.5];
     inp -> wf  [label="W", style=dashed];
     wf  -> out [label="post (fixed;\nidentity for a field alone)"];
   }

.. code-block:: json

   {
     "url": "precomputed://https://host/annotation",
     "transform": {
       "outputDimensions": {"z": [0.001, "m"], "y": [0.001, "m"], "x": [0.001, "m"]},
       "matrix": [[0, -1, 0, 5.225], [0, 0, -1, 5.355], [1, 0, 0, -5.7]]
     },
     "transformSource": "https://host/scene.zarr/coordinateTransformations/inverse/",
     "prependTransform": true
   }

Changing **Prepend** resets the affine transform, because its meaning
changes. With a transformation that has a field, the source is reloaded each
time a prepended transform changes, since the warped chunks depend on the
source's placement.

8. Choosing and inverting a transformation
------------------------------------------

A scene may hold several transformations. ``"name"`` chooses one: either its
``"name"``, or ``"<input> -> <output>"`` for one without a name. When there
are several and none is chosen, the error lists them.

A transformation is applied from its input system to its output system.
``"inverse": true`` applies it from its output system to its input system
instead. For example, a bijection between two templates can bring data from
either template into the other.

.. graphviz::

   digraph {
     rankdir = LR;
     node [shape=box, style=rounded];
     a [label="&quot;STPT template&quot;\nz, y, x (mm)"];
     b [label="&quot;SPIM template&quot;\nz, y, x (mm)"];
     a -> b [label="bijection: forward\n(drawn with its inverse field)"];
     b -> a [label="&quot;inverse&quot;: true\n(drawn with its forward field)"];
   }

.. code-block:: json

   {
     "url": "zarr3://https://host/spim_template.ome.zarr/",
     "transformSource": {
       "url": "https://host/spim_stpt.zarr/",
       "name": "STPT template 2020, mm RAS -> SPIM template LCA 2024-05, mm RAS",
       "inverse": true
     }
   }

Here the SPIM template, in the scene's output system, is brought into the
STPT template's space. Since the transformation is inverted, its forward field
is the one used to draw.

Coordinate systems and axes
---------------------------

A transformation refers to its coordinate systems in one of two ways:

- by name, among the ``coordinateSystems`` of the same metadata;
- by the ``path`` of an OME-Zarr image relative to the scene. This means the
  image's intrinsic system, or the system it names.

Both systems must have the same number of axes. Coordinates are in each
system's own units, and a displacement field's coordinates are in the units
of its own coordinate system.

Supported transformations
-------------------------

- **Linear**: ``identity``, ``scale``, ``translation``, ``affine``,
  ``rotation``, ``mapAxis``, and ``sequence``, ``inverseOf`` and
  ``bijection`` of these.
- **Displacement fields**: one ``displacements`` per transformation, with
  ``"linear"`` interpolation. It must be in the output-to-source direction
  described above. The field must be a warpfield OME-Zarr multiscale. A field
  given alone (case 6) may also be any volume.
- **Not supported**: ``coordinates`` and ``byDimension`` transformations, and
  more than one displacement field.

.. _transform-source-points:

Meshes, skeletons and annotations
---------------------------------

A volume is drawn by pulling each output point back through the field. Meshes,
skeletons and annotations are stored as points instead, so each point ``v`` is
moved to the point ``p`` of the output with ``p + u(p) = v``: the inverse of
the volume's warp, so that they stay on the warped image.

- **Meshes**: multiscale meshes are warped at their finest level of detail;
  single-resolution meshes as they are. Vertices move; the normals are kept.
- **Skeletons**: vertices move; edges and vertex attributes are kept.
- **Annotations** (precomputed annotation sources, 3-d): points, line and
  polyline vertices, and ellipsoid centres move exactly. A bounding box becomes
  the axis-aligned box around its 8 moved corners. Ellipsoid radii follow only
  the linear part. Properties, relationships (segment filtering) and selection
  by id work as on the unwarped source. The source is read-only.
- **Not warped**: local (editable) annotations. They are left out of the
  warped source.

All of these need a field that displaces exactly the 3 spatial dimensions of
the source.

The spatial index of an annotation source keeps the source's grid, placed by
the linear part of the transformation and extended to where the source's
bounding box lands. Each warped cell holds the annotations of the source's
cells at the same level that it overlaps, keeping those whose moved geometry
intersects it, so cross-sections show annotations where they land.

The source tab
--------------

The **transform** row sits just above the affine transform, in the Source
tab. Entering a URL and pressing Enter, or leaving the field, loads the
transform source; an empty value removes it. A new transform source resets
the affine transform to the new ``post`` (a prepended transform is kept).

When the source's own metadata supplies the transformation (case 3), the row
shows its field's URL, marked "(from the source's metadata)". **Prepend the
transform** appears whenever a transform source applies.
