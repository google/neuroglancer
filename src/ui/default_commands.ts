/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file Declarations of the built-in viewer commands.
 *
 * Each entry names an existing DOM action (`id` === the `action:` id dispatched
 * by the default input-event bindings) and gives it an explicit, human-readable
 * label and help description, so that consumers no longer have to prettify an
 * action id and can show commands that happen to have no binding at all.
 *
 * Commands whose behaviour is per-entity or otherwise dynamic (layer toggles,
 * tool activation) are contributed by the catalog at enumeration time and are
 * intentionally *not* declared here.
 *
 * This is the built-in *seed* set. It exists only because these commands
 * correspond to DOM actions that predate the registry. Feature code should NOT
 * add entries here; instead register commands colocated with the feature, for
 * its own lifetime, e.g.
 *
 *     this.registerDisposer(
 *       viewer.commandRegistry.register(
 *         new CallbackCommand("add-clip-plane", "Add Clip Plane", () =>
 *           this.addPlane(),
 *         ),
 *       ),
 *     );
 *
 * `register` returns a disposer, so commands may come and go with the feature
 * (e.g. per-layer).
 */

import { ActionCommand, type CommandId } from "#src/ui/command.js";
import type { CommandRegistry } from "#src/ui/command_registry.js";
import { AXES_NAMES } from "#src/util/geom.js";

interface BuiltinCommand {
  readonly id: CommandId;
  readonly label: string;
  readonly description: string;
}

// Directional position nudges and relative rotations, one pair per axis (arrow
// keys / , . and r / e / shift+arrow keys in the data panels). The ids are
// derived from the same AXES_NAMES that RenderedDataPanel derives its action
// listeners from, so the two cannot drift apart.
function axisCommands(): BuiltinCommand[] {
  const commands: BuiltinCommand[] = [];
  for (const axis of AXES_NAMES) {
    const upper = axis.toUpperCase();
    commands.push(
      {
        id: `${axis}-`,
        label: `Move −${upper}`,
        description: `Move the view one step in the −${upper} direction.`,
      },
      {
        id: `${axis}+`,
        label: `Move +${upper}`,
        description: `Move the view one step in the +${upper} direction.`,
      },
      {
        id: `rotate-relative-${axis}-`,
        label: `Rotate −${upper}`,
        description: `Rotate the view a small amount about the ${upper} axis (negative direction).`,
      },
      {
        id: `rotate-relative-${axis}+`,
        label: `Rotate +${upper}`,
        description: `Rotate the view a small amount about the ${upper} axis (positive direction).`,
      },
    );
  }
  return commands;
}

const STATIC_COMMANDS: readonly BuiltinCommand[] = [
  // View toggles.
  {
    id: "toggle-show-slices",
    label: "Toggle Slices in 3D",
    description: "Show or hide the cross-section slices in the 3D view.",
  },
  {
    id: "toggle-scale-bar",
    label: "Toggle Scale Bar",
    description: "Show or hide the scale bar overlay.",
  },
  {
    id: "toggle-axis-lines",
    label: "Toggle Axis Lines",
    description: "Show or hide the axis line indicators.",
  },
  {
    id: "toggle-orthographic-projection",
    label: "Toggle Orthographic Projection",
    description:
      "Switch the 3D view between perspective and orthographic projection.",
  },
  {
    id: "toggle-default-annotations",
    label: "Toggle Bounding Box",
    description: "Show or hide the default bounding-box annotations.",
  },
  {
    id: "toggle-show-statistics",
    label: "Toggle Statistics",
    description: "Show or hide the rendering statistics panel.",
  },
  {
    id: "toggle-layout",
    label: "Toggle Layout",
    description: "Cycle the data panel layout.",
  },
  {
    id: "toggle-layout-alternative",
    label: "Toggle Alternative Layout",
    description: "Cycle the alternative data panel layout.",
  },
  {
    id: "help",
    label: "Show Help",
    description: "Open the keyboard and mouse bindings help panel.",
  },
  {
    id: "open-command-palette",
    label: "Open Command Palette",
    description: "Open the searchable list of commands.",
  },
  // Navigation.
  {
    id: "snap",
    label: "Snap to Axis",
    description:
      "Snap the view orientation to the nearest axis-aligned orientation.",
  },
  {
    id: "zoom-in",
    label: "Zoom In",
    description: "Zoom the view in.",
  },
  {
    id: "zoom-out",
    label: "Zoom Out",
    description: "Zoom the view out.",
  },
  {
    id: "depth-range-decrease",
    label: "Decrease Depth Range",
    description: "Decrease the visible depth range of the 3D projection.",
  },
  {
    id: "depth-range-increase",
    label: "Increase Depth Range",
    description: "Increase the visible depth range of the 3D projection.",
  },
  {
    id: "t-",
    label: "Previous Timestep",
    description: "Step backward one frame along the time axis.",
  },
  {
    id: "t+",
    label: "Next Timestep",
    description: "Step forward one frame along the time axis.",
  },
  // Layers / segmentation.
  {
    id: "add-layer",
    label: "Add Layer",
    description: "Add a new layer to the viewer.",
  },
  {
    id: "recolor",
    label: "Randomize Colors",
    description: "Assign a new random color seed to segmentation layers.",
  },
  {
    id: "clear-segments",
    label: "Clear Selected Segments",
    description: "Deselect all currently selected segments.",
  },
  // Annotation.
  {
    id: "finish-annotation",
    label: "Finish Annotation",
    description: "Complete the annotation currently being drawn.",
  },
  {
    id: "undo-annotation-step",
    label: "Undo Annotation Step",
    description: "Undo the last point added to the in-progress annotation.",
  },
  // Actions with no default key binding; before the registry the palette had to
  // special-case these to surface them at all.
  {
    id: "edit-json-state",
    label: "Edit JSON State",
    description: "Open an editor for the raw viewer JSON state.",
  },
  {
    id: "screenshot",
    label: "Screenshot",
    description: "Capture a screenshot of the current view.",
  },
  {
    id: "deactivate-active-tool",
    label: "Deactivate Active Tool",
    description: "Deactivate whichever tool is currently active.",
  },
];

/** The built-in commands, in the order they are registered. */
export function getDefaultCommands(): readonly BuiltinCommand[] {
  return [...STATIC_COMMANDS, ...axisCommands()];
}

/**
 * Registers the built-in commands into `registry`. Called once during default
 * viewer setup. The registry is owned (and disposed) by the viewer, so no
 * disposers are returned here, and the commands live for the viewer's lifetime.
 */
export function registerDefaultCommands(registry: CommandRegistry): void {
  for (const { id, label, description } of getDefaultCommands()) {
    registry.register(new ActionCommand(id, label, description));
  }
}
