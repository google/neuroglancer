Segmentation Shaders
--------------------

Segmentation layers can use custom GLSL code to change how segments are colored.
The technical reference for the shader API is in
`the segmentation rendering guide <https://github.com/google/neuroglancer/blob/master/src/layer/segmentation/rendering.md>`_.
This page is a gentler introduction to the same ideas.

The Segment Color Function
~~~~~~~~~~~~~~~~~~~~~~~~~~

A segmentation shader defines a ``segmentColor`` function. The default shader
keeps Neuroglancer's existing segment color unchanged:

.. code-block:: text

  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    return color;
  }

The ``color`` argument is the color Neuroglancer would normally use for the
segment. It may come from the segment color hash, the layer's default segment
color, or an explicit color assigned to that segment. The ``isStated`` argument
is ``true`` when ``color`` came from an explicit segment color. The
``hasProperties`` argument is ``true`` when Neuroglancer found segment property
data for the current segment.

To make every visible segment red, return a red ``vec3``:

.. code-block:: text

  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    return vec3(1.0, 0.0, 0.0);
  }

If you want to preserve explicit per-segment colors but recolor everything
else, use ``isStated``:

.. code-block:: text

  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (isStated) {
      return color;
    }
    return vec3(0.0, 0.6, 1.0);
  }

Opacity
~~~~~~~

Use a ``vec4`` return type to set opacity. The alpha channel is the fourth
component. Returning a negative alpha leaves the layer opacity unchanged.

.. code-block:: text

  vec4 segmentColor(vec4 color, bool hasProperties, bool isStated) {
    if (isStated) {
      return color;
    }
    return vec4(color.rgb, 0.35);
  }

Segment Properties
~~~~~~~~~~~~~~~~~~

Segment properties can drive color choices. If a segment property map is
available, a shader can read tags and properties directly by name:

.. code-block:: text

  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (!hasProperties) {
      return vec3(0.5, 0.5, 0.5);
    }
    if (tag("axon")) {
      return vec3(1.0, 0.4, 0.0);
    }
    if (prop("size") > 100u) {
      return vec3(1.0, 1.0, 0.0);
    }
    return color;
  }

``tag("axon")`` returns ``true`` when the current segment has that tag.
``prop("size")`` reads a numerical property named ``size``. For string
properties, compare the value with a string literal:

.. code-block:: text

  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (!hasProperties) {
      return vec3(0.5, 0.5, 0.5);
    }
    if (prop("class") == "interneuron") {
      return vec3(0.0, 1.0, 0.6);
    }
    return color;
  }

Property Controls
~~~~~~~~~~~~~~~~~

A ``property`` UI control lets the user choose which segment property a shader
uses. The control can be filtered to tags, numerical properties, or string
properties.

.. code-block:: glsl

  #uicontrol property selectedTag(type="tag")
  #uicontrol property selectedSize(type="number")

  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (!hasProperties) {
      return vec3(0.5, 0.5, 0.5);
    }
    if (selectedTag) {
      return vec3(1.0, 0.0, 0.0);
    }
    if (selectedSize > 100u) {
      return vec3(1.0, 1.0, 0.0);
    }
    return color;
  }

Use ``type="string"`` for a string property picker. ``type="number"`` and
``type="numerical"`` both select numerical properties.

Data Mapping
~~~~~~~~~~~~

For continuous numerical properties, an ``invlerp`` control maps a property
range to ``0-1``. The user can adjust the selected property and range from the
shader UI.

.. code-block:: glsl

  #uicontrol float intensity invlerp(property="size", range=[0, 1000])

  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (!hasProperties) {
      return vec3(0.5, 0.5, 0.5);
    }
    return intensity() * vec3(1.0, 0.2, 0.0);
  }

If ``property`` is omitted, Neuroglancer selects the first available numerical
segment property as the default. ``range`` controls the data values mapped to
``0`` and ``1``. ``window`` can be added to control the range shown by the UI
widget.

Colormaps
~~~~~~~~~

The remapped value from an ``invlerp`` control can be passed to a colormap:

.. code-block:: glsl

  #uicontrol float intensity invlerp(property="size", range=[0, 1000])

  vec3 segmentColor(vec3 color, bool hasProperties, bool isStated) {
    if (!hasProperties) {
      return vec3(0.5, 0.5, 0.5);
    }
    if (isStated) {
      return color;
    }
    return colormapJet(intensity());
  }

This pattern is useful when a numerical segment property should control color
continuously while still respecting explicitly assigned segment colors.