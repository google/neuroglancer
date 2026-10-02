Skeleton Editing
================

Neuroglancer supports interactive editing of skeleton annotations, including
adding, inserting, moving, and deleting nodes, as well as merging and splitting
skeletons.

.. _skeleton-editing-sources:

Supported Sources
-----------------

Skeleton editing is currently only supported on CATMAID data sources. See the
CATMAID documentation to set up a CATMAID server. At minimum you will need:

- CATMAID ``2026.05.06.dev11+g...`` or later by git-describe semantics.
- A CATMAID project
- A linked project stack
- CATMAID read permissions for anonymous access or for the account associated
  with a personal API token
- CATMAID edit permissions for that account when editing is enabled
- Cross-origin access for the Neuroglancer origin and authorization headers
- Skeletons initialised for that project

The project stack dimensions and resolution are used to inform the bounding box
of the data in neuroglancer as their product. Skeletons in CATMAID are in 1 nm
units.

The linked CATMAID stack may define spatial skeleton metadata. When present,
Neuroglancer uses this metadata to build the spatially indexed skeleton source
required for editing. Add a ``spatial`` array to the stack metadata, with one
entry for each spatial index level:

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
the maximum node count expected for that spatial level and is required. A
``limit`` of ``0`` is allowed only on the finest spatial level and means that
level is complete/unlimited.
``cache_provider`` is optional and, when present, is passed to CATMAID node-list
requests. If ``read_only`` is not set to ``false``, Neuroglancer treats the
source as read-only: skeletons can be inspected, but edit actions are disabled.

If ``spatial`` is absent or empty, Neuroglancer derives a default chunk size
from the CATMAID project-space bounds and uses ``limit: 0`` for the generated
spatial level.

After setting this up, enter
``catmaid:<your-catmaid-server-url>/<your-catmaid-project-id>`` as a data
source in Neuroglancer. Public projects use CATMAID's anonymous API token.
Private projects prompt for a personal API token, which is retained for the
current browser tab. Python-hosted viewers can configure the token with
``neuroglancer.set_catmaid_token`` or ``CATMAID_CREDENTIALS``. See
:ref:`catmaid-datasource` for authentication and CORS details.

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
level is controlled via the **Spacing (cross section)** and
**Spacing (projection)** settings.

The **Seg** tab works as normal for a segmentation layer, allowing you to set the
visibility of segments/skeletons by their ID or by label if one has been assigned.

.. _skeleton-editing-tab:

Skeleton Tab
------------

The **Skeleton** tab is used for editing and viewing information about skeletons.
It is only available for CATMAID sources with an active spatially indexed skeleton
subsource, and only visible skeletons appear here. If the CATMAID stack metadata
does not set ``read_only`` to ``false``, inspection remains available but edit
actions are disabled.

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

Structural edits are made with the **Edit** tool in the skeleton tab. The
skeleton tab also provides a **Find Path** inspection tool for spatially indexed
skeletons. Unlike the Edit tool, **Find Path** is available for read-only
sources.

To bind a tool, click on it in the UI and hold down a key. To activate the tool,
press :kbd:`Shift` + the bound key. For example, if you bind :kbd:`E` to the Edit
tool, pressing :kbd:`Shift+E` activates it.

An important concept throughout editing is the *selected node*. The selected node
is highlighted with a border in the viewer, highlighted in the skeleton tab table,
and its details are shown in the selection details panel.

Find Path Tool
~~~~~~~~~~~~~~

Click **Find Path** in the skeleton tab, then left-click the source node followed
by the target node. You may also hold :kbd:`Shift` while selecting. Both
endpoints must be distinct, exact nodes in the same skeleton segment; points on
edges are not accepted. A third selection is ignored until an endpoint is
removed or the tool is cleared. The endpoint rows show each node's derived
topology type and coordinates; hover a row to see its node ID.

The route is computed automatically after the target is selected and displayed
as a white annotation polyline. **Find Path** uses complete skeleton data already
cached in the client and does not initiate a download. A cached skeleton can be
used even if it is no longer visible. If the skeleton is not cached, make it
visible and wait for the normal visibility pipeline to load it; the route is
computed automatically when loading completes. Click **Clear** to remove the
endpoints and route. Deleting the route annotation has the same effect as
**Clear**. If a generic skeleton contains cycles, **Find Path** selects a
deterministic route with the fewest edges.

While Find Path is active, use the middle mouse button to navigate. Control plus
left mouse provides the same trackpad-friendly navigation alternative as the
Edit tool.

The spatial skeleton tool supports one active spatial skeleton datasource per
segmentation layer. Switching Find Path to another datasource while the layer
is loaded is not supported. Find Path state is saved with its datasource.

Edit Tool
~~~~~~~~~

While the Edit tool is active, a plain left click never rotates or pans the
view. Navigate with the middle mouse button, or hold :kbd:`Control` (:kbd:`Cmd`
on macOS) with the left mouse button as a trackpad-friendly alternative. The
status bar lists the actions available in the current state.

- **Select a node** — left-click it.
- **Move a node** — left-click a node and drag it to the new location. This does
  not use picking to snap to nearby objects.
- **Add a child node** — select an existing node, then :kbd:`Shift`-click where
  you want to place the new node. The new node is added as a child of the
  selected node. A node marked as a true end cannot be given a child until the
  true end mark is cleared.
- **Show a skeleton** — double-click a node of a non-visible skeleton to make the
  skeleton visible.
- **Pin a node selection** — :kbd:`Control` + right-click a node.

The remaining edits are momentary modes. Hold the mode key, click in the viewer,
and release the key to return to normal editing. While a mode key is held the
cursor changes and the status bar describes what the next click does. A mode
stays active for as long as the key is held, so several edits of the same kind
can be made in one hold.

- **New skeleton** — hold :kbd:`N` and click in empty space to add a root node
  with no parent. One skeleton is created per key hold.
- **Delete a node** — hold :kbd:`D` and click the node to delete.
- **Merge skeletons** — hold :kbd:`M`; see :ref:`skeleton-editing-merge`.
- **Insert a node** — hold :kbd:`I`; see :ref:`skeleton-editing-insert`.
- **Split a skeleton** — hold :kbd:`S`; see :ref:`skeleton-editing-split`.

For CATMAID sources, adding child nodes is optimistic by default: the node is
previewed locally before CATMAID confirms it. If CATMAID rejects the request,
the preview is rolled back. Starting a new skeleton uses the normal
command-history path because CATMAID does not perform parent state checks for
that request. The **Source** tab includes a **Use CATMAID state checks** checkbox
below the source URL for the non-optimistic mode that sends CATMAID revision
state and waits for server confirmation. The **Skeleton** tab shows a compact
optimistic edit queue debug panel while optimistic mode is enabled or queued
actions are present.

.. _skeleton-editing-merge:

Merging Skeletons
~~~~~~~~~~~~~~~~~

Hold :kbd:`M` and click the "from" node first, then the "to" node. You must
merge from a visible skeleton, but the "to" node may belong to a non-visible
skeleton. Clicking a second node on the same skeleton as the "from" node moves
the "from" node there instead of merging.
The surviving skeleton ID will be the ID of the skeleton containing the "from"
node. The only exception to this is if the CATMAID skeleton has annotations, and one of the skeletons is annotated as ``stable`` -- in this case, the surviving skeleton ID is from the one that was annotated as ``stable``. It is not currently possible to set these annotations within neuroglancer.

.. _skeleton-editing-insert:

Inserting a Node
~~~~~~~~~~~~~~~~

Hold :kbd:`I` and click two directly connected nodes: one must be the parent of
the other. The order of the two clicks does not matter. A new node is inserted
at the midpoint of the edge between them; it becomes a child of the parent node
and the new parent of the child node.

Because a node can have only one parent, two nodes that are not directly
connected are rejected and nothing is changed. The first node you clicked stays
selected so you can pick one of its neighbours instead. Both nodes must belong
to a visible skeleton.

.. _skeleton-editing-split:

Splitting a Skeleton
~~~~~~~~~~~~~~~~~~~~

Hold :kbd:`S` and click the node at which to split. The selected node
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
