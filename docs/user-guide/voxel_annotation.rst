.. _voxel-annotation:

Voxel Annotation
================

Voxel annotation allows for direct painting and editing of volumetric data
within Neuroglancer. This feature is available for both :ref:`image-layer` and
:ref:`segmentation-layer`.

Enabling Voxel Editing
----------------------

To enable voxel editing, you must first have a writable volume source.

1.  Open the **Source** tab of an Image or Segmentation layer.
2.  Locate a volume source and click the **Write** checkbox next to it.

.. note::
  Only one source can be writable at a time within a layer.

**Known limitations**:

- Only 3D volumes are supported (2D volumes are not).
- Float32 data type is not supported.
- Multi-resolution datasets must have a strict many-to-one hierarchy. See `About multi-resolution datasets`_ for more details.

The first time you attempt a drawing operation (like a brush stroke) after enabling writing, a confirmation dialog will appear. Note that this initial operation will be canceled; you can resume drawing once you have confirmed.

.. note::
  For the segmentation layer, it is recommended to deactivate the **Highlight on hover** option under the **Render** tab. When enabled, painted voxels become highlighted as the mouse moves over them, which can be visually distracting during annotation.

Supported Storage and Formats
-----------------------------

Voxel editing is currently supported for the following configurations:

**Storage**:

- Amazon S3 or any S3 compatible storage.

.. note::
  Write operations require that the S3 bucket's CORS policy allows ``PUT`` and ``DELETE`` methods. See :ref:`s3-kvstore` for a reference CORS policy.

**Data Format**:

- Zarr v2 and Zarr v3 (including OME-Zarr), with the following Compression/Encoding:
    - None (Raw)
    - Blosc
    - Gzip

Tools
-----

Voxel editing provides several tools for different annotation tasks. You can
bind these tools from the **Draw** tab to use/activate them.

.. _voxel-brush-tool:

Brush Tool
~~~~~~~~~~

The Brush tool allows you to paint voxels by clicking and dragging.

-   **Paint**: Hold :kbd:`Control` + :kbd:`Left Click` and drag.
-   **Erase**: Hold :kbd:`Control` + :kbd:`Shift` + :kbd:`Left Click` and drag.
-   **Quick Flood Fill**: Hold :kbd:`Control` + :kbd:`Right Click` to trigger a
    flood fill at the current position. Hold :kbd:`Shift` as well to erase.

Settings:
    -   **Brush size**: Adjust the radius of the brush.
    -   **Brush shape**: Choose between **Disk** and **Sphere** shapes.

.. _voxel-flood-fill-tool:

Flood Fill Tool
~~~~~~~~~~~~~~~

The Flood Fill tool fills a connected region of voxels on the current 2D plane.

-   **Fill**: Hold :kbd:`Control` + :kbd:`Left Click`.
-   **Clear**: Hold :kbd:`Control` + :kbd:`Shift` + :kbd:`Left Click`.

Settings:
    -   **Max fill voxels**: Limits the maximum number of voxels to fill to
        prevent accidental large-scale changes. If the limit is exceeded, the
        operation will be canceled.

.. note::
  The flood fill will automatically fill small gaps in the connected region, proportionally to the number of voxels in the region. This feature may sometimes leave unpainted voxels in tight corners of the region.

.. _voxel-seg-picker-tool:

Value Picker
~~~~~~~~~~~~

The Value Picker tool allows you to adopt the voxel value at the current mouse
position as your active Paint Value.

Common Controls
---------------

The **Draw** tab provides several common controls:

-   **Erase only selected value**: When enabled, the erase action only affects
    voxels that match the current **Paint Value**. This feature will slow down
    painting performance when erasing.
-   **Undo / Redo**: Revert or re-apply recent changes.
-   **Paint Value**: Manually specify the segment ID or intensity value to paint.
-   **New Random Value**: Generates a new random segment ID or intensity value.

Stamina System
--------------

When you perform many edits quickly, a stamina bar will appear below your cursor. This bar represents the amount of remaining work before all of your edits are processed and saved. **If you reload the page while the stamina bar is visible, you will lose some edits**. If the bar gets emptied painting will be halted until the system is able to catch up, this prevents neuroglancer from crashing due to too many edits in a short period of time.

About multi-resolution datasets
-------------------------------

Any multi-resolution dataset that has many-to-1 mapping (i.e. one child cannot have multiple parents) can be used for voxel annotation.

Although voxel annotation supports multi-resolution, any drawing operation will be performed on the highest resolution level, no matter what the current view is. Once an operation is completed, a downsampling pipeline will be triggered to update the lower resolution levels.

.. note::
  Because of the 3D nature of the datasets, the downsampling may cause visual artifacts: when zoomed out you may see annotations that then disappear when zoomed in, those "invisible" annotations will be found on nearby slices.
