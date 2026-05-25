Annotation Shaders
------------------
As with other elements of neuroglancer, one can write custom
GSL code to control the way annotations are rendered on the
screen.  Complete technical documentation about how to set control
different aspects of the annotations can be found here (TODO: ADD LINK).

This guide is a more gentle introduction to GSL that will
guide you through developing your first annotation shader code,
so that properties of annotations can adjust their visual appearence.

Many of the lessons applied here also are relevant to shader on image layers
or segmentation layers, but this will stay focused on annotation shaders.

Color
~~~~~
The first and most obvious thing to change about an annotation is it's
color. Colors can either be defined by red,green,blue (RGB) values, or
red,green,blue,alpha (RGBA) values, if you want annotations to be
transparent.  In GSL, RGB colors are defined by a ``vec3`` variable type
and RGBA colors are ``vec4``. Calling ``setColor`` with either a ``vec3``
or ``vec4``  will set the color.

You can see this in the default shader that comes with any new annotation
layer

.. code-block:: glsl

  void main() {
    setColor(defaultColor());
  }

Here, defaultColor() is a function which returns the ``vec3`` RGB color
that is ``Annotation color`` UI control that is just below the shader code.
Clicking on the UI control will bring up a RGB picker that will allow you
to change the color returned by defaultColor().

You can add more color pickers to the set of UI controls with a ``#uicontrol``
directive, optionally give it a default value, and pass it to set color.

.. code-block:: glsl

  #uicontrol vec3 mycolor color(default="red")
  void main() {
    setColor(mycolor());
  }

There are more ``#uicontrol``, such as a ``slider``. Let's add a ``slider`` to
control the red channel of a color.  To create a new ``vec3`` object,
we define it with a ``var`` decleration

.. code-block:: glsl

  #uicontrol float red slider(min=0.0, max=1.0, step=0.05, default=1.0)
  void main() {
    var mycolor vec3(slider, 0.0, 0.0)
    setColor(mycolor);
  }

Data mapping
~~~~~~~~~~~~

More powerfully, we might want to take some data from an annotation
property and use it to drive the red channel.  However to do so,
we often want to remap the values of that property to a ``0-1`` range.
Say our annotation has a property called ``temperature`` and it ranges
from 0 to 1000 across the annotations, but most annotations are
around 10-30.  The ``invlerp`` control **inverse linear interpolation**
will map help us to do that.

.. code-block:: glsl

  #uicontrol float red invlerp(range=[10,30], window=[0,1000])
  void main() {
    var mycolor vec3(red(), 0.0, 0.0)
    setColor(mycolor);
  }

Now in the UI you will see a widget appear that has a dropdown menu
to select which property you want to remap.  The ``range`` refers to what
the min and max values of the linear remapping regime are.  Things
larger than the max will map to 1, and lower than the range will
map to 0.  ``window`` refers to the what values the widget shows to you
to adjust the range within.  You can omit the ``window`` which will
default it to be the same as the ``range``, and you can omit the ``range``
and it will try to use the current distribution of the selected
property to pick a reasonable ``range``. Both can be adjusted by the
user via the widget's user interface.

These basic elements can be combined to create many kinds of coloring
behaviors. For example, let's say we want a single color colormap,
where the color goes from black to a user selectable color,
as an annotation property gets larger and smaller.

.. code-block:: glsl

  #uicontrol float intensity invlerp(range=[10,30], window=[0,1000])
  #uicontrol vec3 mycolor color(default="red")
  void main() {
    setColor(intensity()*mycolor);
  }

I can simply scale the ``mycolor`` ``vec3`` by my remapped intensity
inlerp control that will be between 0 and 1.  Users can now
change the colormap and set what 'bright' looks like.

What about discrete variables, like categories, where continous
changes don't make sense? We can setup a lookup table where
each of the discrete values maps to a specific color.

let's say we had a property called ``category`` which
was either 1,2 or 3.  Then we might color each of those
categories different user configurable colors like this

TODO: fix with array code

.. code-block:: glsl

  #uicontrol vec3 category1 color(default="red")
  #uicontrol vec3 category1 color(default="green")
  #uicontrol vec3 category1 color(default="blue")

  vec3 mymap(int value){
    switch(int):
    case 0:
      return category1;
    case 1:
      return category2;
    case 2:
      return category3;
  }

  void main() {
    setColor(mymap(prop_category()));
  }

Lines and Polylines have colors for their lines, points and endpoints.
``setLineColor`` can be called with 1 color, or with 2, if you want the
color to vary across the line. ``setEndPointMarkerColor`` similarly can
be called with 1 color to mark both ends the same, or 2 colors to
make the start and endpoint colors different. You can read more
about the details of these in the rendering guide (TODO: add link)

Size
~~~~
The next obvious thing to modulate beside color is the size of annotations.
Annotations have different things to size. Points have ``setPointMarkerSize``
which will dynamically scale annotations.  All the same things that we
learned about ``#uicontrol`` apply here. So if we wanted our point
annotations to scale between 1 pixels and 20 pixels based on a property,
we might use the inverlp control again.

.. code-block:: glsl

  #uicontrol float intensity invlerp(range=[10,30], window=[0,1000])
  void main() {
    setColor(defaultColor());
    setPointMarkerSize(1.0 + 19*intensity())
  }

We could control the maximum size with a slider to give the user even more
control.

.. code-block:: glsl

  #uicontrol float intensity invlerp(range=[10,30], window=[0,1000])
  #uicontrol float maxsize slider(min=1.0, max=50.0, step=1.0)
  void main() {
    setColor(defaultColor());
    setPointMarkerSize(1.0 + (maxsize-1.0)*intensity())
  }

using the 1.0+ and (maxsize-1.0) here means that our points never disappear,
no matter how small they are.


Discard
~~~~~~~
As the number of annotation points you want to render gets higher and higher
the performance of rendering will go down. The controls will start to feel
sluggish, and your page might crash if the GPU gets overwhelmed.

One was to address this, is to figure out how to use the data to render the
subset of points you are interested in.

.. code-block:: glsl

  void main() {
    if (prop_quality()<0.5){
      discard;
    }
    else{
      setColor(defaultColor());
    }
