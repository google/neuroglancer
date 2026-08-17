Rendering
=========

Neuroglancer offers several rendering modes for displaying data in the
perspective (3-D) view.

Volume rendering
----------------

TODO

.. _ssao:

Screen-space ambient occlusion (SSAO)
-------------------------------------

SSAO simulates shadows on 3-D mesh surfaces by darkening crevices and
concavities where ambient light would be occluded. It adds depth cues that help
you perceive shapes, and makes the display more appealing.

.. image:: https://storage.googleapis.com/neuroglancer-doc-videos/0/user-guide/ssao/ssao-off.png
   :alt: A mesh rendered without SSAO.
   :width: 45%

.. image:: https://storage.googleapis.com/neuroglancer-doc-videos/0/user-guide/ssao/ssao-on.png
   :alt: The same mesh rendered with SSAO, showing shading in crevices.
   :width: 45%

Use the :kbd:`q` key to toggle SSAO on and off. The settings panel has three
controls for SSAO:

- **Enable SSAO (shadows)**: the :kbd:`q` toggle.
- **SSAO intensity**: a slider; higher values give darker shadow effects.
- **SSAO radius**: a slider; higher values give broader, softer shadows.

SSAO applies only to mesh surfaces (segmentation layers with object surface
meshes). It does not apply to other opaque geometry like skeletons and
annotations. SSAO is disabled in any perspective view that contains a
volume-rendering layer.
