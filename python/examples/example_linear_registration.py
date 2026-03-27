#!/usr/bin/env python

"""Example of an interactive linear registration workflow using point annotations.

Requires scipy as an additional dependency in addition to the core neuroglancer python package.
python -m pip install scipy

General workflow:
    1. Start from a neuroglancer viewer with all the reference data and the data to register as layers. If the script is provided no data, it will create demo data for you to try.
    2. Pass this state to the script by either providing a url via --url or dumping the JSON state to a file and passing the file via --json. For example:
        python -i example_linear_registration.py --url 'https://neuroglancer.demo.appspot.com/...'
    3. The default assumption is that the last layer in the viewer from step 2 is the moving data to be registered, and all other layers are fixed (reference) data. The script will launch with two layer groups side by side, left is fixed, right is moving. You can move layers between the groups such that all fixed layers are in the first group (left panel) and all moving layers are in the second group (right panel). There must be at least two layers. Once you have done this, press 't' to continue.
    4. At this point, the viewer will:
        a. Create a copy of each dimension in with a "2" suffix for the moving layers. E.g. x -> x2, y -> y2, z -> z2. This allows the moving layers to have a different coordinate space.
        b. Create copies of the moving layers in the fixed panel with "_registered" suffixes. These layers will show the registered result.
        c. Create a shared annotation layer between the two panels for placing registration points. Each point will have 2 * N dimensions, where the first N dimensions correspond to the fixed data, and the second N dimensions correspond to the moving data.
    5. You can now place point annotations to inform the registration. The workflow is to:
        a. Move the center position in one of the panels to the desired location for the fixed or moving part of the point annotation.
        b. Place a point annotation with ctrl+left click in the other panel.
        c. This annotation will now have both fixed and moving coordinates, but be represented by a single point.
        d. The fixed and moving coordinates can be adjusted later by moving the annotation as normal (alt + left click the point). This will only move the point in the panel you are currently focused on, so to adjust both fixed and moving coordinates you need to switch panels.
    6. As you add points, the estimated affine transform will be updated and applied to the moving layers. The registered layers can be toggled visible/invisible by pressing 't'.
    7. If an issue happens, the viewer state can go out of sync. To help with this, the python console will regularly print that viewer states are syncing with a timestamp. If you do not see this message for a while, consider continuing the workflow again from a saved state.
    8. To continue from a saved state, dump the viewer state to a file using the 'd' key. Then pass this json in the --json command line argument to skip the initial setup steps and use existing annotations. If you renamed the annotation layer containing the registration points, you should also pass --annotations-name (or -a) with the new name. For example:
        python -i example_linear_registration.py --json saved_state.json -a registration_points

Known issues:
    1. Channel dimensions that are stored as c' get switched to c^ and then need to have
    their shaders updated. Once the update is done though they will stay as c^ so this
    is a one time setup.
    2. If the layer info fails to be parsed from Python the workflow can't launch past the setup step. This can be worked around by setting up the viewer in full as laid out above and the extra information required in the json file manually and then passing that in, but it does require some effort to do so. This essentially simulates dumping the state after setup in step 8 and then continuing from that state.
"""

import argparse
import json
import logging
import threading
import webbrowser
from copy import copy, deepcopy
from datetime import datetime
from enum import Enum
from pprint import pprint
from time import ctime, time

import neuroglancer
import neuroglancer.cli
import numpy as np
import scipy.ndimage

DEBUG = False  # Print debug info during execution
MESSAGE_DURATION = 4  # How long to show help messages in seconds
NUM_DEMO_DIMS = 3  # Only used if no data given, can be 2D or 3D
NUM_NEAREST_POINTS = 4  # Number of nearest points to use in local estimation
AFFINE_NUM_DECIMALS = 6  # Number of decimals to round affine matrix to

# We make a copy of all the physical dimensions, but to avoid
# expecting a copy of dimensions like t, or time, they are listed here
# channel dimensions are already handled separately and don't need to be listed here
NON_PHYSICAL_DIM_NAMES = ["t", "time"]

logging.basicConfig(level=logging.INFO, format="%(message)s")


def estimate_transform(
    fixed_points: np.ndarray, moving_points: np.ndarray, force_non_affine=False
):
    """
    Choose the appropriate model based on number of points and dimensions.

    Inspired by https://github.com/AllenInstitute/render-python/blob/master/renderapi/transform/leaf/affine_models.py
    That link contains 2D code, and so not everything here was used as an exact
    generalisation to ND, but many of the ideas and maths did translate.

    Parameters
    ----------
    fixed_points: np.ndarray
        The points to try and map the moving_points to.
    moving_points: np.ndarray
        The points apply the transformation on.
    force_non_affine: bool
        Force max of similarity transform.

    Returns
    -------
    np.ndarray
          The estimated affine transformation matrix.

    """
    assert fixed_points.shape == moving_points.shape
    N, D = fixed_points.shape  # N = number of points, D = number of dimensions

    if N == 1:
        return translation_fit(fixed_points, moving_points)
    elif N == 2:
        return rigid_or_similarity_fit(fixed_points, moving_points, rigid=True)
    elif N == 3 and D == 2:
        return affine_fit(fixed_points, moving_points)
    elif (N == 3 and D > 2) or force_non_affine:
        return rigid_or_similarity_fit(fixed_points, moving_points, rigid=False)
    return affine_fit(fixed_points, moving_points)


def translation_fit(fixed_points: np.ndarray, moving_points: np.ndarray):
    """Fit translation only between the points"""
    N, D = fixed_points.shape

    estimated_translation = np.mean(fixed_points - moving_points, axis=0)

    affine = np.zeros((D, D + 1))
    affine[:, :D] = np.eye(D)
    affine[:, -1] = estimated_translation

    affine = np.round(affine, decimals=AFFINE_NUM_DECIMALS)
    return affine


def rigid_or_similarity_fit(
    fixed_points: np.ndarray, moving_points: np.ndarray, rigid=True
):
    """Fit rigid or similar between the points using the Kabsch algorithm

    See https://en.wikipedia.org/wiki/Kabsch_algorithm
    https://en.wikipedia.org/wiki/Orthogonal_Procrustes_problem
    and https://math.nist.gov/~JBernal/kujustf.pdf

    If rigid is True, do not perform scaling.
    """

    # Find transform from Q to P in the below code
    N, D = fixed_points.shape
    mu_q = moving_points.mean(axis=0)
    mu_p = fixed_points.mean(axis=0)

    # Translate points so their origin is the centroid of the points
    Q = moving_points - mu_q
    P = fixed_points - mu_p

    # Find cross covariance matrix, D x D
    H = (P.T @ Q) / N

    # Compute SVD of covariance matrix
    U, Sigma, Vt = np.linalg.svd(H)

    # Record if the matrices contain a reflection
    d = np.ones(D)
    if np.linalg.det(U @ Vt) < 0:
        d[-1] = -1.0
    # Compute optimal rotation matrix to apply to Q
    R = U @ np.diag(d) @ Vt

    # Scale depending on rigid or similarity
    # Extended from 2D to 3D from https://github.com/AllenInstitute/render-python/blob/master/renderapi/transform/leaf/affine_models.py
    if rigid:
        s = 1.0
    else:
        var_x = (Q**2).sum() / N
        s = (Sigma * d).sum() / var_x

    # Compute optimal translation
    t = mu_p - s * (R @ mu_q)

    # Fill the D x (D + 1) matrix for neuroglancer
    T = np.zeros((D, D + 1))
    T[:D, :D] = s * R
    T[:, -1] = t

    affine = np.round(T, decimals=AFFINE_NUM_DECIMALS)
    return affine


def affine_fit(fixed_points: np.ndarray, moving_points: np.ndarray):
    # Find mapping from Q to P
    # Target values (P) is a D * N array
    # Input values (Q) is a D * N, (D * (D + 1)) array
    # Output estimation is a (D * (D + 1)) array
    N, D = fixed_points.shape

    # We essentially setup multiple copies of the moving points
    # so that solving Q * x = P solves multiplication by the affine
    # with linear least squares
    Q = np.zeros(((D * N), D * (D + 1)))
    for i in range(N):
        for j in range(D):
            start_index = j * D
            end_index = (j + 1) * D
            Q[D * i + j, start_index:end_index] = moving_points[i]
            Q[D * i + j, D * D + j] = 1
    P = fixed_points.flatten()

    # The estimated affine transform params will be flattened
    # and there will be D * (D + 1) of them
    tvec, res, rank, sd = np.linalg.lstsq(Q, P)

    if rank < D * (D + 1):
        # planar/degenerate -> fall back
        return rigid_or_similarity_fit(fixed_points, moving_points, rigid=False)

    # Put the flattened version back into the matrix
    affine = np.zeros((D, D + 1))
    for i in range(D):
        start_index = i * D
        end_index = start_index + D
        affine[i, :D] = tvec[start_index:end_index]
        affine[i, -1] = tvec[D * D + i]

    # Round to close decimals
    affine = np.round(affine, decimals=AFFINE_NUM_DECIMALS)
    return affine


def transform_points(affine: np.ndarray, points: np.ndarray):
    # Apply the affine transform to the points
    transformed = np.zeros_like(points)
    padded = np.pad(points, ((0, 0), (0, 1)), constant_values=1)
    for i in range(len(points)):
        transformed[i] = affine @ padded[i]
    return transformed


def debounce(wait: float):
    """Wrap function in debounce"""

    def decorator(fn):
        timer = None

        def debounced(*args, **kwargs):
            nonlocal timer

            if timer is not None:
                timer.cancel()

            timer = threading.Timer(wait, lambda: fn(*args, **kwargs))
            timer.start()

        return debounced

    return decorator


def _create_demo_data(size: int | tuple = 60, radius: float = 20):
    """Only used if no data is provided to the script"""
    data_size = (size,) * NUM_DEMO_DIMS if isinstance(size, int) else size
    data = np.zeros(data_size, dtype=np.uint8)
    if NUM_DEMO_DIMS == 2:
        yy, xx = np.indices(data.shape)
        center = np.array(data.shape) / 2
        circle_mask = (xx - center[1]) ** 2 + (yy - center[0]) ** 2 < radius**2
        data[circle_mask] = 255
        return data
    zz, yy, xx = np.indices(data.shape)
    center = np.array(data.shape) / 2
    sphere_mask = (xx - center[2]) ** 2 + (yy - center[1]) ** 2 + (
        zz - center[0]
    ) ** 2 < radius**2
    data[sphere_mask] = 255
    return data


def _create_demo_fixed_image():
    """Only used if no data is provided to the script"""
    return neuroglancer.ImageLayer(
        source=[
            neuroglancer.LayerDataSource(neuroglancer.LocalVolume(_create_demo_data()))
        ]
    )


def _create_demo_moving_image():
    """Only used if no data is provided to the script"""
    if NUM_DEMO_DIMS == 2:
        desired_output_matrix_homogenous = [
            [0.8, 0, 0],
            [0, 0.2, 0],
            [0, 0, 1],
        ]
    else:
        desired_output_matrix_homogenous = [
            [0.8, 0, 0, 0],
            [0, 0.2, 0, 0],
            [0, 0, 0.9, 0],
            [0, 0, 0, 1],
        ]
    inverse_matrix = np.linalg.inv(desired_output_matrix_homogenous)
    transformed = scipy.ndimage.affine_transform(
        _create_demo_data(),
        matrix=inverse_matrix,
    )
    print("Target demo affine, can be compared to estimated", inverse_matrix)
    return neuroglancer.ImageLayer(
        source=[neuroglancer.LayerDataSource(neuroglancer.LocalVolume(transformed))]
    )


def copy_coord_space(space: neuroglancer.CoordinateSpace, name_suffix):
    """Create a copy of a coord space and returns a space with new names"""

    def change_name(n):
        if n.endswith(("'", "^", "#")):
            return n
        return n + name_suffix

    return neuroglancer.CoordinateSpace(
        names=[change_name(n) for n in space.names],
        units=space.units,
        scales=space.scales,  # type: ignore
    )


def create_coord_space_matching_global_dims(
    viewer_dims: neuroglancer.CoordinateSpace, indices=None
):
    names = viewer_dims.names
    units = viewer_dims.units
    scales = viewer_dims.scales
    if indices is not None:
        return neuroglancer.CoordinateSpace(
            names=[names[i] for i in indices],
            units=[units[i] for i in indices],
            scales=np.array([scales[i] for i in indices]),
        )

    return neuroglancer.CoordinateSpace(names=names, units=units, scales=scales)


class PipelineState(Enum):
    """The pipeline goes through multiple states that alter behaviour."""

    NOT_READY = 0
    COORDS_READY = 1
    READY = 2
    ERROR = 3


class PointFilter(Enum):
    """How to filter annotation points."""

    NONE = 0
    NEAREST = 1


class LinearRegistrationWorkflow:
    def __init__(self, parsed_args):
        starting_ng_state = parsed_args.state
        self.annotations_name = parsed_args.annotations_name
        self.pipeline_state = PipelineState.NOT_READY
        self.unlink_scales = parsed_args.unlink_scales
        self.output_name = parsed_args.output_name

        self.stored_points = ([], [], False)
        self.stored_map_moving_name_to_data_coords = {}
        # currently unused, keeping to parallel the above map
        self.stored_map_moving_name_to_viewer_coords = {}
        self.affine = None
        self.viewer = neuroglancer.Viewer()
        self.viewer.shared_state.add_changed_callback(
            lambda: self.viewer.defer_callback(self.update)
        )  # handle custom functionality for this pipeline on general state changes

        self._last_updated_print_time = -1
        self._status_timers = {}
        self._current_moving_layer_idx = 0
        self._cached_moving_layer_names = []
        self._force_non_affine = False
        self._annotation_filter_method = PointFilter.NONE

        linear_reg_pipeline_info = None
        if starting_ng_state is None:
            self._add_demo_data_to_viewer()
        else:
            linear_reg_pipeline_info = starting_ng_state.to_json().get(
                "linear_reg_pipeline_info", None
            )
            self.viewer.set_state(starting_ng_state)

        self._setup_viewer_actions()
        self._show_help_message()

        if linear_reg_pipeline_info is not None:
            self._restore_coord_maps(linear_reg_pipeline_info)
            self.pipeline_state = PipelineState.READY

        if self.pipeline_state == PipelineState.NOT_READY:
            self.setup_initial_two_panel_layout()

    def update(self):
        """Primary update loop, called whenever the viewer state changes."""
        current_time = time()
        if current_time - self._last_updated_print_time > 5:
            print(f"Viewer states are successfully syncing at {ctime()}")
            self._last_updated_print_time = current_time
        if self.pipeline_state == PipelineState.COORDS_READY:
            self.setup_registration_point_layer()
        elif self.pipeline_state == PipelineState.ERROR:
            return
        elif self.pipeline_state == PipelineState.READY:
            self.update_affine()
        self._clear_status_messages()

    def _reset(self):
        self._cached_moving_layer_names = []
        self._current_moving_layer_idx = 0
        self.stored_map_moving_name_to_data_coords = {}
        self.stored_map_moving_name_to_viewer_coords = {}

    def setup_initial_two_panel_layout(self):
        """Set up a two panel layout if not already present."""
        with self.viewer.txn() as s:
            all_layer_names = [layer.name for layer in s.layers]
            if len(all_layer_names) >= 2:
                last_layer_name = all_layer_names[-1]
                group1_names = all_layer_names[:-1]
                group2_names = [last_layer_name]
            else:
                group1_names = all_layer_names
                group2_names = all_layer_names
            s.layout = neuroglancer.row_layout(
                [
                    neuroglancer.LayerGroupViewer(layers=group1_names, layout="xy-3d"),
                    neuroglancer.LayerGroupViewer(layers=group2_names, layout="xy-3d"),
                ]
            )
            s.layout.children[1].crossSectionOrientation.link = "unlinked"
            s.layout.children[1].projectionOrientation.link = "unlinked"

            if self.unlink_scales:
                s.layout.children[1].crossSectionScale.link = "unlinked"
                s.layout.children[1].projectionScale.link = "unlinked"

    def setup_viewer_after_user_ready(self):
        """Called when the user indicates they have placed layers in the two panels."""
        self._copy_moving_layers_to_left_panel()
        self.setup_second_coord_space()

    def setup_second_coord_space(self):
        """Set up the second coordinate space for the moving layers.

        The info for each layer is requested, then stored in a cache once ready.
        When each layer info is ready (or failed) proceeds to the final setup.
        """
        layer_name = self._cached_moving_layer_names[self._current_moving_layer_idx]
        info_future = self.viewer.volume_info(layer_name)
        info_future.add_done_callback(lambda f: self._update_coord_space_info_cache(f))

    def setup_registration_point_layer(self):
        """Establish information to store affine transform updates and place registration points."""
        with self.viewer.txn() as s:
            if (
                self.pipeline_state == PipelineState.ERROR
                or not self.has_two_coord_spaces(s)
            ):
                self._show_help_message()
                return

            # Make the annotation layer if needed
            if s.layers.index(self.annotations_name) == -1:
                s.layers[self.annotations_name] = neuroglancer.LocalAnnotationLayer(
                    dimensions=create_coord_space_matching_global_dims(s.dimensions)
                )
            # Also setup the new layer to clip differently on non display dims
            self._ignore_non_display_dims(s)

            s.layers[self.annotations_name].tool = "annotatePoint"
            s.selected_layer.layer = self.annotations_name
            s.selected_layer.visible = True
            s.layout.children[0].layers.append(self.annotations_name)
            s.layout.children[1].layers.append(self.annotations_name)
            self.setup_panel_display_dims(s)
            self.pipeline_state = PipelineState.READY
            self._show_help_message()

    def setup_panel_display_dims(self, s: neuroglancer.ViewerState):
        """Make the left and right panel show different display dimensions"""
        fixed_dims, moving_dims = self.get_fixed_and_moving_dims(s)
        s.layout.children[1].displayDimensions.link = "unlinked"
        s.layout.children[1].displayDimensions.value = moving_dims[:3]
        s.layout.children[0].displayDimensions.link = "unlinked"
        s.layout.children[0].displayDimensions.value = fixed_dims[:3]

    def _update_coord_space_info_cache(self, info_future):
        """Respond to a request about a moving layer's information.

        Caches the info to avoid future requests. When all moving
        layers info have been cached, marks the co-ordinate space
        as ready (or error on failure) and setups up the second
        coord space based on the available information about the moving
        layers.
        """
        self.moving_name = self._cached_moving_layer_names[
            self._current_moving_layer_idx
        ]
        try:
            result = info_future.result()
        except Exception as e:
            print(
                f"ERROR: Could not parse volume info for {self.moving_name}: {e} {info_future}"
            )
            print("Try matching the global dimensions to the moving dimension units.")
            self.pipeline_state = PipelineState.ERROR
            self._reset()
            self._show_help_message()
            # TODO allow recovery from this failure by allowing the user
            # to enter particular layer name co-ordinate spaces manually
        else:
            self.stored_map_moving_name_to_data_coords[self.moving_name] = (
                result.dimensions
            )

        self._current_moving_layer_idx += 1
        if self._current_moving_layer_idx < len(self._cached_moving_layer_names):
            self.setup_second_coord_space()
        else:
            # All of the layers info has been cached, can proceed to setup
            return self._create_second_coord_space()

    def _create_second_coord_space(self):
        if self.pipeline_state == PipelineState.ERROR:
            return self.pipeline_state
        self.pipeline_state = PipelineState.COORDS_READY
        with self.viewer.txn() as s:
            for layer_name in self._cached_moving_layer_names:
                output_dims = self.stored_map_moving_name_to_data_coords.get(
                    layer_name, None
                )
                if output_dims is None:
                    print(
                        f"ERROR: could not get output dims for a moving layer {layer_name}"
                    )
                    self.pipeline_state = PipelineState.ERROR
                    continue
                self.stored_map_moving_name_to_viewer_coords[layer_name] = []
                for source in s.layers[layer_name].source:
                    if source.transform is None:
                        output_dims = copy_coord_space(output_dims, "2")
                    else:
                        output_dims = copy_coord_space(
                            source.transform.output_dimensions, "2"
                        )
                    new_coord_space = neuroglancer.CoordinateSpaceTransform(
                        output_dimensions=output_dims,
                    )
                    self.stored_map_moving_name_to_viewer_coords[layer_name].append(
                        new_coord_space
                    )
                    source.transform = new_coord_space
        return self.pipeline_state

    def continue_workflow(self, _):
        """When the user presses to continue, respond according to the state."""
        if self.pipeline_state == PipelineState.NOT_READY:
            all_compatible = self._check_all_moving_layers_are_image_or_seg(
                self.get_state()
            )
            if not all_compatible:
                return
            self.setup_viewer_after_user_ready()
            return
        elif self.pipeline_state == PipelineState.ERROR:
            self.setup_viewer_after_user_ready()
        elif self.pipeline_state == PipelineState.COORDS_READY:
            return
        elif self.pipeline_state == PipelineState.READY:
            with self.viewer.txn() as s:
                for layer_name in self.get_moving_layer_names(s):
                    registered_name = layer_name + "_registered"
                    is_registered_visible = s.layers[registered_name].visible
                    s.layers[registered_name].visible = not is_registered_visible

    def _check_all_moving_layers_are_image_or_seg(self, s: neuroglancer.ViewerState):
        all_images = True
        for layer_name in self.get_moving_layer_names(s):
            layer = s.layers[layer_name]
            if not (layer.type == "image" or layer.type == "segmentation"):
                all_images = False
                break
        if not all_images:
            self._set_status_message(
                "error",
                "All moving layers must be image layers or seg layers for registration to work. Please correct this and try again.",
            )
            self._show_help_message()
        return all_images

    def _show_help_message(self):
        in_prog_message = "Place registration points by moving the centre position of one panel and then putting an annotation with ctrl+left click in the other panel. Annotations can be adjusted if needed with alt+left click. Press 't' to toggle visibility of the registered layer. Press 'f' to toggle forcing at most a similarity transform estimation. Press 'g' to toggle between a local affine estimation and a global one. Press 'd' to dump current state for later resumption. Press 'y' to show or hide this help message."
        setup_message = "Place fixed (reference) layers in the left hand panel, and moving layers (to be registered) in the right hand panel. Then press 't' once you have completed this setup. Press 'y' to show/hide this message."
        error_message = (
            f"There was an error in setup. Please try again. {setup_message}"
        )
        waiting_message = "Please wait while setup is completed. In case it seems to be stuck, try pressing 't' again."

        help_message = ""
        if self.pipeline_state == PipelineState.READY:
            help_message = in_prog_message
        elif self.pipeline_state == PipelineState.NOT_READY:
            help_message = setup_message
        elif self.pipeline_state == PipelineState.ERROR:
            help_message = error_message
        elif self.pipeline_state == PipelineState.COORDS_READY:
            help_message = waiting_message
        self._set_status_message("help", help_message)

    def toggle_help_message(self, _):
        help_shown = "help" in self._status_timers
        if help_shown:
            with self.viewer.config_state.txn() as cs:
                self._clear_status_message("help", cs)
        else:
            self._show_help_message()

    def toggle_force_non_affine(self, _):
        self._force_non_affine = not self._force_non_affine
        message = (
            "Estimating max of similarity transformation"
            if self._force_non_affine
            else "Estimating most appropriate transformation"
        )
        self._set_status_message("transform", message)
        self.update_affine()

    def toggle_global_estimate(self, _):
        if self._annotation_filter_method == PointFilter.NONE:
            self._annotation_filter_method = PointFilter.NEAREST
            self._set_status_message(
                "global",
                f"Using nearest {NUM_NEAREST_POINTS} points in transform estimation",
            )
        elif self._annotation_filter_method == PointFilter.NEAREST:
            self._annotation_filter_method = PointFilter.NONE
            self._set_status_message(
                "global", "Using all points in transform estimation"
            )
        self.update_affine()

    def _setup_viewer_actions(self):
        viewer = self.viewer
        continue_name = "continueLinearRegistrationWorkflow"
        viewer.actions.add(continue_name, self.continue_workflow)

        dump_name = "dumpCurrentState"
        viewer.actions.add(dump_name, self.dump_current_state)

        toggle_help_name = "toggleHelpMessage"
        viewer.actions.add(toggle_help_name, self.toggle_help_message)

        force_name = "forceNonAffine"
        viewer.actions.add(force_name, self.toggle_force_non_affine)

        global_name = "toggleGlobalEstimate"
        viewer.actions.add(global_name, self.toggle_global_estimate)

        with viewer.config_state.txn() as cs:
            cs.input_event_bindings.viewer["keyt"] = continue_name
            cs.input_event_bindings.viewer["keyd"] = dump_name
            cs.input_event_bindings.viewer["keyy"] = toggle_help_name
            cs.input_event_bindings.viewer["keyf"] = force_name
            cs.input_event_bindings.viewer["keyg"] = global_name

    def get_moving_layer_names(self, s: neuroglancer.ViewerState):
        """Get all layers in right panel that are not the registration point annotation"""
        right_panel_layers = [
            n for n in s.layout.children[1].layers if n != self.annotations_name
        ]
        return right_panel_layers

    def _copy_moving_layers_to_left_panel(self):
        """Make copies of the moving layers to show the registered result."""
        with self.viewer.txn() as s:
            self._cached_moving_layer_names = self.get_moving_layer_names(s)
            for layer_name in self._cached_moving_layer_names:
                copy = deepcopy(s.layers[layer_name])
                copy.name = layer_name + "_registered"
                copy.visible = False
                s.layers[copy.name] = copy
                s.layout.children[0].layers.append(copy.name)

    def _restore_coord_maps(self, reg_info):
        """Restore the coord space transforms from the stored maps.

        This is used when continuing from a saved state.
        """
        self._cached_moving_layer_names = self.get_moving_layer_names(self.get_state())
        self.stored_map_moving_name_to_data_coords = {
            k: neuroglancer.CoordinateSpace(json=v)
            for k, v in reg_info["layer_cache"].items()
        }
        self.stored_map_moving_name_to_viewer_coords = {
            k: [neuroglancer.CoordinateSpaceTransform(json_data=t) for t in v]
            for k, v in reg_info["viewer_layer_cache"].items()
        }

    def _handle_layer_names_changed(self, s: neuroglancer.ViewerState):
        current_names = set(self.get_moving_layer_names(s))
        cached_names = set(self.stored_map_moving_name_to_data_coords.keys())
        if current_names == cached_names:
            return
        # The common case is that a layer was renamed
        if len(current_names) == len(cached_names):
            for old_name in cached_names:
                if old_name not in current_names:
                    new_name = list(current_names - cached_names)[0]
                    self.stored_map_moving_name_to_data_coords[new_name] = (
                        self.stored_map_moving_name_to_data_coords.pop(old_name)
                    )
                    self.stored_map_moving_name_to_viewer_coords[new_name] = (
                        self.stored_map_moving_name_to_viewer_coords.pop(old_name)
                    )
                    break
        else:
            self._set_status_message(
                "error",
                "Layers have been added or removed, this may cause unexpected behaviour.",
            )

    def combine_affine_across_dims(self, s: neuroglancer.ViewerState, affine):
        """
        The affine matrix only applies to the moving dims
        but the annotation layer in the two coord space case
        applies to all dims so we need to create a larger matrix
        """
        all_dims = s.dimensions.names
        _, moving_dims = self.get_fixed_and_moving_dims(None, all_dims)
        full_matrix = np.zeros((len(all_dims), len(all_dims) + 1))

        for i, dim in enumerate(all_dims):
            for j, dim2 in enumerate(all_dims):
                if dim in moving_dims and dim2 in moving_dims:
                    moving_i = moving_dims.index(dim)
                    moving_j = moving_dims.index(dim2)
                    full_matrix[i, j] = affine[moving_i, moving_j]
                elif dim == dim2:
                    full_matrix[i, j] = 1
            if dim in moving_dims:
                moving_i = moving_dims.index(dim)
                full_matrix[i, -1] = affine[moving_i, -1]
        return full_matrix

    def combine_local_channels_with_transform(
        self, existing_transform: neuroglancer.CoordinateSpaceTransform, transform: list
    ):
        """The affine transform estimation does not account for local channel dimensions.
        But neuroglancer requires these dimensions to be included in the layer transform.
        This function inserts essentially padding in the correct locations in the matrix
        for local channels.
        """
        local_channel_indices = [
            i
            for i, name in enumerate(existing_transform.outputDimensions.names)
            if name.endswith(("'", "^", "#"))
        ]
        if not local_channel_indices:
            return transform
        final_transform = []
        num_local_count = 0
        for i, name in enumerate(existing_transform.outputDimensions.names):
            is_local = i in local_channel_indices
            if is_local:
                local_channel_row = [
                    0 for _ in range(len(existing_transform.outputDimensions.names) + 1)
                ]
                local_channel_row[i] = 1
                final_transform.append(local_channel_row)
                num_local_count += 1
            else:
                row = copy(transform[i - num_local_count])
                # At the indices corresponding to local channels, insert 0s
                for j in local_channel_indices:
                    row.insert(j, 0.0)
                final_transform.append(row)
        return final_transform

    def has_two_coord_spaces(self, s: neuroglancer.ViewerState):
        """Check if the two coord space setup is complete"""
        fixed_dims, moving_dims = self.get_fixed_and_moving_dims(s)
        return len(fixed_dims) == len(moving_dims)

    @debounce(1.5)
    def update_affine(self):
        """Estimate affine, with debouncing in case of rapid state updates"""
        with self.viewer.txn() as s:
            # Need to check if layer names changed first
            self._handle_layer_names_changed(s)
            updated = self.estimate_affine(s)
            if updated:
                num_point_pairs = len(self.stored_points[0])
                self.update_registered_layers(s)
                self._set_status_message(
                    "info",
                    f"Estimated affine transform with {num_point_pairs} point pairs",
                )
                if DEBUG:
                    pprint(self.get_registration_info(s))

    def get_fixed_and_moving_dims(
        self, s: neuroglancer.ViewerState | None, dim_names: list | tuple = ()
    ):
        """Extract the fixed and moving dim names from the state or list of names"""
        if s is None:
            dimensions = dim_names
        else:
            dimensions = s.dimensions.names
        # The moving dims are the same as the input dims, but end with an extra number
        # to indicate the second coord space
        # e.g. x -> x2, y -> y2, z -> z2
        moving_dims = []
        fixed_dims = []
        for dim in dimensions:
            if dim in NON_PHYSICAL_DIM_NAMES:
                continue
            if dim[:-1] in dimensions:
                moving_dims.append(dim)
            else:
                fixed_dims.append(dim)
        return fixed_dims, moving_dims

    def split_points_into_pairs(self, annotations, dim_names, current_position=None):
        """In the simple case, each point contains fixed dim coords then moving dim coords
        but in case that is the other way around, we handle that here.
        Right now we can't handle interleaved co-ordinate spaces."""
        if len(annotations) == 0:
            return np.zeros((0, 0)), np.zeros((0, 0)), None
        first_name = dim_names[0]
        fixed_dims, _ = self.get_fixed_and_moving_dims(None, dim_names)
        real_dims_last = first_name not in fixed_dims
        num_points = len(annotations)
        num_dims = len(annotations[0].point) // 2
        fixed_points = np.zeros((num_points, num_dims))
        moving_points = np.zeros((num_points, num_dims))
        for i, a in enumerate(annotations):
            for j in range(num_dims):
                fixed_index = j + num_dims if real_dims_last else j
                moving_index = j if real_dims_last else j + num_dims
                fixed_points[i, j] = a.point[fixed_index]
                moving_points[i, j] = a.point[moving_index]
        if current_position is not None:
            dim_add = num_dims if real_dims_last else 0
            fixed_position_indices = [i + dim_add for i in range(num_dims)]
            return (
                np.array(fixed_points),
                np.array(moving_points),
                current_position[fixed_position_indices],
            )
        return np.array(fixed_points), np.array(moving_points), current_position

    def update_registered_layers(self, s: neuroglancer.ViewerState):
        """When the affine updates, update the relevant transform in all layers
        which depend upon the affine.

        These are the moving layers, registered layers, and the point registration layer.
        Each moving layer has a corresponding registered layer and the transform
        is the same across both, but the coord space is different.
        """
        if self.affine is not None:
            transform = self.affine.tolist()
            for k, v in self.stored_map_moving_name_to_data_coords.items():
                for i, source in enumerate(s.layers[k].source):
                    fixed_to_moving_transform_with_locals = (
                        self.combine_local_channels_with_transform(
                            source.transform, transform
                        )
                    )
                    fixed_dims_to_moving_dims_transform = (
                        neuroglancer.CoordinateSpaceTransform(
                            input_dimensions=v,
                            output_dimensions=copy_coord_space(v, "2"),
                            matrix=fixed_to_moving_transform_with_locals,
                        )
                    )
                    source.transform = fixed_dims_to_moving_dims_transform

                    registered_source = s.layers[k + "_registered"].source[i]
                    fixed_dims_to_fixed_dims_transform = (
                        neuroglancer.CoordinateSpaceTransform(
                            input_dimensions=v,
                            output_dimensions=v,
                            matrix=fixed_to_moving_transform_with_locals,
                        )
                    )
                    registered_source.transform = fixed_dims_to_fixed_dims_transform
            annotation_transform = neuroglancer.CoordinateSpaceTransform(
                input_dimensions=create_coord_space_matching_global_dims(s.dimensions),
                output_dimensions=create_coord_space_matching_global_dims(s.dimensions),
                matrix=self.combine_affine_across_dims(s, self.affine).tolist(),
            )
            s.layers[self.annotations_name].source[0].transform = annotation_transform

            print(
                f"Updated affine transform (without channel dimensions): {transform}, written to {self.output_name}"
            )
            np.savetxt(self.output_name, self.affine, fmt="%.6f")

    def estimate_affine(self, s: neuroglancer.ViewerState):
        """Estimate the affine, return True if updated, False otherwise"""
        annotations = s.layers[self.annotations_name].annotations

        # If there are no annotations, either nothing happened yet
        # or the user deleted all the annotations and we need to reset
        if len(annotations) == 0:
            if len(self.stored_points[0]) > 0:
                _, moving_dims = self.get_fixed_and_moving_dims(s)
                n_dims = len(moving_dims)
                affine = np.zeros(shape=(n_dims, n_dims + 1))
                for i in range(n_dims):
                    affine[i][i] = 1
                self.affine = affine
                self.stored_points = ([], [], False)
                return True
            return False

        dim_names = s.dimensions.names
        fixed_points, moving_points, current_position = self.split_points_into_pairs(
            annotations, dim_names, s.position
        )
        fixed_points, moving_points = self._filter_annotations(
            fixed_points, moving_points, current_position
        )

        # Cached last points estimated with, if similar to current, don't estimate
        if (
            len(self.stored_points[0]) == len(fixed_points)
            and len(self.stored_points[1]) == len(moving_points)
            and self.stored_points[-1] == self._force_non_affine
        ):
            if np.all(np.isclose(self.stored_points[0], fixed_points)) and np.all(
                np.isclose(self.stored_points[1], moving_points)
            ):
                return False
        self.affine = estimate_transform(
            fixed_points, moving_points, self._force_non_affine
        )
        self.stored_points = [fixed_points, moving_points, self._force_non_affine]

        return True

    def _filter_annotations(
        self, fixed_points: np.ndarray, moving_points: np.ndarray, position
    ):
        """To allow local estimations e.g. from the nearest points"""
        if self._annotation_filter_method == PointFilter.NONE:
            return fixed_points, moving_points
        elif self._annotation_filter_method == PointFilter.NEAREST:
            # if less than desired points, return them all
            if len(fixed_points) <= NUM_NEAREST_POINTS:
                return fixed_points, moving_points
            # Find the X nearest fixed point indices
            diff = fixed_points - np.asarray(position)
            d2 = np.sum(diff * diff, axis=1)
            nearest_indices = np.argpartition(d2, NUM_NEAREST_POINTS - 1)[
                :NUM_NEAREST_POINTS
            ]
            return fixed_points[nearest_indices], moving_points[nearest_indices]
        return fixed_points, moving_points

    def get_registration_info(self, state: neuroglancer.ViewerState):
        """Return dict of fixed points, moving points, affine, and transformed points."""
        info = {}
        annotations = state.layers[self.annotations_name].annotations
        dim_names = state.dimensions.names
        fixed_points, moving_points, _ = self.split_points_into_pairs(
            annotations, dim_names
        )
        info["annotations"] = annotations
        info["fixedPoints"] = fixed_points.tolist()
        info["movingPoints"] = moving_points.tolist()
        if self.affine is not None:
            transformed_points = transform_points(self.affine, moving_points)
            info["transformedPoints"] = transformed_points.tolist()
            info["affineTransform"] = self.affine.tolist()
        return info

    def dump_current_state(self, _):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"neuroglancer_state_{timestamp}.json"

        state = self.get_state()
        state_dict = state.to_json()

        try:
            info = self.get_registration_info(state)
            info.pop("annotations", None)  # annotations are already in the state dump
            info["layer_cache"] = {
                k: v.to_json()
                for k, v in self.stored_map_moving_name_to_data_coords.items()
            }
            info["viewer_layer_cache"] = {
                k: [t.to_json() for t in v]
                for k, v in self.stored_map_moving_name_to_viewer_coords.items()
            }
            info["timestamp"] = timestamp
            state_dict["linear_reg_pipeline_info"] = info
        except Exception:
            print("Error saving registration log")

        with open(filename, "w") as f:
            json.dump(state_dict, f, indent=4)

        self._set_status_message(
            "dump", f"State saved to {filename} and can be used to continue later."
        )
        return filename

    def get_state(self):
        with self.viewer.txn() as s:
            return s

    def __str__(self):
        return str(self.get_state())

    def _clear_status_messages(self):
        to_pop = []
        for k, v in self._status_timers.items():
            if k == "help":  # "help" is manually cleared
                continue
            if time() - v > MESSAGE_DURATION:
                to_pop.append(k)
        with self.viewer.config_state.txn() as cs:
            for k in to_pop:
                self._clear_status_message(k, cs)

    def _clear_status_message(self, key: str, config):
        config.status_messages.pop(key, None)
        return self._status_timers.pop(key, None)

    def _set_status_message(self, key: str, message: str):
        with self.viewer.config_state.txn() as cs:
            cs.status_messages[key] = message
        self._status_timers[key] = time()

    def _transform_points_with_affine(self, points: np.ndarray):
        if self.affine is not None:
            return transform_points(self.affine, points)

    def _add_demo_data_to_viewer(self):
        fixed_layer = _create_demo_fixed_image()
        moving_layer = _create_demo_moving_image()

        with self.viewer.txn() as s:
            s.layers["fixed"] = fixed_layer
            s.layers["moving"] = moving_layer

    def _ignore_non_display_dims(self, state: neuroglancer.ViewerState):
        """With two coord spaces, we need to set annotations not to clip on certain
        non-displayed dimensions"""
        dim_names = state.dimensions.names
        dim_map = {k: 0 for k in dim_names if k not in ["t", "time", "t1"]}
        state.layers[self.annotations_name].clip_dimensions_weight = dim_map


def add_mapping_args(ap: argparse.ArgumentParser):
    ap.add_argument(
        "--annotations-name",
        "-a",
        type=str,
        help="Name of the annotation layer (default is annotations). This is relevant when passing a --json file with saved state to continue from.",
        default="annotation",
        required=False,
    )
    ap.add_argument(
        "--unlink-scales",
        "-us",
        action="store_true",
        help="If set, the scales of the two panels will be unlinked when setting up the initial two panel layout.",
    )
    ap.add_argument(
        "--output-name",
        "-o",
        type=str,
        help="Output filename for the affine matrix (default is affine.txt)",
        default="affine.txt",
        required=False,
    )
    ap.add_argument(
        "--test",
        "-t",
        action="store_true",
        help="If set, run the tests and exit.",
    )


def handle_args():
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_state_arguments(ap, required=False)
    neuroglancer.cli.add_server_arguments(ap)
    add_mapping_args(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    return args


### Some testing code for transform fitting ###
class TestTransforms:
    def test_translation_fit(self):
        # Simple 2D translation, +4 in y, +1 in x
        fixed = np.array([[1, 4], [2, 5], [3, 6]])
        moving = np.array([[0, 0], [1, 1], [2, 2]])
        affine = translation_fit(fixed, moving)
        expected = np.array([[1, 0, 1], [0, 1, 4]])
        assert np.allclose(affine, expected)

    def test_rigid_fit_2d(self):
        # Simple 90 degree rotation
        fixed = np.array([[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]])
        moving = np.array([[0, 0], [0, 1], [-1, 0], [0, -1], [1, 0]])
        affine = rigid_or_similarity_fit(fixed, moving, rigid=True)
        expected = np.array([[0, 1, 0], [-1, 0, 0]])
        assert np.allclose(affine, expected)

    def test_rigid_fit_3d(self):
        # Simple 90-degree rotation around Z-axis
        fixed = np.array(
            [
                [0, 0, 0],
                [1, 0, 0],
                [0, 1, 0],
                [-1, 0, 0],
                [0, -1, 0],
                [0, 0, 1],
                [0, 0, -1],
            ]
        )
        moving = np.array(
            [
                [0, 0, 0],
                [0, 1, 0],
                [-1, 0, 0],
                [0, -1, 0],
                [1, 0, 0],
                [0, 0, 1],
                [0, 0, -1],
            ]
        )
        affine = rigid_or_similarity_fit(fixed, moving, rigid=True)
        expected = np.array([[0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 1, 0]])
        assert np.allclose(affine, expected)

    def test_2d_transform_fit(self):
        # Based on the idea of mapping the big and little dipper together
        # In reality any points would do here, but having a kind of known layout
        # helps visuallize the result if needed
        little = np.array(
            [
                [0.0, 0.0],
                [1.0, 0.2],
                [1.2, -0.8],
                [0.2, -1.0],
                [-0.5, -1.2],
                [-1.1, -1.6],
                [-1.8, -2.1],
            ],
            dtype=float,
        )

        s = 1.7
        R = np.array(
            [
                [0.866, -0.500],
                [0.354, 0.612],
            ]
        )
        t = np.array([3.2, 1.4])

        big_with_shear = (little @ R.T) * s + t

        similarity = rigid_or_similarity_fit(little, big_with_shear, rigid=False)

        # In this case there is a little bit of shear in the fit
        # so a simiarity transform won't be perfect, but should be close
        transformed_points = transform_points(similarity, big_with_shear)
        assert np.allclose(transformed_points, little, atol=0.3)

        # The affine fit should be very accurate
        affine = affine_fit(little, big_with_shear)
        transformed_points_affine = transform_points(affine, big_with_shear)
        assert np.allclose(transformed_points_affine, little, atol=1e-2)

        # If we change R to have determinant 1, the similarity fit should be very accurate too
        R_det1 = np.array(
            [
                [0.866, -0.500],
                [0.500, 0.866],
            ]
        )
        big = (little @ R_det1.T) * s + t
        similarity = rigid_or_similarity_fit(little, big, rigid=False)
        transformed_points_no_shear = transform_points(similarity, big)
        assert np.allclose(transformed_points_no_shear, little, atol=1e-2)

    def test_3d_transform_fit(self):
        little = np.array(
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.2, 0.1],
                [1.2, -0.8, 0.3],
                [0.2, -1.0, 0.2],
                [-0.5, -1.2, 0.0],
                [-1.1, -1.6, -0.2],
                [-1.8, -2.1, -0.4],
            ],
            dtype=float,
        )

        s = 1.7
        # Determinant is close to 1
        R = np.array(
            [
                [0.866, -0.500, 0.000],
                [0.354, 0.612, -0.707],
                [0.354, 0.612, 0.707],
            ]
        )
        t = np.array([3.2, 1.4, 2.0])

        big = (little @ R.T) * s + t

        affine = rigid_or_similarity_fit(little, big, rigid=False)
        transformed_points = transform_points(affine, big)
        assert np.allclose(transformed_points, little, atol=1e-2)

        # While the transform is really a similarity transform,
        # we can also try an affine fit here
        affine2 = affine_fit(little, big)
        transformed_points2 = transform_points(affine2, big)
        assert np.allclose(transformed_points2, little, atol=1e-2)

    def test_affine_fit_2d(self):
        fixed = np.array([[0, 0], [1, 0], [0, 1]])
        moving = np.array([[1, 1], [2, 1], [1, 2]])
        affine = affine_fit(fixed, moving)
        expected = np.array([[1, 0, -1], [0, 1, -1]])
        assert np.allclose(affine, expected)


if __name__ == "__main__":
    args = handle_args()

    if args.test:
        import pytest

        pytest.main([__file__])
        exit(0)

    demo = LinearRegistrationWorkflow(args)

    webbrowser.open_new(demo.viewer.get_viewer_url())
