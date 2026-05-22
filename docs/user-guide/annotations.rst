.. _annotation-layers:

Annotation Layers
=================

Annotation layers let you place geometric markers — points, lines, bounding
boxes, ellipsoids, and polylines — on top of any other data displayed in
the viewer. Local annotations are stored as part of the viewer state and can be
linked to segmentation layers so that each annotation records the IDs of
the segments it touches. Remote annotations can stream from data locations 
outside of neuroglancer, but this guide will focus on local annotations.

.. _creating-an-annotation-layer:

Creating a local annotation layer
---------------------------------

To create a new annotation layer:

1.  Click :si-icon:`material/mouse-left-click-outline` the :guilabel:`+` button at the right end of the layer bar at the
top of the viewer.

.. image:: ../images/annotation_plus.png
   :alt: The + button at the right end of the layer bar

2. In the layer type picker, choose :guilabel:`annotation` (abbreviated
``ann``).

shortcut: ctrl+click :si-icon:`material/mouse-left-click-outline` the '+' button to make a new annotation layer immediately.

3. A new, empty local annotation layer is added to the layer bar and its side
panel opens.


.. _annotations-tab:

The Annotations tab
-------------------

Selecting an annotation layer opens its side panel. Within the side panel,
select the :guilabel:`Annotations` tab. This tab contains:

.. image:: ../images/annotations_tab.png
   :alt: The Annotations tab in the side panel

- A row of tool buttons for placing new annotations (see
  :ref:`annotation-tools` below).
- A list of all annotations in the layer. 
:si-icon:`material/mouse-right-click-outline` an entry in this list 
selects that annotation and moves the view to its position.


the :guilabel: `Rendering tab` for controls related to how annotations are drawn, including:
- Controls for the annotation layer's color.

.. _annotation-tools:

Annotation tools
----------------

The :guilabel:`Annotations` tab provides one button per annotation type.
Click a tool button to activate that tool for the layer. With the tool
active, you place points by holding :kbd:`Ctrl` and :si-icon:`material/mouse-left-click-outline` left-clicking in
**either a 2-D cross-section view or the 3-D projection view** — both
work for every annotation tool. The point is placed at the location
under the mouse cursor in whichever view you click.

Each tool interprets your :kbd:`Ctrl` :si-icon:`material/mouse-left-click-outline` left-clicks as follows:

:guilabel:`Annotate point`
    A single :kbd:`Ctrl` :si-icon:`material/mouse-left-click-outline` left-click places a point at the cursor and
    finishes the annotation. Each subsequent click starts a new
    point annotation.

:guilabel:`Annotate line`
    - **First** :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline`: places the start endpoint of the line.
    - **Second** :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline`: places the end endpoint of the line and
      finishes the annotation.

:guilabel:`Annotate bounding box`
    - **First** :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline`: places one corner of the axis-aligned bounding
      box.
    - **Second** :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline`: places the opposite corner and finishes the
      annotation. The box is drawn axis-aligned in the annotation
      coordinate space between the two corner points.

:guilabel:`Annotate ellipsoid`
    - **First** :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline`: places the **center** of the axis-aligned
      ellipsoid.
    - **Second** :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline`: sets the ellipsoid's radii. The radius along
      each axis is taken from the absolute distance between the center
      and the second click along that axis, so clicking farther from
      the center produces a larger ellipsoid. The second click also
      finishes the annotation.

:guilabel:`Annotate polyline`
    - **First** :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline`: places the first vertex of the polyline.
    - **Each subsequent** :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline`: appends another vertex, extending the
      polyline by one segment.
    - **Finishing:** hit enter to end the
      polyline. See :ref:`working-with-polylines` for details and how
      to undo the last vertex.

All clicks use the same :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline` left-click binding regardless of
whether you are clicking in a 2-D or 3-D view.  Neuroglancer will 
use the same picking scheme that the right click tool uses when moving.

Note, you can stick right click to move around, or scroll through the
dataset to find the place where you want to annotate. 

.. _working-with-polylines:

Working with polylines
----------------------

.. image:: ../images/polyline.png
   :alt: The + button at the right end of the layer bar

The polyline tool builds up an annotation one point at a time. To finish
a polyline, hit :kbd:`Enter` or **click the last point a second time** — that is, place a
new point at the exact location of the previous one. Neuroglancer treats
two consecutive points at the same position as the end of the polyline.

To remove the most recently added point of an in-progress annotation
(useful if you misclicked a vertex of a polyline, line, box, or
ellipsoid), press :kbd:`Backspace`.

.. _selecting-annotations:

Selecting an annotation
-----------------------

To select an existing annotation:

- **In a data view (2-D or 3-D):** hover over the annotation and press
  :kbd:`Ctrl` + :si-icon:`material/mouse-right-click-outline` right-click. The annotation is selected and its details
  appear in the selection panel.
- **In the annotation list:** :si-icon:`material/mouse-left-click-outline` left-click an entry in the list inside
  the :guilabel:`Annotations` tab. The annotation is pinned in the
  selection panel and the view recenters on it.
- **Jump to an annotation without selecting it:** :si-icon:`material/mouse-right-click-outline` right-click an entry
  in the annotation list. The view moves directly to that annotation's
  location without changing the current pinned selection.

.. _deleting-annotations:

Deleting an annotation
----------------------

There are three ways to delete an annotation:

- **From a data view:** hover over the annotation and press
  :kbd:`Ctrl` + :kbd:`Alt` + :si-icon:`material/mouse-right-click-outline` right-click.
- **From the annotation list:** hover over the annotation's entry in
  the list and click the trash-can icon that appears.
- **From the selection panel:** select the annotation
  (:kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline` left-click) so its details open in the selection
  panel, then click the trash-can icon in the selection widget.


.. _moving-annotation-points:

Moving annotation points
------------------------

Individual points and vertices of existing annotations can be moved by
holding :kbd:`Alt` and :si-icon:`material/mouse-left-click-outline` left-click-dragging on the point. This works for
the endpoints of a line, the corners of a bounding box, the center and
radius handles of an ellipsoid, and any vertex of a polyline. 

If you do the same :kbd:`Alt` and :si-icon:`material/mouse-left-click-outline` left-click-dragging
on the lines of an annotation you will move the entire annotation instead of just a single point.
This is useful for repositioning an annotation without changing its shape.
Also, this works in 3d, but moves points in the plane parallel to the screen,
witout changing the points depth relative to the camera.  You may need to move a point
rotate 90 degrees, and then move the point again to get it close to what where you watn to be. 

If you the same :kbd:`Alt` and :si-icon:`material/mouse-left-click-outline` left-click-dragging in
the annotation list, you can reorder the annotations in the list. 

.. _reordering-annotations:

Reordering annotations in the list
----------------------------------

For local annotation layers, you can change the order of annotations in
the :guilabel:`Annotations` tab by holding :kbd:`Alt` and
:si-icon:`material/mouse-left-click-outline` left-click-dragging an
entry in the list to a new position. While dragging, a colored bar
indicates whether the dragged annotation will be placed **before** (top
edge) or **after** (bottom edge) the row under the cursor. Release the
mouse to commit the move, or press :kbd:`Escape` to cancel.

Reordering is restricted to annotations within the same local
annotation source and is persisted in the viewer JSON state.

.. _annotation-descriptions:

Adding a description to an annotation
-------------------------------------

Each annotation can carry a free-form text description.

1. Select the annotation (see :ref:`selecting-annotations`). Its details
   open in the selection panel on the right.
2. In the selection panel, locate the :guilabel:`Description` text area
   underneath the annotation's properties.
3. Type your description. The text is saved to the annotation when the
   text area loses focus (for example, when you click elsewhere or
   :kbd:`Tab` away).

The description is stored on the annotation itself and is persisted as
part of the viewer state.

.. _annotation-keyboard-shortcuts:

Keyboard and mouse shortcuts
----------------------------

The following default bindings apply when an annotation tool is active
on the selected layer:

.. list-table::
   :header-rows: 1
   :widths: 55 45

   * - Action
     - Binding
   * - Create annotation / place next point
     - :kbd:`Ctrl` + :si-icon:`material/mouse-left-click-outline` left-click
   * - Select annotation under cursor
     - :kbd:`Ctrl` + :si-icon:`material/mouse-right-click-outline` right-click
   * - Move an annotation point
     - :kbd:`Alt` + :si-icon:`material/mouse-left-click-outline` left-click-drag
   * - Reorder an annotation in the list (local annotations)
     - :kbd:`Alt` + :si-icon:`material/mouse-left-click-outline` left-click-drag on a list entry
   * - Delete an annotation
     - :kbd:`Ctrl` + :kbd:`Alt` + :si-icon:`material/mouse-right-click-outline` right-click
   * - Undo last annotation point (during multi-point placement)
     - :kbd:`Backspace`
   * - Finish polyline annotation
     - :kbd:`Enter` or place a new point at the same position as the previous one

.. _annotation-custom-hotkeys:

Custom hotkeys (advanced)
-------------------------

Mainline neuroglancer does **not** include built-in hotkeys for cycling
through annotations (for example, "next annotation" / "previous
annotation"). To get this behaviour, users must add custom bindings.

This is done by overriding ``inputEventBindings`` in the viewer JSON
state, which lets you map additional key combinations to existing
actions. See the JSON API documentation for the binding format and the
list of available actions.

Forks or downstream deployments of neuroglancer may bundle additional
default bindings for annotation navigation; the workflow above is
required only on mainline.

.. _linked-segmentations:

Linked segmentation layers
--------------------------

An annotation layer can be linked to one or more segmentation layers
through named **relationships**. The default relationship is named
``segments``. When an annotation is created on or near a segment in a
linked segmentation layer, the segment's ID is captured on the
annotation as a **related ID** for that relationship.

Linking a segmentation layer
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

In the annotation layer's side panel, the linked-segmentations widget
shows one row per relationship. Each row provides:

- A checkbox that controls whether annotations are filtered by this
  relationship's related IDs (see :ref:`filtering-by-segmentation`).
- The relationship name (for example, ``segments``).
- A layer selector for picking the segmentation layer this relationship
  is linked to.

Selecting a segmentation layer in this widget establishes the link.
After that, newly created annotations automatically pick up the IDs of
the segments under their points.

Related segments in the selection panel
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

When a single annotation is selected, the selection panel includes a
**Related Segments** section for each relationship. The section lists
the related IDs for that annotation and lets you:

- Toggle the visibility of each related segment in the linked
  segmentation layer.
- Copy segment IDs.
- Add or remove related IDs.

.. _filtering-by-segmentation:

Filtering annotations by segmentation
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

When the filter checkbox for a relationship is enabled, the annotation
layer displays only annotations whose related IDs for that relationship
are currently visible in the linked segmentation layer. This is useful
for showing only the annotations that belong to the segments you have
selected.

An additional :guilabel:`Ignore null related segment filter` checkbox
controls how annotations with no related IDs are treated while filtering
is active:

- When enabled, annotations with no related IDs are shown regardless of
  which segments are visible.
- When disabled, annotations with no related IDs are hidden whenever
  filtering by segmentation is on.
