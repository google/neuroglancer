Rendering
=========

Neuroglancer offers optional rendering effects for the perspective (3-D) view.

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

Use the :kbd:`q` key to toggle SSAO on and off. The settings panel has four
controls for SSAO:

- **Enable SSAO (shadows)**: the :kbd:`q` toggle.
- **SSAO intensity**: a slider; higher values give darker shadow effects.
- **SSAO radius**: a slider; higher values give broader, softer shadows.
- **SSAO depth cue**: a slider; ``0`` gives the standard ambient-occlusion
  result, while higher values darken concavities more strongly to give a clearer
  sense of depth.

SSAO applies only to mesh surfaces (segmentation layers with object surface
meshes, and single-mesh layers). It does not apply to other opaque geometry like
skeletons and annotations. Translucent meshes receive no shading of their own,
but a translucent mesh in front of an opaque mesh shows the opaque mesh's
shading through it. SSAO is disabled in any perspective view that contains a
volume-rendering layer.

When SSAO is on, the axis lines are drawn on top of all meshes rather than
hidden behind them.
