Annotation Shaders
------------------
As with other elements of neuroglancer, one can write custom
GLSL code to control the way annotations are rendered on the
screen.  Technical documentation about how to set control
different aspects of the annotations  
`Can be found here <https://github.com/google/neuroglancer/blob/master/src/annotation/rendering.md>`_

.

This guide is a more gentle introduction to GLSL that will
guide you through developing your first annotation shader code,
so that properties of annotations can adjust their visual appearance.

Many of the lessons applied here also are relevant to shaders on image layers
or segmentation layers, but this will stay focused on annotation shaders.

Color
~~~~~
The first and most obvious thing to change about an annotation is its
color. Colors can either be defined by red, green, blue (RGB) values,
or red, green, blue, alpha (RGBA) values, if you want annotations to be
transparent.  In GLSL, RGB colors are defined by a ``vec3`` variable type
and RGBA colors are ``vec4``. Calling ``setColor`` with either a ``vec3``
or ``vec4`` will set the color.

You can see this in the default shader that comes with any new annotation
layer

.. code-block:: glsl

  void main() {
    setColor(defaultColor());
  }

Here, ``defaultColor()`` is a function which returns the ``vec3`` RGB color
that is the ``Annotation color`` UI control just below the shader code.
Clicking on the UI control will bring up an RGB picker that will allow you
to change the color returned by ``defaultColor()``.

You can add more color pickers to the set of UI controls with a ``#uicontrol``
directive, optionally give it a default value, and pass it to set color.

.. code-block:: glsl

  #uicontrol vec3 mycolor color(default="red")
  void main() {
    setColor(mycolor);
  }

There are more ``#uicontrol`` types, such as ``slider``. Let's add a ``slider`` to
control the red channel of a color.  To create a new ``vec3`` value,
we declare it with the type, name, and an initializer.

.. code-block:: glsl

  #uicontrol float red slider(min=0.0, max=1.0, step=0.05, default=1.0)
  void main() {
    vec3 mycolor = vec3(red, 0.0, 0.0);
    setColor(mycolor);
  }

Data mapping
~~~~~~~~~~~~

More powerfully, we might want to take some data from an annotation
property and use it to drive the red channel.  However to do so,
we often want to remap the values of that property to a ``0-1`` range.
Say our annotation has a property called ``temperature`` and it ranges
from 0 to 1000 across the annotations, but most annotations are
around 10-30.  The ``invlerp`` control (short for **inverse linear
interpolation**) will help us do that.

.. code-block:: glsl

  #uicontrol float red invlerp(range=[10,30], window=[0,1000])
  void main() {
    vec3 mycolor = vec3(red(), 0.0, 0.0);
    setColor(mycolor);
  }

Now in the UI you will see a widget appear that has a dropdown menu
to select which property you want to remap.  The ``range`` parameter
sets the min and max data values of the linear remap: values above the
max are clamped to 1, and values below the min are clamped to 0.
``window`` sets what range of values the widget shows you when adjusting
``range``.  You can omit ``window``, which defaults to the same interval
as ``range``, and you can omit ``range``, in which case neuroglancer
will pick a reasonable default from the current distribution of the
selected property.  Both can be adjusted from the widget at any time.

These basic elements can be combined to create many kinds of coloring
behaviors. For example, let's say we want a single-color colormap
that ramps from black to a user-selectable color as an annotation
property goes from low to high.

.. code-block:: glsl

  #uicontrol float intensity invlerp(range=[10,30], window=[0,1000])
  #uicontrol vec3 mycolor color(default="red")
  void main() {
    setColor(intensity()*mycolor);
  }

I can simply scale the ``mycolor`` ``vec3`` by my remapped intensity
invlerp control that will be between 0 and 1.  Users can now
change the colormap and set what 'bright' looks like.

What about discrete variables, like categories, where continuous
changes don't make sense? We can set up a lookup table that maps
each discrete code to a specific color. The natural way to express
this in GLSL is a constant array indexed by the code.

Let's say we had a categorical property called ``category`` whose
values are codes ``0``, ``1``, or ``2``. (Categorical / dictionary-encoded
annotation properties surface in the shader as a ``uint`` code — the index
into the property's ``categories`` array — so we use ``uint`` for the
lookup index.) Declare a ``const vec3`` array with one row per code,
index it by the code, and fall back to ``defaultColor()`` for
out-of-range values:

.. code-block:: glsl

  const vec3 categoryColors[3] = vec3[3](
    vec3(1.0, 0.0, 0.0),  // 0: red
    vec3(0.0, 1.0, 0.0),  // 1: green
    vec3(0.0, 0.0, 1.0)   // 2: blue
  );

  void main() {
    uint code = prop_category();
    vec3 rgb = (code < 3u) ? categoryColors[code] : defaultColor();
    setColor(rgb);
  }

A few things to notice:

- ``const vec3 array[N] = vec3[N](...)`` is the GLSL syntax for a
  compile-time-constant array. The size ``N`` appears in both the
  declaration and the constructor and must match.
- Array indices must be non-negative integers, so ``code`` is a ``uint``
  and the bounds check uses ``3u`` (a ``uint`` literal). Comparing
  ``uint`` to ``int`` is not allowed.
- The fallback to ``defaultColor()`` handles unexpected codes safely —
  without it, reading past the array end is undefined.
- This pattern scales naturally to dozens or hundreds of categories
  (e.g. cell-type taxonomies). Lining up the row comment with the
  corresponding entry in the property's on-disk ``categories`` array
  makes the mapping easy to audit.

Lines and Polylines have colors for their lines, points and endpoints.
``setLineColor`` can be called with 1 color, or with 2, if you want the
color to vary across the line. ``setEndPointMarkerColor`` similarly can
be called with 1 color to mark both ends the same, or 2 colors to
make the start and endpoint colors different. You can read more
about the details of these in the 
`rendering guide <https://github.com/google/neuroglancer/blob/master/src/annotation/rendering.md>`_


Size
~~~~
The next obvious thing to modulate beside color is the size of annotations.
Annotations have different things to size. Points have ``setPointMarkerSize``
which will dynamically scale annotations.  All the same things that we
learned about ``#uicontrol`` apply here. So if we wanted our point
annotations to scale between 1 and 20 pixels based on a property,
we might use the ``invlerp`` control again.

.. code-block:: glsl

  #uicontrol float intensity invlerp(range=[10,30], window=[0,1000])
  void main() {
    setColor(defaultColor());
    setPointMarkerSize(1.0 + 19.0*intensity());
  }

We could control the maximum size with a slider to give the user even more
control.

.. code-block:: glsl

  #uicontrol float intensity invlerp(range=[10,30], window=[0,1000])
  #uicontrol float maxsize slider(min=1.0, max=50.0, step=1.0)
  void main() {
    setColor(defaultColor());
    setPointMarkerSize(1.0 + (maxsize-1.0)*intensity());
  }

The ``1.0 +`` and ``(maxsize - 1.0)`` here mean that our points never
disappear, no matter how small the slider goes.


Toggles
~~~~~~~

To switch a visual feature on and off, use a ``checkbox`` uicontrol.

The name of the UI control will be available to the shader as a 
boolean binary variable.  We can use this to
toggle some aspect of our visualization on and off, such as making 
the bordrs of point annotations visible or invisible in the 
example below.

.. code-block:: glsl

  #uicontrol bool showBorders checkbox(default=true)

  void main() {
    setColor(defaultColor());
    setPointMarkerSize(8.0);
    if (showBorders) {
      setPointMarkerBorderColor(vec4(0.0, 0.0, 0.0, 1.0));
      setPointMarkerBorderWidth(1.0);
    }
    else {
      setPointMarkerBorderWidth(0.0);
    }
  }



Discard
~~~~~~~
As the number of annotation points you want to render gets higher and
higher, the performance of rendering will go down. The controls will
start to feel sluggish, and your page might crash if the GPU gets
overwhelmed.

One way to address this is to use the data itself to render only the
subset of points you are interested in. Inside ``main()``, the
``discard`` keyword drops the current annotation entirely — no
geometry is drawn for it.

.. code-block:: glsl

  void main() {
    if (prop_quality() < 0.5) {
      discard;
    } else {
      setColor(defaultColor());
    }
  }

To let the user adjust the cutoff interactively, drive it from a
slider:

.. code-block:: glsl

  #uicontrol float minQuality slider(min=0.0, max=1.0, step=0.01, default=0.5)
  void main() {
    if (prop_quality() < minQuality) discard;
    setColor(defaultColor());
  }

For a categorical property, compare against the code directly. To show
only annotations belonging to a single category, pair a ``uint``
slider with an equality check:

.. code-block:: glsl

  #uicontrol uint onlyCategory slider(min=0, max=2, default=0)
  void main() {
    if (prop_category() != onlyCategory) discard;
    setColor(defaultColor());
  }

Combine a ``checkbox`` with a discard to make a filter optional —
when the checkbox is off, all the annotations of a particular 
category are dropped.

.. code-block:: glsl

  #uicontrol bool hideCategoryTwo checkbox(default=false)
  void main() {
    if (hideCategoryTwo && prop_category() == 2u) discard;
    setColor(defaultColor());
  }

Multiple discards can be stacked — the annotation is dropped if
*any* condition matches:

.. code-block:: glsl

  #uicontrol float minQuality slider(min=0.0, max=1.0, default=0.5)
  void main() {
    if (prop_quality() < minQuality) discard;
    if (prop_category() == 2u) discard;
    setColor(defaultColor());
  }
