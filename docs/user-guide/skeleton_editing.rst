Skeleton Editing
================

Neuroglancer supports interactive editing of skeleton annotations, including
adding, moving, and deleting nodes, as well as merging and splitting skeletons.

.. _skeleton-editing-sources:

Supported Sources
-----------------

Skeleton editing is currently only supported on CATMAID data sources. See the
CATMAID documentation to set up a CATMAID server. At minimum you will need:

- A CATMAID project
- A linked project stack
- ``AnonymousUser`` permissions to read and edit the data on that project
- Skeletons initialised for that project

The project stack dimensions and resolution are used to inform the bounding box
of the data in neuroglancer as their product. Skeletons in CATMAID are in 1 nm
units.

The linked CATMAID stack must define spatial skeleton metadata. Neuroglancer
uses this metadata to build the spatially indexed skeleton source required for
editing. Add a ``spatial`` array to the stack metadata, with one entry for each
spatial index level:

.. code-block:: json

   {
     "spatial": [
       {
         "chunk_size": [11168145, 11168145, 11168145],
         "limit": 500
       },
       {
         "chunk_size": [3939000, 3939000, 3939000],
         "limit": 7000
       }
     ],
     "cache_provider": "cached_msgpack_grid",
     "read_only": false
   }

``chunk_size`` is specified in CATMAID project-space nanometers. ``limit`` is
the maximum node count expected for that spatial level and is required.
``cache_provider`` is optional and, when present, is passed to CATMAID node-list
requests. ``read_only`` is optional and disables editing when set to ``true``.

If ``spatial`` is absent or empty, Neuroglancer rejects the CATMAID datasource
because it cannot construct the spatially indexed skeleton source.

After setting this up, enter ``catmaid:<your-catmaid-server-url>/<your-catmaid-project-id>`` as a data source in neuroglancer.

.. _skeleton-editing-subsources:

Layer Subsources
----------------

The data source exposes two skeleton subsources. The first is a spatially indexed
skeleton source, which is required for editing. The second is the regular skeleton
subsource from the pre-existing pipeline for rendering precomputed format skeletons.

In the **Render** tab you can adjust:

- **Opacity (3d)** — controls the opacity of fully loaded, visible skeletons.
- **Hidden Opacity (3d)** — controls the opacity of hidden skeletons, which represent
  spatially indexed indicators of nodes in space.

When you make a skeleton visible, a full fetch is triggered and you are guaranteed
to see all nodes and details of that skeleton. Otherwise you see whatever is
provided by the spatial index level selected for the current view. The selected
grid size is controlled via the **Resolution (skeleton grid 2D)** and
**Resolution (skeleton grid 3D)** settings.

The **Seg** tab works as normal for a segmentation layer, allowing you to set the
visibility of segments/skeletons by their ID or by label if one has been assigned.

.. _skeleton-editing-tab:

Skeleton Tab
------------

The **Skeleton** tab is used for editing and viewing information about skeletons.
It is only available for CATMAID sources with an active spatially indexed skeleton
subsource, and only visible skeletons appear here. If the CATMAID stack metadata
sets ``read_only`` to ``true``, inspection remains available but edit actions are
disabled.

You can find a node by ID or by description, and filter nodes to show only:

- Leaves
- Virtual ends
- True ends
- Nodes with descriptions

You can also pick a subset of the visible skeletons to display information about in this menu.

Skeleton Navigation
~~~~~~~~~~~~~~~~~~~

The skeleton tab provides buttons for navigating through the skeleton tree:

- Go to the root
- Go to the start of the current branch
- Go to the end of the current branch
- Cycle through nodes at the current level
- Go to the parent or child of the current node (if there are multiple children,
  one is chosen at random)
- Go to the nearest node that is a leaf but not marked as a true end

You can also interact with nodes in the details viewer by right-clicking to move
to a node, or left-clicking to select it and move to it.

.. _skeleton-node-types:

Node Types
----------

Nodes use symbols to indicate their type:

- **Root** — the root node of the skeleton
- **Regular node** — an interior node along a branch
- **Branch point** — a node with more than one child
- **Virtual end** — a leaf node that has not been marked as a true end
- **True end** — a leaf node manually marked by a reviewer as the end of a branch

You can toggle a node between virtual end and true end by clicking its type icon
in the skeleton tab table. This only applies to visible segments.

.. _skeleton-node-properties:

Node Properties
---------------

To edit the detailed properties of a node, first make the segment visible, then
select the node by either:

- Right-clicking on it in the viewer while holding :kbd:`Control`
- Left-clicking on it in the skeleton tab table

Once a node is selected, you can:

- Delete the node *
- Change the node type *
- Make the node the root of the skeleton *
- Change the radius
- Change the confidence level
- Add or edit a free-text description

.. note::
   * These actions can also be performed from the skeleton tab table.

.. _skeleton-editing-tools:

Editing Tools
-------------

To make structural edits to nodes, you must bind at least some of the editing
tools available in the skeleton tab. The available tools are **Edit**, **Merge**,
and **Split**.

To bind a tool, click on it in the UI and hold down a key. To activate the tool,
press :kbd:`Shift` + the bound key. For example, if you bind :kbd:`E` to the Edit
tool, pressing :kbd:`Shift+E` activates it.

An important concept throughout editing is the *selected node*. The selected node
is highlighted with a border in the viewer, highlighted in the skeleton tab table,
and its details are shown in the selection details panel.

Edit Tool
~~~~~~~~~

With the Edit tool active:

- **Move a node** — select the node, then hold :kbd:`Alt` and left-click and drag
  it to the new location. This does not use picking to snap to nearby objects.
- **Add a child node** — select an existing node, then :kbd:`Control`-click where
  you want to place the new node. The new node is added as a child of the selected
  node.
- **Start a new skeleton** — :kbd:`Control`-click with no node selected to add a
  root node with no parent.

Merge Tool
~~~~~~~~~~

With the Merge tool active, select the "from" node first and then the "to" node. You must merge from a visible skeleton, but the "to" node may belong to a non-visible skeleton.
The surviving skeleton ID will be the ID of the skeleton containing the "from"
node. The only exception to this is if the CATMAID skeleton has annotations, and one of the skeletons is annotated as ``stable`` -- in this case, the surviving skeleton ID is from the one that was annotated as ``stable``. It is not currently possible to set these annotations within neuroglancer.

Split Tool
~~~~~~~~~~

With the Split tool active, select the node at which to split. The selected node
is included in the newly created skeleton, not the surviving original skeleton.
The edge between the selected node and its parent is deleted, and the selected
node becomes the root of the new skeleton. A split always produces exactly two
skeletons, regardless of whether the selected node is a branch point or a leaf.
You can only split visible skeletons.

.. _skeleton-editing-undo:

Undo and Redo
-------------

The skeleton tab provides **Undo** and **Redo** buttons. When any operation is
performed, its inverse is stored in the history. Note that the inverse of an
atomic operation is not necessarily atomic: for example, undoing a merge involves
a split followed by a reroot. Without the reroot step, the split skeleton could
end up with a different root than it had before the merge.

Undo does not restore the skeleton ID to its pre-operation value, so a merge
followed by an undo will result in one of the skeletons having a new ID compared
to before the merge (specifically, the skeleton that did not "survive" the
original merge).
