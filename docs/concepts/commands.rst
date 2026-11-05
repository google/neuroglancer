.. _command:

Command
=======

A command is something a user can invoke by name: "Toggle Scale Bar",
"Screenshot", "Add Layer". Commands are named separately from the keys they are
bound to, so a command with no keyboard shortcut still shows up wherever
commands are listed.

.. _command-object:

Command
-------

Defined in ``src/ui/command.ts``.

A ``Command`` holds a stable ``id``, the ``label`` and optional ``description``
shown in the UI, and an ``invoke`` method that runs it. Bindings, ordering and
grouping live elsewhere.

Two implementations ship with the viewer:

- ``ActionCommand`` dispatches ``action:<id>`` at the invocation context's
  dispatch target, the same event the matching key binding sends, so existing
  ``registerActionListener`` handlers keep working.
- ``CallbackCommand`` runs a callback, for behaviour with no DOM action behind
  it. This is the usual choice for an application embedding the viewer.

``invoke`` takes a ``CommandContext`` rather than a bare target, which leaves
room to pass more context later (mouse position, originating layer) without
changing every implementation.

Each command has a ``changed`` signal covering everything a consumer might
redraw for, so a consumer subscribes once per command rather than once per
property. ``enabled`` is currently the only property that changes.

.. _command-registry:

Command registry
----------------

Defined in ``src/ui/command_registry.ts``.

The registry holds the commands a viewer knows about, and each viewer owns one.
Default viewer setup seeds it with the built-in set from
``src/ui/default_commands.ts``, and feature code registers its own commands
next to the feature they belong to:

.. code-block:: typescript

   this.registerDisposer(
     viewer.commandRegistry.register(
       new CallbackCommand("add-clip-plane", "Add Clip Plane", () =>
         this.addPlane(),
       ),
     ),
   );

``register`` returns a disposer, so commands can come and go with the feature
that owns them, a per-layer control for example. The registry re-dispatches its
``changed`` signal when a command is registered, unregistered, or reports a
change of its own.

The registry lists the commands it was told about, and there is no way to make
that list complete. A viewer embedded in another application, or driven from the
Python integration, can bind an action without ever registering a command for
it. Consumers read the registry first and fall back to the bindings for the
rest.

.. _command-catalog:

Command catalog
---------------

Defined in ``src/ui/command_catalog.ts``.

The catalog turns the registry plus the current viewer state into a flat,
ordered list of entries to present. It:

- enumerates the registry, skipping disabled commands;
- looks up the live key binding for each command's id and attaches it as a
  display-only ``shortcut``. A suggested binding stored on the command instead
  would drift from whatever is installed;
- adds an entry for each keyboard-bound action that has no registered command,
  labelled from its action id. This is what keeps actions contributed by an
  embedder or from Python visible;
- contributes the entries that cannot be declared ahead of time: the layer
  pickers (``Toggle Layer`` and friends, as sub-palette groups) and the tools
  currently available;
- orders, groups and filters.

Grouping commands into sections belongs here or further out. The palette and the
help panel would reasonably group the same commands in different ways, which is
why the registry carries no category of its own.

The catalog rebuilds itself, debounced to an animation frame, whenever the
registry, the layers or the tool bindings change.

.. _command-palette:

Command palette
---------------

Defined in ``src/ui/command_palette.ts``.

The palette owns the UI. It renders a catalog, lets the user search and step
into sub-palettes, and invokes the selected entry with a ``CommandContext``
whose dispatch target is whichever element had focus when the palette opened.

Update flow
-----------

.. code-block:: text

   register / unregister, command.changed
             │
             ▼
   CommandRegistry.changed ──▶ CommandCatalog rebuild ──▶ CommandCatalog.changed ──▶ CommandPalette re-render
                                        ▲
             layer / tool binding changes┘
